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

    point(target) {
      const el = resolve(target);
      const c = center(el);
      return { x: c.x, y: c.y, rect: c.rect, tag: el.tagName.toLowerCase() };
    },

    fill(target, value) {
      const el = resolve(target);
      center(el);
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
      const opt = [...el.options].find((o) => o.value === value || o.label === value || o.text === value);
      if (!opt) throw new Error(`no option matching ${JSON.stringify(value)}`);
      el.value = opt.value;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return { ok: true, value: el.value };
    },

    focus(target) { const el = resolve(target); center(el); el.focus(); return { ok: true }; },

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

    // Let the human point at something instead of describing it.
    pick() {
      if (this._picking) this._picking();
      return new Promise((resolve) => {
        const box = document.createElement('div');
        box.style.cssText = 'position:fixed;pointer-events:none;z-index:2147483647;border:2px solid #b58cf6;background:rgba(181,140,246,.14);border-radius:2px;transition:all .04s linear';
        const tip = document.createElement('div');
        tip.style.cssText = 'position:fixed;pointer-events:none;z-index:2147483647;background:#171b26;color:#d7dce6;font:11px ui-monospace,monospace;padding:3px 7px;border-radius:4px;border:1px solid #232936;white-space:nowrap';
        document.body.append(box, tip);

        let current = null;
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
        const click = (e) => {
          e.preventDefault(); e.stopPropagation();
          const el = document.elementFromPoint(e.clientX, e.clientY);
          if (!el) return done(null);
          const r = el.getBoundingClientRect();
          done({
            ref: ref(el),
            css: window.__tandem.cssPath(el),
            role: role(el),
            name: label(el),
            tag: el.tagName.toLowerCase(),
            rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
            text: (el.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 120),
          });
        };
        const key = (e) => { if (e.key === 'Escape') { e.preventDefault(); done(null); } };
        const cleanup = () => {
          this._picking = null;
          box.remove(); tip.remove();
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
      box.style.cssText = `position:fixed;left:${rect.x}px;top:${rect.y}px;width:${rect.w}px;height:${rect.h}px;border:2px solid #f0f;border-radius:3px;pointer-events:none;z-index:2147483647;box-shadow:0 0 0 9999px rgba(0,0,0,.25)`;
      document.body.appendChild(box);
      setTimeout(() => box.remove(), 1200);
      return { ok: true };
    },
  };

  return 'installed';
})();
