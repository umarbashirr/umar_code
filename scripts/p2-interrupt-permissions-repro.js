'use strict';
// P2.4: Claude interrupt() must deny pending permission prompts the same way
// stop() does, and the renderer must not leave those cards clickable.
const path = require('path');
const fs = require('fs');
const ROOT = process.env.TANDEM_ROOT || path.join(__dirname, '..');

const failures = [];
const pass = (name) => console.log(`PASS ${name}`);
const fail = (name, detail) => { console.log(`FAIL ${name}: ${detail}`); failures.push(name); };

function plantPending(session, id) {
  const seen = [];
  session.pending.set(id, {
    resolve: (verdict) => { seen.push(verdict); },
    input: { command: 'rm -rf /' },
    tool: 'Bash',
  });
  return seen;
}

async function checkInterruptClearsPending() {
  let AgentSession;
  try {
    ({ AgentSession } = require(path.join(ROOT, 'src/main/agent.js')));
  } catch (e) {
    fail('load-agent', e.message);
    return;
  }
  pass('load-agent');

  const stopped = new AgentSession({ cwd: ROOT });
  const stopSeen = plantPending(stopped, 'ps');
  stopped.stop();
  if (stopped.pending.size === 0 && stopSeen[0]?.behavior === 'deny') {
    pass('stop-denies-pending');
  } else {
    fail('stop-denies-pending', `size=${stopped.pending.size} verdict=${JSON.stringify(stopSeen[0])}`);
  }

  const interrupted = new AgentSession({ cwd: ROOT });
  const interruptSeen = plantPending(interrupted, 'pi');
  await interrupted.interrupt();
  if (interrupted.pending.size === 0) pass('interrupt-empties-pending');
  else fail('interrupt-empties-pending', `pending size ${interrupted.pending.size} after interrupt`);

  if (interruptSeen[0]?.behavior === 'deny') pass('interrupt-denies-pending');
  else fail('interrupt-denies-pending', `verdict=${JSON.stringify(interruptSeen[0])}`);

  if (!interrupted.closed) pass('interrupt-does-not-close');
  else fail('interrupt-does-not-close', 'interrupt set closed, which is stop() territory');
}

async function checkDeniesBeforeSdkInterrupt() {
  const { AgentSession } = require(path.join(ROOT, 'src/main/agent.js'));
  const session = new AgentSession({ cwd: ROOT });
  const seen = plantPending(session, 'phang');
  let interruptCalled = false;
  session.query = {
    interrupt: () => {
      interruptCalled = true;
      if (session.pending.size !== 0) {
        return Promise.reject(new Error('pending still occupied when SDK interrupt ran'));
      }
      return Promise.resolve();
    },
  };
  await session.interrupt();
  if (interruptCalled) pass('sdk-interrupt-still-called');
  else fail('sdk-interrupt-still-called', 'query.interrupt was not invoked');
  if (session.pending.size === 0 && seen[0]?.behavior === 'deny') {
    pass('denies-before-sdk-interrupt');
  } else {
    fail('denies-before-sdk-interrupt', `size=${session.pending.size} verdict=${JSON.stringify(seen[0])}`);
  }
}

function checkRendererClearsCards() {
  const src = fs.readFileSync(path.join(ROOT, 'src/renderer/ui/useAgent.js'), 'utf8');
  const block = src.match(/const interrupt = useCallback\(async \(\) => \{[\s\S]*?\}, \[edit\]\);/);
  if (!block) {
    fail('renderer-interrupt-block', 'could not find useAgent interrupt callback');
    return;
  }
  pass('renderer-interrupt-block');
  if (/kind === ['"]perm['"]/.test(block[0]) && /decided:\s*['"]deny['"]/.test(block[0])) {
    pass('renderer-interrupt-denies-cards');
  } else {
    fail('renderer-interrupt-denies-cards', 'interrupt() does not mark pending perm items decided');
  }
}

(async () => {
  await checkInterruptClearsPending();
  await checkDeniesBeforeSdkInterrupt();
  checkRendererClearsCards();
  if (failures.length) {
    console.log(`\n${failures.length} failure(s)`);
    process.exit(1);
  }
  console.log('\nall passed');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
