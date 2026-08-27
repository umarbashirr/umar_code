/* The preview is a native view the window paints on top of this document, so a
   popup landing over it opens somewhere nobody can see.

   Parking the pane the way a modal does would resize the page, and picking a
   viewport while the page jumps to another width is no good. So freeze it
   instead: photograph the page, hang the picture where the view was, and hide
   the view until the popup closes. The bounds never change, so nothing reflows
   and the page comes back on exactly the frame it left. */
'use strict';

let still = null;

// A photograph takes a round trip to the main process, and the popup that asked
// for it may be gone by the time it lands. Every uncover retires whatever is in
// flight.
let token = 0;

export function uncoverPane() {
  token += 1;
  if (!still) return;
  const going = still;
  still = null;
  // The native view takes a frame to come back. Pulling the picture out in the
  // same one leaves a hole where the page should be, which is the white blink
  // people saw on the way out of the menu.
  window.tandem.browser.setVisible(true);
  requestAnimationFrame(() => going.remove());
}

/* The photograph, taken early.

   Covering the pane costs a round trip to main and a capture at the end of it,
   and asking for that only once the menu is already open leaves the page live
   under a menu nobody can see, then swaps it for a still a tenth of a second
   later. Warming on the way down to the click, from pointerdown, means the
   picture is usually in hand by the time the menu is up.

   The offer is good for a second. A page that has moved on since is a page the
   still would misrepresent, and taking another one costs what it always cost. */
let warm = null;

export function warmPane() {
  const mine = token;
  const at = performance.now();
  const shot = window.tandem.browser.action('still').catch(() => null);
  warm = { at, mine, shot };
}

/* `since` is the token as it stood before this cover claimed one, which is what
   the warm shot was taken under. Comparing against the current token instead
   would never match, and the prefetch would be thrown away every time. */
async function lastStill(since) {
  if (warm && warm.mine === since && performance.now() - warm.at < 1000) {
    const url = await warm.shot;
    warm = null;
    if (url) return url;
  }
  warm = null;

  // The first capture after a page paints can come back empty, and hiding the
  // view behind a picture of nothing is the blank the cover exists to avoid.
  // One more ask costs a round trip in the case that was going to look broken.
  const url = await window.tandem.browser.action('still').catch(() => null);
  return url || window.tandem.browser.action('still').catch(() => null);
}

// `rect` is where the popup ended up. Anything clear of the pane needs no cover,
// which is most of them: walking the menu bar carries a menu off the pane and
// back on again.
export async function coverPane(rect) {
  const slot = document.querySelector('#paneslot');
  if (!slot || !rect) return uncoverPane();

  const r = slot.getBoundingClientRect();
  const clear = !r.width || !r.height
    || rect.right < r.left || rect.left > r.right
    || rect.bottom < r.top || rect.top > r.bottom;
  if (clear) return uncoverPane();
  if (still) return;

  const since = token;
  const mine = ++token;
  const url = await lastStill(since);
  if (mine !== token || still) return;

  const img = document.createElement('img');
  img.className = 'pane-still';
  if (url) {
    img.src = url;
    // A picture that is in the document but has not decoded yet paints as
    // nothing, and the view underneath is already gone by then. Wait for the
    // pixels, then swap: one frame has the page, the next has the photograph,
    // and no frame has neither.
    try { await img.decode(); } catch { /* a picture that will not decode is still better than a hole */ }
    if (mine !== token || still) return;
  }

  still = img;
  slot.appendChild(img);
  window.tandem.browser.setVisible(false);
}
