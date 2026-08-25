// Injected into every page in the preview pane. Installs window.__tandem, the
// helper the agent tools call through executeJavaScript.
(() => {
  if (window.__tandem && window.__tandem.version === 1) return 'already-installed';

  const INTERACTIVE = 'a,button,input,select,textarea,summary,[role=button],[role=link],[role=checkbox],[role=radio],[role=tab],[role=menuitem],[role=switch],[role=combobox],[role=textbox],[contenteditable=""],[contenteditable=true],[onclick],[tabindex]:not([tabindex="-1"])';
  let counter = 0;

  const isVisible = (el) => {
    const style = getComputedStyle(el);
    if (style.visibility === 'hidden' || style.display === 'none' || style.opacity === '0') return false;
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return false;
    if (r.bottom < 0 || r.right < 0) return false;
    if (r.top > (window.innerHeight || 0) * 4) return false; // keep some below-fold context
    return true;
  };

  const label = (el) => {
    const aria = el.getAttribute('aria-label');
    if (aria) return aria.trim();
    const labelledby = el.getAttribute('aria-labelledby');
    if (labelledby) {
      const t = labelledby.split(/\s+/).map((id) => document.getElementById(id)?.textContent || '').join(' ').trim();
      if (t) return t;
    }
    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT') {
      if (el.id) {
        const l = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
        if (l?.textContent.trim()) return l.textContent.trim();
      }
      const wrap = el.closest('label');
      if (wrap?.textContent.trim()) return wrap.textContent.trim();
      if (el.placeholder) return el.placeholder;
      if (el.name) return el.name;
    }
    if (el.tagName === 'IMG') return el.alt || '';
    const text = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
    return text.slice(0, 120);
  };

  const role = (el) => {
    const explicit = el.getAttribute('role');
    if (explicit) return explicit;
    const tag = el.tagName.toLowerCase();
    if (tag === 'a') return el.href ? 'link' : 'generic';
    if (tag === 'button' || tag === 'summary') return 'button';
    if (tag === 'select') return 'combobox';
    if (tag === 'textarea') return 'textbox';
    if (tag === 'img') return 'image';
    if (/^h[1-6]$/.test(tag)) return 'heading';
    if (tag === 'input') {
      const t = (el.type || 'text').toLowerCase();
      if (t === 'checkbox') return 'checkbox';
      if (t === 'radio') return 'radio';
      if (t === 'submit' || t === 'button' || t === 'reset') return 'button';
      if (t === 'range') return 'slider';
      return 'textbox';
    }
    return 'generic';
  };

  const state = (el) => {
    const bits = [];
    if (el.disabled) bits.push('disabled');
    if (el.checked) bits.push('checked');
    if (el.getAttribute('aria-expanded') === 'true') bits.push('expanded');
    if (el.getAttribute('aria-selected') === 'true') bits.push('selected');
    if (el === document.activeElement) bits.push('focused');
    if (el.value && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) {
      bits.push(`value=${JSON.stringify(String(el.value).slice(0, 60))}`);
    }
    return bits;
  };

  const ref = (el) => {
    let r = el.getAttribute('data-tandem-ref');
    if (!r) {
      r = 'e' + ++counter;
      el.setAttribute('data-tandem-ref', r);
    }
    return r;
  };

  function walk(root, out, depth, opts) {
    const nodes = root.querySelectorAll(INTERACTIVE + ',h1,h2,h3,h4,h5,h6,[role=heading],[role=alert],[role=dialog],iframe');
    for (const el of nodes) {
      if (!isVisible(el)) continue;
      if (el.tagName === 'IFRAME') {
        let doc = null;
        try { doc = el.contentDocument; } catch { /* cross origin */ }
        out.push(`${'  '.repeat(depth)}- iframe ${JSON.stringify(el.src || '')}${doc ? '' : ' (cross-origin, not readable)'}`);
        if (doc) walk(doc, out, depth + 1, opts);
        continue;
      }
      const r = role(el);
      const name = label(el);
      const bits = state(el);
      const href = el.tagName === 'A' && el.href ? ` href=${JSON.stringify(el.getAttribute('href'))}` : '';
      const line = `${'  '.repeat(depth)}- ${r} ${JSON.stringify(name)} [ref=${ref(el)}]${href}${bits.length ? ' ' + bits.join(' ') : ''}`;
      out.push(line);
      if (out.length > (opts.max || 600)) { out.push('… truncated'); return; }
    }
  }

  const resolve = (target) => {
    if (!target) throw new Error('missing target');
    const el = target.startsWith('e') && /^e\d+$/.test(target)
      ? document.querySelector(`[data-tandem-ref="${target}"]`)
      : document.querySelector(target);
    if (!el) {
      const stale = /^e\d+$/.test(target);
      throw new Error(
        `no element for ${JSON.stringify(target)}` +
        (stale ? ' - refs are dropped on navigation, take a fresh snapshot' : ''),
      );
    }
    return el;
  };

  const center = (el) => {
    el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, rect: { x: r.left, y: r.top, w: r.width, h: r.height } };
  };

  // Where the agent just acted. The pane is a real browser with a human
  // watching it, and a field that fills itself with nothing on screen to
  // explain it reads as the page misbehaving. One pointer, moved rather than
  // redrawn, so a run of actions looks like something crossing the page.
  // Anything appended to the page is styled by the page. example.com alone has
  // a bare `div { opacity: .8 }`, which was quietly making these see-through.
  // Starting from initial puts every property in the inline style, where no
  // selector the page owns can reach it.
  const RESET = 'all:initial;';
  const CURSOR_ID = '__tandem-cursor';
  const CURSOR_EASE = 'transform .13s cubic-bezier(.2,.8,.3,1), opacity .18s linear';
  // White fill on a dark outline, which is the one combination that stays
  // legible whatever the page underneath is doing. The tip is the origin, so
  // translating by the hit point puts it exactly where the click lands.
  const ARROW = '<svg viewBox="0 0 20 22" style="all:initial;display:block;width:20px;height:22px">'
    + '<path d="M2 1.6 2 17.4 6.3 13.5 9 19.7 12 18.4 9.3 12.3 15.2 12.1Z"'
    + ' style="fill:#fff;stroke:#171b26;stroke-width:1.4;stroke-linejoin:round"/></svg>';
  let cursorFade = null;

  function ripple(x, y) {
    const dot = document.createElement('div');
    dot.dataset.tandemRipple = '';
    // Wider than the arrow that sits on top of it, or the pointer hides the
    // only part that moves. Filled rather than a ring: a 2px border scaled to
    // .4 is a hairline, and at speed nobody sees a hairline.
    dot.style.cssText = `${RESET}position:fixed;left:${x - 21}px;top:${y - 21}px;width:42px;height:42px;`
      + 'border-radius:999px;background:rgba(181,140,246,.42);'
      + 'box-shadow:0 0 0 2px rgba(181,140,246,.85);'
      + 'pointer-events:none;z-index:2147483646;transform:scale(.35);'
      + 'transition:transform .45s ease-out, opacity .45s ease-in';   // ease-in holds it solid, then drops
    document.body.appendChild(dot);
    requestAnimationFrame(() => { dot.style.transform = 'scale(1.25)'; dot.style.opacity = '0'; });
    setTimeout(() => dot.remove(), 520);
  }

  function mark(x, y, kind) {
    if (!document.body) return;
    let el = document.getElementById(CURSOR_ID);
    if (!el) {
      el = document.createElement('div');
      el.id = CURSOR_ID;
      el.style.cssText = RESET + 'position:fixed;left:0;top:0;pointer-events:none;z-index:2147483647;opacity:0;';
      el.style.transition = CURSOR_EASE;
      el.innerHTML = ARROW;
      document.body.appendChild(el);
    }
    // Arriving after a fade, land on the spot instead of gliding the width of
    // the page to reach it. Reading the box forces the jump to take effect
    // before the easing goes back on.
    if (el.style.opacity !== '1') {
      el.style.transition = 'none';
      el.style.transform = `translate(${x}px, ${y}px)`;
      el.getBoundingClientRect();
      el.style.transition = CURSOR_EASE;
    }
    el.style.opacity = '1';
    el.style.transform = `translate(${x}px, ${y}px)`;
    if (kind === 'click') ripple(x, y);

    clearTimeout(cursorFade);
    cursorFade = setTimeout(() => { el.style.opacity = '0'; }, 1800);
  }

  window.__tandem = {
    version: 1,

    snapshot(opts = {}) {
      const out = [];
      walk(document, out, 0, opts);
      const head = [
        `url: ${location.href}`,
        `title: ${JSON.stringify(document.title)}`,
        `viewport: ${window.innerWidth}x${window.innerHeight}  scroll: ${Math.round(window.scrollY)}/${Math.round(document.documentElement.scrollHeight)}`,
        '',
      ];
      return head.concat(out.length ? out : ['(no interactive elements found)']).join('\n');
    },

    text(maxChars = 20000) {
      const t = (document.body?.innerText || '').replace(/\n{3,}/g, '\n\n');
      return t.length > maxChars ? t.slice(0, maxChars) + '\n… truncated' : t;
    },

    // `show` draws the pointer at the point as well as returning it. The
    // callers that are about to act pass a kind; the ones only measuring, like
    // a targeted screenshot, leave it off and stay out of their own picture.
    point(target, show) {
      const el = resolve(target);
      const c = center(el);
      if (show) mark(c.x, c.y, show);
      return { x: c.x, y: c.y, rect: c.rect, tag: el.tagName.toLowerCase() };
    },

    cursor(x, y, kind) { mark(x, y, kind); return { ok: true }; },

    // Called before a screenshot: the pointer is for the human at the window,
    // and an arrow sitting in the agent's own capture is a thing on the page
    // that is not on the page.
    cursorHide() {
      clearTimeout(cursorFade);
      document.getElementById(CURSOR_ID)?.remove();
      document.querySelectorAll('[data-tandem-ripple]').forEach((n) => n.remove());
      return { ok: true };
    },

    fill(target, value) {
      const el = resolve(target);
      const c = center(el);
      mark(c.x, c.y, 'click');
      el.focus();
      const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
      if (setter) setter.call(el, value);
      else if (el.isContentEditable) el.textContent = value;
      else el.value = value;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return { ok: true, value: el.value ?? el.textContent };
    },

    select(target, value) {
      const el = resolve(target);
      const c = center(el);
      mark(c.x, c.y, 'click');
      const opt = [...el.options].find((o) => o.value === value || o.label === value || o.text === value);
      if (!opt) throw new Error(`no option matching ${JSON.stringify(value)}`);
      el.value = opt.value;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return { ok: true, value: el.value };
    },

    focus(target) {
      const el = resolve(target);
      const c = center(el);
      mark(c.x, c.y, 'click');
      el.focus();
      return { ok: true };
    },

    scroll(dy, dx = 0) { window.scrollBy({ top: dy, left: dx, behavior: 'instant' }); return { y: window.scrollY }; },

    scrollTo(target) { const el = resolve(target); center(el); return { y: window.scrollY }; },

    waitFor(selector, timeout = 5000) {
      return new Promise((res, rej) => {
        if (document.querySelector(selector)) return res(true);
        const started = Date.now();
        const obs = new MutationObserver(() => {
          if (document.querySelector(selector)) { obs.disconnect(); res(true); }
        });
        obs.observe(document.documentElement, { childList: true, subtree: true, attributes: true });
        const timer = setInterval(() => {
          if (Date.now() - started > timeout) {
            clearInterval(timer); obs.disconnect();
            rej(new Error(`timed out waiting for ${selector}`));
          }
        }, 100);
      });
    },

    cssPath(el) {
      if (el.id) return '#' + CSS.escape(el.id);
      const parts = [];
      let node = el;
      while (node && node.nodeType === 1 && parts.length < 5) {
        let part = node.tagName.toLowerCase();
        if (node.id) { parts.unshift('#' + CSS.escape(node.id)); break; }
        const cls = [...node.classList].filter((c) => !/^(is|has)-|active|open|hover/.test(c)).slice(0, 2);
        if (cls.length) part += '.' + cls.map((c) => CSS.escape(c)).join('.');
        const sibs = node.parentElement ? [...node.parentElement.children].filter((n) => n.tagName === node.tagName) : [];
        if (sibs.length > 1) part += `:nth-of-type(${sibs.indexOf(node) + 1})`;
        parts.unshift(part);
        node = node.parentElement;
      }
      return parts.join(' > ');
    },

    // Let the human point at something instead of describing it, then say what
    // is wrong with it without leaving the page. The note bar is drawn in here
    // rather than as a dialog in the app shell for two reasons: the shell would
    // have to move the whole pane out of its own way to be seen over it, and
    // the thing being described would go with it.
    pick() {
      if (this._picking) this._picking();
      return new Promise((resolve) => {
        const box = document.createElement('div');
        box.style.cssText = RESET + 'position:fixed;pointer-events:none;z-index:2147483647;border:2px solid #b58cf6;background:rgba(181,140,246,.14);border-radius:2px;transition:all .04s linear';
        const tip = document.createElement('div');
        tip.style.cssText = RESET + 'position:fixed;pointer-events:none;z-index:2147483647;background:#171b26;color:#d7dce6;font:11px ui-monospace,monospace;padding:3px 7px;border-radius:4px;border:1px solid #232936;white-space:nowrap';
        document.body.append(box, tip);

        let current = null;
        let bar = null;
        const move = (e) => {
          const el = document.elementFromPoint(e.clientX, e.clientY);
          if (!el || el === current) return;
          current = el;
          const r = el.getBoundingClientRect();
          box.style.cssText += `;left:${r.left}px;top:${r.top}px;width:${r.width}px;height:${r.height}px`;
          tip.textContent = `${el.tagName.toLowerCase()}  ${Math.round(r.width)}x${Math.round(r.height)}`;
          tip.style.left = r.left + 'px';
          tip.style.top = (r.top > 24 ? r.top - 22 : r.bottom + 4) + 'px';
        };
        const done = (value) => { cleanup(); resolve(value); };

        // The chosen element keeps its outline while the bar is up, so what you
        // are writing about stays in front of you.
        const ask = (hit, r) => {
          document.removeEventListener('mousemove', move, true);
          document.removeEventListener('click', click, true);
          tip.remove();

          bar = document.createElement('div');
          bar.style.cssText = RESET + 'position:fixed;z-index:2147483647;display:flex;align-items:center;gap:8px;'
            + 'background:#171b26;border:1px solid #2b3346;border-radius:999px;padding:6px 12px 6px 10px;'
            + 'box-shadow:0 6px 20px rgba(0,0,0,.45);font:13px system-ui,-apple-system,sans-serif';

          const chip = document.createElement('span');
          chip.textContent = hit.role === 'generic' ? hit.tag : hit.role;
          chip.style.cssText = RESET + 'flex:none;color:#d7dce6;font:12px ui-monospace,monospace;'
            + 'background:rgba(181,140,246,.16);box-shadow:inset 0 0 0 1px rgba(181,140,246,.45);'
            + 'border-radius:999px;padding:1px 8px';

          const field = document.createElement('input');
          field.type = 'text';
          field.placeholder = 'Describe the change';
          field.style.cssText = RESET + 'flex:1;min-width:220px;cursor:text;background:none;border:0;outline:0;padding:0;'
            + 'color:#d7dce6;font:13px system-ui,-apple-system,sans-serif';

          const hint = document.createElement('span');
          hint.textContent = '↵';
          hint.style.cssText = RESET + 'flex:none;color:#79839a;font:12px ui-monospace,monospace';

          bar.append(chip, field, hint);
          document.body.appendChild(bar);

          // Below the element where there is room, above it where there is not,
          // and never off the side.
          const bw = bar.getBoundingClientRect().width;
          const below = r.bottom + 8;
          const fits = below + 40 < window.innerHeight;
          bar.style.top = (fits ? below : Math.max(8, r.top - 44)) + 'px';
          bar.style.left = Math.round(Math.max(8, Math.min(r.left, window.innerWidth - bw - 8))) + 'px';

          // The page underneath may be listening for the same keys. Nothing
          // typed in here is meant for it.
          field.addEventListener('keydown', (e) => {
            e.stopPropagation();
            if (e.key === 'Enter') { e.preventDefault(); done({ ...hit, note: field.value.trim() }); }
            if (e.key === 'Escape') { e.preventDefault(); done(null); }
          }, true);
          field.focus();
        };

        const click = (e) => {
          e.preventDefault(); e.stopPropagation();
          const el = document.elementFromPoint(e.clientX, e.clientY);
          if (!el) return done(null);
          const r = el.getBoundingClientRect();
          ask({
            ref: ref(el),
            css: window.__tandem.cssPath(el),
            role: role(el),
            name: label(el),
            tag: el.tagName.toLowerCase(),
            rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
            text: (el.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 120),
          }, r);
        };
        const key = (e) => { if (e.key === 'Escape') { e.preventDefault(); done(null); } };
        const cleanup = () => {
          this._picking = null;
          box.remove(); tip.remove(); bar?.remove();
          document.removeEventListener('mousemove', move, true);
          document.removeEventListener('click', click, true);
          document.removeEventListener('keydown', key, true);
        };
        this._picking = cleanup;
        document.addEventListener('mousemove', move, true);
        document.addEventListener('click', click, true);
        document.addEventListener('keydown', key, true);
      });
    },

    highlight(target) {
      const el = resolve(target);
      const { rect } = center(el);
      const box = document.createElement('div');
      box.style.cssText = `${RESET}position:fixed;left:${rect.x}px;top:${rect.y}px;width:${rect.w}px;height:${rect.h}px;border:2px solid #f0f;border-radius:3px;pointer-events:none;z-index:2147483647;box-shadow:0 0 0 9999px rgba(0,0,0,.25)`;
      document.body.appendChild(box);
      setTimeout(() => box.remove(), 1200);
      return { ok: true };
    },
  };

  return 'installed';
})();
