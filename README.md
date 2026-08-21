# preview-browser-for-agent

An agent, a terminal, and a browser the agent can drive, in one window.

Cursor puts an agent next to an editor. This puts one next to a shell and a live browser. The agent
reads your code, runs commands, loads the page, clicks through it, reads the console, and takes
screenshots it can actually see. You watch it happen, and you can grab the browser yourself at any
time.

```
┌──────────────┬───────────────┬──────────────┐
│ agent        │ terminal      │ preview      │
│              │               │              │
│ ▸ snapshot   │ $ npm run dev │  [ page ]    │
│ ▸ click e7   │ ready :3000   │              │
│ ▸ shot       │               │              │
│              │               │              │
│ [#go chip]   │               │              │
│ > fix the …  │               │              │
└──────────────┴───────────────┴──────────────┘
   ^⇧A            always there    ^⇧B
```

The preview pane starts hidden. It appears when you press `Ctrl+Shift+B`, when you run `pba go 3000`,
or when the agent navigates. Close it and the page keeps running at full size, so the agent can carry
on working on something you are not looking at.

The window draws its own frame. The menu and the window buttons share the top strip; below them sit
the folder you are working in and one row of tabs for the preview and every shell you have open, so
what is running is visible whether or not its pane is showing.

## Install

Download or build a package, then install it:

```sh
sudo dpkg -i pba-0.2.1-amd64.deb     # recommended: sets up the Chromium sandbox, installs `pba`
# or
chmod +x pba-0.2.1-x86_64.AppImage && ./pba-0.2.1-x86_64.AppImage
```

The deb is the sandboxed install. The AppImage runs with `--no-sandbox`, because Ubuntu 24.04 and
later block the unprivileged user namespaces Chromium would otherwise use.

The package installs to `/opt/preview-browser-for-agent`, and `productName` in package.json is
hyphenated to keep it that way. Chromium's setuid sandbox helper splits its own executable path on
spaces, so an install directory like `/opt/Preview Browser for Agent` makes the app abort at startup
with `failed to execvp: /opt/Preview`. The readable name lives in the desktop entry instead, so the
app still shows up as "Preview Browser for Agent" in the launcher.

To build them yourself:

```sh
npm install
npm run dist        # writes dist/*.deb and dist/*.AppImage
```

To run from source:

```sh
npm install
npm start           # npm run enable-sandbox once, to turn Chromium's sandbox back on
```

The agent uses your existing Claude Code login. If `claude` works in your terminal, the panel works.

## Opening a project

The deb puts `pba` on PATH, so a folder opens the way you would open one in an editor:

```sh
pba .                  # open this folder
pba ~/code/shop        # open that one
```

Each folder gets its own window, its own agent, and its own browser. Run `pba .` again on a folder
that is already open and the existing window comes forward instead of a second one appearing. The
window title carries the folder name so a taskbar full of them stays readable.

Every window advertises its bridge under `~/.preview-browser-for-agent/projects/`, keyed by folder,
so `pba go 3000` in a shell always reaches the window that owns that project rather than whichever
one happened to start last. It walks up from your working directory, so subfolders resolve too.

Running the AppImage instead of the deb? Point `PBA_APP` at it and `pba .` will use it:

```sh
export PBA_APP=~/Apps/pba-0.2.1-x86_64.AppImage
```

## The agent panel

Type what you want changed and press Enter. The agent has the usual file and shell tools plus the
browser, wired in already: no MCP config, no restart, no setup step.

- **Permission modes** in the header: ask, accept edits, plan, yolo. Read-only tools and browser tools
  never prompt; anything that writes or runs asks inline, and you can allow once, always, or deny.
- **Stop** interrupts mid-turn.
- **Earlier sessions** are behind the list button in the panel header. Sessions are read straight out
  of `~/.claude/projects/`, the same transcripts `claude --resume` uses, so a conversation you started
  in the terminal shows up in the panel and vice versa. Pick one and the thread replays, tool calls and
  screenshots included, with the session live again for the next thing you type.
- **Tool calls** collapse to one line each. Click one to see its input and result, including
  screenshots inline.

**Point instead of describing.** `Ctrl+Shift+E` arms the picker, you hover the preview, click an
element, and it becomes a chip on the composer carrying the selector, the size, and a screenshot of
just that element:

```
[preview element]
  css: #go
  element: button "Create account"
  ref: e4   size: 129x39 at 48,261
  screenshot: /tmp/pba-shots/pick-1787310022.png
```

Then you finish the sentence: "make this the same height as the input". The agent gets a selector and
a picture, not a vague description of the thing in the corner.

## Skills and MCP servers

The pill above the composer says how many of each this folder has. Click it to see them.

**Skills** are everything the agent can be told to do by name: the SKILL.md folders in `.claude/skills`
here and in `~/.claude`, the commands in `.claude/commands`, whatever your enabled plugins ship, and,
once a chat is running, the ones Claude Code ships with. Type `/` in the composer and the list filters
as you type. Enter drops the name in and leaves the caret after it for the argument.

Switching a skill off hides it from the agent in this folder and nothing else: the files stay where
they are and the `claude` CLI outside the app is unaffected. The off list rides along as a
`skillOverrides` settings layer when a chat starts, and is applied mid-chat if you change your mind
while one is running.

