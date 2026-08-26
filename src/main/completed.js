'use strict';
/* Chats the person has marked as done.

   The rail fills up. Most of what is in it is finished work nobody is going
   back to, and it sits there at the same weight as the thing being worked on
   now. Marking a chat completed moves it out of the folder's list into a fold
   at the bottom, so the rail says what is live rather than everything that ever
   happened.

   Nothing is deleted and nothing moves on disk. The transcript stays where
   claude wrote it, `claude --resume` still offers it, and unmarking puts the
   row back where it was. This file is only a set of session ids and when each
   was marked.

   It lives beside the other things Tandem remembers rather than under
   ~/.claude/projects, which belongs to claude and which we only ever read. */
const fs = require('fs');
const path = require('path');

const projects = require('./projects');

const FILE = path.join(projects.DIR, 'completed-chats.json');

// Session ids as claude writes them. Anything else in the file is somebody
// else's business or a corruption, and is dropped on read.
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

let cache = null;

function read() {
  if (cache) return cache;
  let raw = {};
  try { raw = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch {}
  cache = {};
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    for (const [id, at] of Object.entries(raw)) {
      if (SESSION_ID.test(id)) cache[id] = Number(at) || 0;
    }
  }
  return cache;
}

function write() {
  try {
    fs.mkdirSync(projects.DIR, { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(cache, null, 2));
  } catch {}
}

// The ids, for the rail to sort its rows by. The times go too: a fold that
// eventually wants "completed last week" at the bottom has what it needs
// without another pass over the transcripts.
const all = () => ({ ...read() });

const isCompleted = (id) => Object.hasOwn(read(), id);

function setCompleted(id, done) {
  if (!SESSION_ID.test(String(id || ''))) throw new Error(`not a session id: ${id}`);
  read();
  if (done) cache[id] = Date.now();
  else delete cache[id];
  write();
  return !!done;
}

// The transcript is gone, so the mark has nothing left to be about. Called from
// the delete path rather than swept later, because a session id is never reused
// and an entry nobody cleans up would outlive every chat it named.
function forget(id) {
  read();
  if (!Object.hasOwn(cache, id)) return false;
  delete cache[id];
  write();
  return true;
}

module.exports = { all, isCompleted, setCompleted, forget, FILE };
