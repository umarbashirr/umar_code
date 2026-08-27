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
  still.remove();
  still = null;
  window.tandem.browser.setVisible(true);
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

  const mine = ++token;
  const url = await window.tandem.browser.action('still').catch(() => null);
  if (mine !== token || still) return;

  still = document.createElement('img');
  still.className = 'pane-still';
  if (url) still.src = url;
  slot.appendChild(still);
  window.tandem.browser.setVisible(false);
}