**MCP servers** are read from `.mcp.json` here, from `~/.claude.json` (both yours and this folder's),
and from the plugins you have on, so a server you added with `claude mcp add` is already in the list.
Once a chat is running each row carries its real state: connected with a tool count, failed with the
error, or waiting on a sign-in. Reconnect one, switch one off for this folder, or add one:

```
name      github
type      stdio, http or sse
command   npx -y @modelcontextprotocol/server-github     (or a URL, for http and sse)
scope     .mcp.json (shared with the repo), yours, or this folder
```

A new server is written to the config file its scope names and joins the chat that is already running,
so nothing has to be restarted. Servers a plugin brought with it are listed but not editable: they
belong to the plugin. The app's own browser tools appear in the same list as `preview`.

A server waiting on OAuth cannot be signed in to from inside a chat, because the Agent SDK has no
control request for it. Those rows get a **Sign in** button instead, which opens a shell here running
`claude mcp login <server>` — the CLI's own flow, saving the token the next chat reads.

**The connectors from your Claude account** are fetched and connected by the CLI itself, and they can
crowd out a local server offering the same thing: with the Figma connector on, the Figma plugin's own
MCP server is never loaded. The switch at the top of the list turns them off for this folder, and then
only the servers configured on this machine are used.

Both lists are read off disk, so they are drawn before any agent has started. Nothing here spawns the
Claude binary just to fill a menu.

## The terminal

A real PTY running your own shell, with your prompt, your aliases, your tmux. It is not a transcript
of the agent; it is yours.

Two things it does beyond being a terminal:

**Dev servers open themselves.** The output is watched for a local URL. When Vite or Django or
`next dev` prints one, a toast offers to load it in the preview. Say "always" once and it stops asking.

**`pba` is on PATH.** The app injects a loopback bridge URL and a token into every terminal it spawns,
so anything running there can drive the same browser the agent is using:

```sh
pba go 3000            # bare ports, hostnames and URLs all work
pba snapshot           # page outline with [ref=eN] handles
pba fill e3 "you@example.com"
pba click e7
pba console --level error
pba shot --full
pba preview close
```

`pba snapshot` is the entry point:

```
url: http://localhost:3000/
title: "Signup"
viewport: 795x860  scroll: 0/860

- heading "Signup" [ref=e1]
- textbox "Email address" [ref=e2]
- combobox "Plan" [ref=e3]
- button "Create account" [ref=e4]
- link "About this thing" [ref=e5] href="/about.html"
```

Every `eN` feeds `click`, `fill`, `hover`, `select` and `highlight`. Refs are dropped on navigation, so
snapshot again after a page load. `pba help` lists the rest.

## Using it from another agent

The panel is not the only way in. Any agent that speaks MCP can have the same 22 browser tools:

```sh
pba setup project      # writes ./.mcp.json
# or
claude mcp add pba -- node /path/to/preview-browser-for-agent/mcp/server.js
```

Screenshots come back as images, so the model sees the layout instead of a description of it.

## Keys

App shortcuts are all `Ctrl+Shift`, and the terminal never sees them. Plain `Ctrl+B`, `Ctrl+L` and the
rest go to your shell, so tmux keeps working.

| | |
|---|---|
| `Ctrl+Shift+A` | show or hide the agent |
| `Ctrl+\`` | show or hide the terminal panel |
| `Ctrl+Shift+S` | show or hide the session rail |
| `Shift+Tab` | plan mode on or off, from the prompt |
| `Ctrl+Shift+B` | show or hide the preview |
| `Ctrl+Shift+E` | pick an element |
| `Ctrl+Shift+T` | new terminal tab |
| `Ctrl+Shift+L` | focus the address bar |
| `Ctrl+Shift+J` | console and network drawer |
| `Ctrl+1…9` | switch terminal tab |

## How it fits together

```
  agent panel ──┐
  pba CLI ──────┼──▶ tool dispatch ──▶ WebContentsView (the preview)
  MCP server ───┘         │
                          └── bridge on 127.0.0.1, token in the terminal env
```

One tool definition, three ways in. The agent panel calls it in-process; the CLI and the MCP server go
through a loopback HTTP bridge whose token is injected into the terminals the app spawns. Nothing
outside those terminals can reach it without the token.

## Limits worth knowing

- One window, one preview pane, one agent session. Tools act on the focused window.
- Anything running in the app's terminal holds the bridge token. That is the point, but do not run it
  next to code you do not trust.
- A skill switched off is hidden from the agent's listing, not locked away. The files are still on
  disk and still readable with Read or Bash if you point the agent at them.
- Started from a desktop launcher, an app inherits a PATH with none of your own directories on it, so
  an MCP server configured as a bare command name would fail to start. The app asks your login shell
  for its PATH once at startup and hands that to the agent and to its servers.
- Cross-origin iframes appear in snapshots but their contents cannot be read.
- `screenshot --full` and viewport emulation go through CDP, and neither works while DevTools is open,
  since only one debugger can attach at a time.
- `homepage` in package.json is a placeholder. Set it to the real repository before publishing.
