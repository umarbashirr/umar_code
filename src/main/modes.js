'use strict';
// The seven modes the composer offers. The SDK knows four permission modes, so
// the other three are ours: they ride on the closest SDK mode and the rest is
// enforced in AgentSession#permission. The renderer keeps the same ids and the
// labels people see in ui/components/composer.jsx.

// What each mode asks the SDK for. Anything not listed here is not a mode.
const SDK_MODE = {
  plan: 'plan',                    // the SDK stops every write itself
  ask: 'default',
  debug: 'default',                // ask, plus a standing instruction on the turn
  auto: 'acceptEdits',             // edits pass, shell is filtered below
  acceptEdits: 'acceptEdits',
  always: 'default',               // nothing is waved through, not even a read
  bypass: 'bypassPermissions',
};

/* The same seven modes, said in codex's vocabulary. It splits the question in
   two where the SDK asks it once: `sandbox` is what a command may touch, and
   `approvalPolicy` is whether anyone gets asked first.

   Every mode but bypass asks on-request, even the permissive ones, because the
   answering happens here. decide() below is what waves a call through, exactly
   as it does for claude, and it cannot judge a command codex never mentioned.
   Handing codex a looser policy would spend the modes' whole meaning to save a
   round trip on the local socket. */
const CODEX_MODE = {
  plan: { sandbox: 'read-only', approvalPolicy: 'on-request' },
  ask: { sandbox: 'workspace-write', approvalPolicy: 'on-request' },
  debug: { sandbox: 'workspace-write', approvalPolicy: 'on-request' },
  auto: { sandbox: 'workspace-write', approvalPolicy: 'on-request' },
  acceptEdits: { sandbox: 'workspace-write', approvalPolicy: 'on-request' },
  // `untrusted` rather than `on-request`, which is the difference between codex
  // asking about everything and codex asking only about what its sandbox has
  // already stopped. Under on-request the first attempt ran unasked and only
  // the retry reached decideCodex, so the one mode whose whole promise is
  // "asks before every tool" was the one quietly not keeping it.
  always: { sandbox: 'workspace-write', approvalPolicy: 'untrusted' },
  bypass: { sandbox: 'danger-full-access', approvalPolicy: 'never' },
};

const isMode = (m) => Object.hasOwn(SDK_MODE, m);
const DEFAULT_MODE = 'ask';

// Tools that only read. Asking about these is noise in every mode but `always`.
const READ_ONLY = new Set(['Read', 'Glob', 'Grep', 'NotebookRead', 'TodoWrite', 'WebFetch', 'WebSearch']);

// Shell that can lose work, reach outside the project, or be seen by someone
// else. Auto mode runs everything else without asking and stops on these.
const RISKY = [
  [/(^|[\s;&|(])sudo\s/, 'runs as root'],
  [/(^|[\s;&|(])rm\s[^|;&]*-[a-z]*[rf]/, 'deletes recursively or by force'],
  [/(^|[\s;&|(])(shutdown|reboot|halt|mkfs\S*|fdisk)\b/, 'acts on the machine itself'],
  [/(^|[\s;&|(])dd\s[^|;&]*of=/, 'writes a raw device'],
  [/(^|[\s;&|(])(chown|chmod)\s[^|;&]*\s\//, 'changes permissions outside the project'],
  [/\bgit\s+(push|reset\s+--hard|clean\s+-[a-z]*f|filter-branch)/, 'publishes or rewrites git history'],
  [/\b(npm|pnpm|yarn|bun)\s+(publish|unpublish)/, 'publishes a package'],
  [/\b(npm|pnpm|yarn|bun)\s[^|;&]*\s(-g|--global)\b/, 'installs globally'],
  [/\b(curl|wget)\b[^|;&]*\|\s*(ba|z|fi)?sh/, 'pipes a download straight into a shell'],
  [/\bdocker\s+(system\s+prune|rm\b|rmi\b|volume\s+rm)/, 'removes containers, images or volumes'],
  [/\bkubectl\s+delete\b/, 'deletes cluster resources'],
  [/\bdrop\s+(table|database|schema)\b/i, 'drops a database object'],
  [/(^|[\s;&|(])>{1,2}\s*\/(dev|etc|usr|bin|boot|var)\//, 'writes outside the project'],
];

// The reason to stop, or null when the command reads as ordinary work.
function riskOf(command) {
  for (const [re, why] of RISKY) if (re.test(command)) return why;
  return null;
}

const ALLOW = { action: 'allow' };
const ask = (reason) => ({ action: 'ask', reason });

/**
 * Whether a tool call runs on its own or waits for the human.
 * The SDK has already had its say: in acceptEdits it never asks about a write,
 * in bypassPermissions it never asks at all, so most calls that reach here are
 * shell, MCP, or something the SDK could not place.
 */
function decide(mode, tool, input) {
  // The agent asking the human something is the one call no mode may answer on
  // their behalf. Full bypass is the exception the SDK makes for us: it never
  // calls canUseTool at all, so the question resolves unanswered.
  if (tool === 'AskUserQuestion') return ask();

  // The one mode where nothing is waved through, reads included.
  if (mode === 'always') return ask('this mode asks before every tool');

  // The preview browser is this app driving its own window. Asking about a
  // snapshot of a pane the human is already looking at helps nobody.
  if (tool.startsWith('mcp__preview__')) return ALLOW;
  if (READ_ONLY.has(tool)) return ALLOW;

  if (mode === 'bypass') return ALLOW;

  if (mode === 'auto' && tool === 'Bash') {
    const why = riskOf(String(input?.command || ''));
    return why ? ask(why) : ALLOW;
  }

  return ask();
}

/* The same decision for a codex turn. The SDK settles part of this before
   decide() is ever called: in acceptEdits it never asks about a write, in plan
   it refuses one itself. codex has no such layer, so every approval it sends
   arrives here raw, and without these two lines acceptEdits would stop on every
   file change and plan mode would lean on the sandbox alone to say no. */
function decideCodex(mode, tool, input) {
  if (mode === 'always') return decide(mode, tool, input);
  if (tool === 'Edit') {
    if (mode === 'plan') return ask('plan mode does not write files');
    if (mode === 'acceptEdits' || mode === 'auto') return ALLOW;
  }
  return decide(mode, tool, input);
}

// Debug mode has no permissions of its own. What it changes is what the agent
// does with the turn, so it goes in ahead of the next thing the human types and
// then gets out of the way.
const DEBUG_PREFACE = [
  '<debug-mode>',
  'Reproduce the failure before you change anything. Say what you ran and what came back.',
  'Name the cause, and the file and line it lives at, before proposing a fix.',
  'If you cannot reproduce it, say so and ask for what is missing instead of guessing.',
  '</debug-mode>',
].join('\n');

module.exports = {
  SDK_MODE, CODEX_MODE, DEFAULT_MODE, isMode, decide, decideCodex, riskOf, READ_ONLY, DEBUG_PREFACE,
};
