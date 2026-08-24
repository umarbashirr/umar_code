// Turning what the human dropped, pasted or picked into something the chat can
// show and the agent can use.
//
// Pictures are shrunk here rather than in the main process: a canvas is already
// sitting in this process doing nothing, and it keeps one downscaler in the
// codebase instead of two. Everything else is left alone on disk.

// Claude's vision stack resizes anything larger than this itself, so sending
// full-resolution pixels costs upload time and tokens to reach the same answer.
const MAX_EDGE = 1568;
// Comfortably under the per-image limit once base64 has added its third.
const MAX_BYTES = 3.5 * 1024 * 1024;

const loadImage = (src) => new Promise((resolve, reject) => {
  const img = new Image();
  img.onload = () => resolve(img);
  img.onerror = () => reject(new Error('that image could not be decoded'));
  img.src = src;
});

const base64Of = (dataUrl) => dataUrl.slice(dataUrl.indexOf(',') + 1);
const mediaOf = (dataUrl) => dataUrl.slice(5, dataUrl.indexOf(';'));

// Down to the long-edge limit first, then down in quality until it fits. A GIF
// loses its animation on the way through the canvas, which is the price of
// showing the model a frame it can actually read.
async function shrink(dataUrl) {
  const img = await loadImage(dataUrl);
  const scale = Math.min(1, MAX_EDGE / Math.max(img.width, img.height));
  const withinBytes = base64Of(dataUrl).length * 0.75 <= MAX_BYTES;
  if (scale === 1 && withinBytes) return { dataUrl, width: img.width, height: img.height };

  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(img.width * scale));
  canvas.height = Math.max(1, Math.round(img.height * scale));
  canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);

  // PNG first so a screenshot of text stays sharp; JPEG only when the PNG is
  // too heavy, which is what happens with photographs.
  let out = canvas.toDataURL('image/png');
  for (const q of [0.85, 0.7, 0.55]) {
    if (base64Of(out).length * 0.75 <= MAX_BYTES) break;
    out = canvas.toDataURL('image/jpeg', q);
  }
  return { dataUrl: out, width: canvas.width, height: canvas.height };
}

let seq = 0;
const uid = () => `at${Date.now()}${++seq}`;

// One entry per file, in the shape the composer draws and the submit path
// reads. A file that could not be read comes back with `error` set rather than
// being dropped, so the human is told instead of left wondering.
export async function toAttachments(described) {
  const out = [];
  for (const d of described) {
    if (!d || d.error) {
      out.push({ id: uid(), kind: 'error', name: d?.name || 'file', error: d?.error || 'could not read that' });
      continue;
    }
    if (d.kind !== 'image') {
      out.push({ id: uid(), kind: 'file', name: d.name, path: d.path, size: d.size, note: d.note || null });
      continue;
    }
    try {
      const { dataUrl, width, height } = await shrink(d.dataUrl);
      out.push({
        id: uid(),
        kind: 'image',
        name: d.name,
        path: d.path || null,
        size: d.size,
        width,
        height,
        media: mediaOf(dataUrl),
        data: base64Of(dataUrl),
        preview: dataUrl,
      });
    } catch (e) {
      out.push({ id: uid(), kind: 'error', name: d.name, error: e.message });
    }
  }
  return out;
}

export async function fromPaths(paths) {
  if (!paths.length) return [];
  return toAttachments(await window.tandem.attach.add(paths));
}

// Clipboard pictures arrive as bytes with no file behind them. Main writes one
// so the agent has something on disk to go back to.
export async function fromBlob(blob, name) {
  const dataUrl = await new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(new Error('could not read that'));
    r.readAsDataURL(blob);
  });
  return toAttachments([await window.tandem.attach.paste(dataUrl, name)]);
}

// What the composer's chips say, and what the agent is told about a file it has
// to go and read for itself.
export const sizeLabel = (n) => {
  if (!n && n !== 0) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
};
