'use strict';
// There is one preview pane and there can be several agents. Left alone they
// interleave: one takes a snapshot, another navigates, and the first clicks a
// ref that now points at nothing, or worse at the wrong thing on a new page.
//
// So the pane has a driver. The first agent to change the page takes it and
// keeps it until it stops asking; anyone else changing the page waits their
// turn. Looking is always allowed, because two agents reading the same page is
// how one of them notices what the other broke.

// Tools that only observe. These never wait and never take the lease.
const READS = new Set([
  'snapshot', 'text', 'html', 'screenshot', 'console', 'network', 'state', 'highlight', 'preview',
]);

// Nobody holds the pane forever. An agent that took it and then went off to
// read files has finished with the browser, whatever it thinks. Shorter than
// WAIT_MS on purpose: a waiter should outlive the hold it is waiting on, or it
// gives up on a pane that was already free.
const IDLE_MS = 8000;
// How long a waiting call sits there before it gives up and says so. Long
// enough to cover a page load and an idle handover, short enough that the
// agent can react rather than look hung.
const WAIT_MS = 20000;

class PaneLease {
  constructor({ onChange } = {}) {
    this.holder = null;                // { id, label }
    this.touched = 0;
    this.queue = [];                   // [{ actor, resolve }]
    this.onChange = onChange || (() => {});
  }

  get free() {
    return !this.holder || Date.now() - this.touched > IDLE_MS;
  }

  // The name to show the human, or null when nothing has the pane.
  current() {
    return this.free ? null : this.holder;
  }

  /**
   * Wait until this actor may drive the pane. Resolves with null when it may
   * go ahead, or a sentence explaining the wait when it timed out. A read is
   * never blocked, so callers can always look at what the driver is doing.
   */
  async acquire(tool, actor) {
    const who = actor && actor.id ? actor : { id: 'main', label: 'the main thread' };
    if (READS.has(tool)) return null;

    if (this.free || this.holder.id === who.id) return this.#take(who);

    const held = this.holder;
    const waited = await new Promise((resolve) => {
      const entry = { actor: who, resolve };
      this.queue.push(entry);
      entry.timer = setTimeout(() => {
        this.queue = this.queue.filter((e) => e !== entry);
        resolve(false);
      }, WAIT_MS);
      // The holder may simply stop calling tools, in which case nothing else
      // would ever run #drain. Come back when its hold expires.
      this.#schedule();
    });

    if (!waited) {
      return `The preview pane is being driven by another agent (${held.label}). `
        + 'It kept the pane for longer than this call could wait. Try again, or say so and let the human decide who gets it.';
    }
    return this.#take(who);
  }

  #take(who) {
    const changed = this.holder?.id !== who.id;
    this.holder = who;
    this.touched = Date.now();
    if (changed) this.onChange(this.current());
    return null;
  }

  // Called when a tool call finishes, which is what keeps a busy driver's hold
  // alive and hands the pane on when it goes quiet.
  done(tool, actor) {
    if (READS.has(tool)) return;
    if (this.holder && actor?.id === this.holder.id) this.touched = Date.now();
    this.#drain();
  }

  // The turn ended, so whatever the agent was doing to the page, it has stopped.
  release(actorId) {
    if (actorId && this.holder?.id !== actorId) return this.#drain();
    this.holder = null;
    this.onChange(null);
    this.#drain();
  }

  // A whole chat finished. Its main thread and every subagent under it are done
  // with the pane, and anything queued from another chat can have it.
  releaseChat(chat) {
    for (const e of this.queue.splice(0)) {
      if (e.actor.chat !== chat) { this.queue.push(e); continue; }
      clearTimeout(e.timer);
      e.resolve(false);
    }
    if (this.holder?.chat === chat) this.release(this.holder.id);
    else this.#drain();
  }

  // The human pressing "take over" outranks everyone.
  seize() {
    this.holder = { id: 'human', label: 'you' };
    this.touched = Date.now();
    this.onChange(this.current());
    for (const e of this.queue.splice(0)) { clearTimeout(e.timer); e.resolve(false); }
  }

  // Wake up when the current hold lapses, so a queue behind a driver that went
  // quiet moves on its own rather than waiting for the next tool call.
  #schedule() {
    clearTimeout(this.timer);
    if (!this.holder || !this.queue.length) return;
    const left = Math.max(0, IDLE_MS - (Date.now() - this.touched)) + 25;
    this.timer = setTimeout(() => this.#drain(), left);
  }

  #drain() {
    if (!this.free) return this.#schedule();
    const next = this.queue.shift();
    if (!next) { if (this.holder) { this.holder = null; this.onChange(null); } return; }
    clearTimeout(next.timer);
    next.resolve(true);
    this.#schedule();
  }

  stop() {
    clearTimeout(this.timer);
    for (const e of this.queue.splice(0)) { clearTimeout(e.timer); e.resolve(false); }
    this.holder = null;
  }
}

module.exports = { PaneLease, READS };
