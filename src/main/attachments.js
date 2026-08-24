'use strict';
// Files the human hands to the chat: pictures, PDFs, logs, anything.
//
// Two shapes come out of here. A picture is read into a data: URL, because the
// model can only look at an image if the bytes travel with the message. Every
// other file is described by its path and left on disk, because the agent has
// its own tools for reading files and pasting a 3MB CSV into the conversation
// would cost a fortune to say the same thing.
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const { dialog } = require('electron');

// The renderer downscales before anything is sent, so this only has to be large
// enough to hold a phone photo on the way in.
const MAX_IMAGE_BYTES = 24 * 1024 * 1024;
const MAX_PICK = 20;

const IMAGE_TYPES = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.avif': 'image/avif',
  '.bmp': 'image/bmp',
};

async function describe(file) {
  const abs = path.resolve(file);
  let st;
  try {
    st = await fsp.stat(abs);
  } catch {
    return { path: abs, name: path.basename(abs), error: 'that file is gone' };
  }
  if (st.isDirectory()) return { path: abs, name: path.basename(abs), error: 'that is a folder' };

  const name = path.basename(abs);
  const media = IMAGE_TYPES[path.extname(name).toLowerCase()];
  const base = { path: abs, name, size: st.size };

  if (!media) return { ...base, kind: 'file' };
  if (st.size > MAX_IMAGE_BYTES) {
    return { ...base, kind: 'file', note: 'too large to show the model, sent as a path' };
  }

  const buf = await fsp.readFile(abs);
  return { ...base, kind: 'image', media, dataUrl: `data:${media};base64,${buf.toString('base64')}` };
}

const add = (paths) => Promise.all((Array.isArray(paths) ? paths : []).slice(0, MAX_PICK).map(describe));

async function pick(win) {
  const res = await dialog.showOpenDialog(win, {
    title: 'Attach files',
    buttonLabel: 'Attach',
    properties: ['openFile', 'multiSelections'],
    filters: [
      { name: 'Anything', extensions: ['*'] },
      { name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'bmp'] },
      { name: 'Documents', extensions: ['pdf', 'md', 'txt', 'csv', 'json', 'log'] },
    ],
  });
  if (res.canceled) return { canceled: true, files: [] };
  return { canceled: false, files: await add(res.filePaths) };
}

// A picture pasted out of the clipboard has no file behind it. Give it one, so
// the chat can point the agent at something that will still be there when it
// looks, and so a second paste of the same screenshot does not overwrite it.
let pasted = 0;

async function fromDataUrl({ dataUrl, name }) {
  const m = /^data:([^;,]+);base64,(.+)$/s.exec(String(dataUrl || ''));
  if (!m) return { error: 'that is not something this can read' };

  const media = m[1];
  const ext = Object.entries(IMAGE_TYPES).find(([, t]) => t === media)?.[0] || '.png';
  const buf = Buffer.from(m[2], 'base64');
  if (buf.length > MAX_IMAGE_BYTES) return { error: 'that image is too large' };

  const dir = path.join(os.tmpdir(), 'tandem-attachments');
  await fsp.mkdir(dir, { recursive: true });
  const file = path.join(dir, `paste-${Date.now()}-${++pasted}${ext}`);
  await fsp.writeFile(file, buf);

  return {
    path: file,
    name: name || path.basename(file),
    size: buf.length,
    kind: 'image',
    media,
    dataUrl,
  };
}

module.exports = { add, pick, fromDataUrl };
