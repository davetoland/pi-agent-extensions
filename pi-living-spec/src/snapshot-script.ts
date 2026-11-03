/**
 * In-page DOM extraction script.
 *
 * Kept as a plain JavaScript string (not a TS function) so no transpiler can
 * inject helpers (e.g. esbuild's __name) that would not exist in the browser.
 *
 * Produces a compact, indented, LLM-friendly outline of what a user can see
 * and do on the page, and tags every interactive element with a stable
 * `data-ls-ref="eN"` attribute so the agent can act on it afterwards.
 */
export const SNAPSHOT_FN_SRC = String.raw`function (opts) {
  opts = opts || {};
  var MAX_LINES = opts.maxLines || 600;
  var MAX_TEXT = opts.maxText || 160;
  var origin = location.origin;
  var lines = [];
  var truncated = false;
  var counter = window.__lsRefCounter || 0;
  var seenText = {};
  var stats = { interactive: 0, forms: 0, tables: 0, dialogs: 0, images: 0 };

  var SKIP = { script:1, style:1, noscript:1, template:1, meta:1, link:1, head:1, path:1, br:1, hr:1 };
  var INTERACTIVE_SEL = 'a[href],button,input:not([type=hidden]),select,textarea,summary,[contenteditable="true"],' +
    '[role=button],[role=link],[role=tab],[role=menuitem],[role=menuitemcheckbox],[role=menuitemradio],[role=option],' +
    '[role=checkbox],[role=radio],[role=switch],[role=combobox],[role=slider],[role=textbox],[role=searchbox]';
  var CONTAINER_ROLES = { banner:1, navigation:1, main:1, complementary:1, contentinfo:1, form:1, dialog:1, alertdialog:1,
    tablist:1, menu:1, menubar:1, listbox:1, region:1, search:1, tabpanel:1, toolbar:1 };
  var BLOCK_TAGS = { div:1, section:1, article:1, ul:1, ol:1, table:1, form:1, header:1, footer:1, nav:1, main:1, aside:1, p:1,
    h1:1, h2:1, h3:1, h4:1, h5:1, h6:1, dl:1, fieldset:1, figure:1 };

  function clean(s, max) {
    s = (s || '').replace(/\s+/g, ' ').trim();
    max = max || MAX_TEXT;
    return s.length > max ? s.slice(0, max - 1) + '…' : s;
  }
  function q(s) { return '"' + clean(s).replace(/"/g, "'") + '"'; }
  function push(depth, text) {
    if (lines.length >= MAX_LINES) { truncated = true; return false; }
    lines.push(new Array(depth + 1).join('  ') + text);
    return true;
  }
  function visible(el) {
    var st = getComputedStyle(el);
    if (st.display === 'none' || st.visibility === 'hidden') return false;
    if (st.display === 'contents') return true;
    if (parseFloat(st.opacity) === 0 && !el.querySelector(INTERACTIVE_SEL)) return false;
    var r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0 && st.overflow !== 'visible') return false;
    return true;
  }
  function srOnly(el) {
    var cls = typeof el.className === 'string' ? el.className : '';
    return /(^|\s)sr-only(\s|$)/.test(cls);
  }
  function lucideIcon(el) {
    var svg = el.querySelector ? el.querySelector('svg[class*="lucide-"]') : null;
    if (!svg) return '';
    var m = (svg.getAttribute('class') || '').match(/lucide-([a-z0-9-]+)/g);
    if (!m) return '';
    var names = m.map(function (x) { return x.replace('lucide-', ''); }).filter(function (x) { return x !== 'icon'; });
    return names.length ? 'icon:' + names[names.length - 1] : '';
  }
  function implicitRole(el) {
    var tag = el.tagName.toLowerCase();
    var explicit = el.getAttribute('role');
    if (explicit) return explicit;
    if (tag === 'a') return el.hasAttribute('href') ? 'link' : '';
    if (tag === 'button' || tag === 'summary') return 'button';
    if (tag === 'select') return el.multiple ? 'listbox' : 'combobox';
    if (tag === 'textarea') return 'textbox';
    if (tag === 'input') {
      var t = (el.getAttribute('type') || 'text').toLowerCase();
      if (t === 'checkbox') return 'checkbox';
      if (t === 'radio') return 'radio';
      if (t === 'range') return 'slider';
      if (t === 'number') return 'spinbutton';
      if (t === 'search') return 'searchbox';
      if (t === 'submit' || t === 'button' || t === 'reset' || t === 'image') return 'button';
      if (t === 'file') return 'file-upload';
      return 'textbox';
    }
    if (tag === 'header' && !el.closest('main,article,section')) return 'banner';
    if (tag === 'footer' && !el.closest('main,article,section')) return 'contentinfo';
    if (tag === 'nav') return 'navigation';
    if (tag === 'main') return 'main';
    if (tag === 'aside') return 'complementary';
    if (tag === 'form') return 'form';
    if (tag === 'dialog') return 'dialog';
    if (/^h[1-6]$/.test(tag)) return 'heading';
    if (tag === 'table') return 'table';
    if (tag === 'img') return 'img';
    if (tag === 'ul' || tag === 'ol') return 'list';
    if (el.isContentEditable && el.getAttribute('contenteditable') === 'true') return 'textbox';
    return '';
  }
  function nameOf(el) {
    var n = el.getAttribute('aria-label');
    if (n && n.trim()) return clean(n);
    var lb = el.getAttribute('aria-labelledby');
    if (lb) {
      var t = lb.split(/\s+/).map(function (id) { var x = document.getElementById(id); return x ? x.innerText || x.textContent : ''; }).join(' ');
      if (t.trim()) return clean(t);
    }
    var tag = el.tagName.toLowerCase();
    if (tag === 'input' || tag === 'select' || tag === 'textarea' || el.getAttribute('role') === 'combobox' || el.getAttribute('role') === 'switch' || el.getAttribute('role') === 'checkbox') {
      if (el.id) {
        var l = document.querySelector('label[for="' + CSS.escape(el.id) + '"]');
        if (l && (l.innerText || '').trim()) return clean(l.innerText);
      }
      var wrap = el.closest('label');
      if (wrap && (wrap.innerText || '').trim()) return clean(wrap.innerText);
      if (el.getAttribute('placeholder')) return clean(el.getAttribute('placeholder'));
      if (el.getAttribute('title')) return clean(el.getAttribute('title'));
      if (el.getAttribute('name')) return clean(el.getAttribute('name'));
    }
    if (tag === 'img') return clean(el.getAttribute('alt') || '');
    var txt = clean(el.innerText || el.textContent || '');
    if (txt) return txt;
    if (el.getAttribute('title')) return clean(el.getAttribute('title'));
    return lucideIcon(el);
  }
  function refOf(el) {
    var r = el.getAttribute('data-ls-ref');
    if (!r) { counter++; r = 'e' + counter; el.setAttribute('data-ls-ref', r); }
    return r;
  }
  function reactHandlers(el) {
    var keys = Object.keys(el);
    for (var i = 0; i < keys.length; i++) {
      if (keys[i].indexOf('__reactProps$') === 0) {
        var p = el[keys[i]] || {};
        return { click: typeof p.onClick === 'function' || typeof p.onMouseDown === 'function' || typeof p.onPointerDown === 'function' };
      }
    }
    return null;
  }
  function relHref(href) {
    try {
      var u = new URL(href, location.href);
      if (u.origin === origin) return u.pathname + u.search + u.hash;
      return u.href;
    } catch (e) { return href; }
  }
  function states(el) {
    var s = [];
    if (el.disabled || el.getAttribute('aria-disabled') === 'true') s.push('disabled');
    if (el.required || el.getAttribute('aria-required') === 'true') s.push('required');
    if (el.getAttribute('aria-invalid') === 'true') s.push('invalid');
    var checked = el.getAttribute('aria-checked');
    if (el.checked === true || checked === 'true') s.push('checked');
    else if (checked === 'false' || el.checked === false && /checkbox|radio/.test(el.type || '')) s.push('unchecked');
    if (el.getAttribute('aria-selected') === 'true' || el.getAttribute('data-state') === 'active') s.push('selected');
    if (el.getAttribute('aria-expanded') === 'true') s.push('expanded');
    if (el.getAttribute('aria-current') && el.getAttribute('aria-current') !== 'false') s.push('current');
    if (el.readOnly) s.push('readonly');
    return s;
  }
  function describeControl(el, role) {
    var tag = el.tagName.toLowerCase();
    var parts = [role || tag, q(nameOf(el)), '[' + refOf(el) + ']'];
    if (tag === 'input') {
      var t = (el.getAttribute('type') || 'text').toLowerCase();
      if (t !== 'text' && t !== 'checkbox' && t !== 'radio') parts.push('type=' + t);
      if (el.value && t !== 'password' && t !== 'checkbox' && t !== 'radio') parts.push('value=' + q(el.value));
      if (el.getAttribute('placeholder') && el.getAttribute('placeholder') !== nameOf(el)) parts.push('placeholder=' + q(el.getAttribute('placeholder')));
      if (el.getAttribute('min')) parts.push('min=' + el.getAttribute('min'));
      if (el.getAttribute('max')) parts.push('max=' + el.getAttribute('max'));
      if (el.getAttribute('maxlength')) parts.push('maxlength=' + el.getAttribute('maxlength'));
      if (el.getAttribute('pattern')) parts.push('pattern=' + q(el.getAttribute('pattern')));
      if (el.getAttribute('accept')) parts.push('accept=' + q(el.getAttribute('accept')));
    } else if (tag === 'textarea') {
      if (el.value) parts.push('value=' + q(el.value));
      if (el.getAttribute('placeholder') && el.getAttribute('placeholder') !== nameOf(el)) parts.push('placeholder=' + q(el.getAttribute('placeholder')));
      if (el.getAttribute('maxlength')) parts.push('maxlength=' + el.getAttribute('maxlength'));
    } else if (tag === 'select') {
      var opts = Array.prototype.slice.call(el.options).map(function (o) { return clean(o.text, 40); });
      parts.push('options=[' + opts.slice(0, 15).join(', ') + (opts.length > 15 ? ', …+' + (opts.length - 15) : '') + ']');
      if (el.selectedOptions && el.selectedOptions[0]) parts.push('selected=' + q(el.selectedOptions[0].text));
    } else if (role === 'link') {
      parts.push('-> ' + relHref(el.getAttribute('href')));
      if (el.getAttribute('target') === '_blank') parts.push('(new tab)');
    } else if (role === 'combobox') {
      var hp = el.getAttribute('aria-haspopup');
      if (hp) parts.push('popup=' + hp);
    }
    if (tag === 'button' || role === 'button') {
      var bt = el.getAttribute('type');
      if (bt === 'submit' || (tag === 'button' && !bt && el.form)) parts.push('(submits form)');
      if (el.getAttribute('aria-haspopup')) parts.push('popup=' + el.getAttribute('aria-haspopup'));
      var ico = lucideIcon(el);
      if (ico && parts[1].indexOf('icon:') === -1) parts.push(ico);
    }
    var st = states(el);
    if (st.length) parts.push('{' + st.join(',') + '}');
    return parts.join(' ');
  }
  function signature(el) {
    return el.tagName + '.' + (typeof el.className === 'string' ? el.className.split(/\s+/).slice(0, 4).join('.') : '');
  }
  function hasInteractive(el) { return !!el.querySelector(INTERACTIVE_SEL); }
  function hasBlock(el) {
    for (var c = el.firstElementChild; c; c = c.nextElementSibling) {
      if (BLOCK_TAGS[c.tagName.toLowerCase()]) return true;
    }
    return false;
  }
  function emitText(depth, text, max) {
    var t = clean(text, max || MAX_TEXT);
    if (!t || t.length < 2) return true;
    if (seenText[t]) return true;
    seenText[t] = 1;
    return push(depth, 'text ' + q(t).slice(0, (max || MAX_TEXT) + 2));
  }
  function directText(el) {
    var s = '';
    for (var n = el.firstChild; n; n = n.nextSibling) if (n.nodeType === 3) s += n.nodeValue;
    return s;
  }
  function tableSummary(el, depth) {
    stats.tables++;
    var caption = el.querySelector('caption');
    var headers = Array.prototype.slice.call(el.querySelectorAll('thead th, [role=columnheader]')).map(function (h) { return clean(h.innerText, 30); });
    if (!headers.length) {
      var first = el.querySelector('tr');
      if (first) headers = Array.prototype.slice.call(first.querySelectorAll('th')).map(function (h) { return clean(h.innerText, 30); });
    }
    var rows = Array.prototype.slice.call(el.querySelectorAll('tbody tr, [role=row]')).filter(function (r) { return !r.querySelector('th, [role=columnheader]'); });
    if (!push(depth, 'table' + (caption ? ' ' + q(caption.innerText) : '') + ' cols=[' + headers.join(' | ') + '] rows=' + rows.length)) return;
    rows.slice(0, 3).forEach(function (r) {
      var cells = Array.prototype.slice.call(r.querySelectorAll('td, [role=cell], [role=gridcell]')).map(function (c) { return clean(c.innerText, 40); });
      push(depth + 1, 'row: ' + cells.join(' | '));
      var acts = Array.prototype.slice.call(r.querySelectorAll(INTERACTIVE_SEL)).filter(visible);
      acts.slice(0, 6).forEach(function (a) { stats.interactive++; push(depth + 2, describeControl(a, implicitRole(a))); });
    });
    if (rows.length > 3) push(depth + 1, '… ' + (rows.length - 3) + ' more rows');
  }

  function walk(el, depth) {
    if (truncated) return;
    var tag = el.tagName.toLowerCase();
    if (SKIP[tag]) return;
    if (tag === 'svg') return;
    if (!visible(el)) return;
    if (el.getAttribute('aria-hidden') === 'true' && el.tabIndex < 0 && !hasInteractive(el)) {
      if (!(el.innerText || '').trim()) return;
    }
    if (tag === 'iframe') { push(depth, 'iframe src=' + q(el.getAttribute('src') || '')); return; }
    var role = implicitRole(el);

    if (role === 'heading') {
      var lvl = el.getAttribute('aria-level') || tag.replace('h', '') || '2';
      push(depth, 'h' + lvl + ' ' + q(el.innerText));
      seenText[clean(el.innerText)] = 1;
      return;
    }
    if (role === 'table' || role === 'grid') { tableSummary(el, depth); return; }
    if (role === 'img') {
      var alt = el.getAttribute('alt') || el.getAttribute('aria-label') || '';
      var r = el.getBoundingClientRect();
      if (alt || r.width * r.height > 10000) { stats.images++; push(depth, 'img ' + q(alt || '(no alt) ' + (el.getAttribute('src') || '').split('/').pop())); }
      return;
    }
    if (el.matches(INTERACTIVE_SEL) && !(el.getAttribute('aria-hidden') === 'true' && el.tabIndex < 0)) {
      if (role === 'tab' || role === 'option' || role === 'menuitem' || role === 'link' || role === 'button' || tag === 'input' || tag === 'select' || tag === 'textarea' || role) {
        stats.interactive++;
        push(depth, describeControl(el, role));
        var nm = nameOf(el); seenText[nm] = 1;
        return;
      }
    }
    if (CONTAINER_ROLES[role]) {
      if (role === 'form') stats.forms++;
      if (role === 'dialog' || role === 'alertdialog') stats.dialogs++;
      var label = el.getAttribute('aria-label') || '';
      if (!label && el.getAttribute('aria-labelledby')) label = nameOf(el);
      if (!push(depth, '[' + role + (label ? ' ' + q(label) : '') + ']')) return;
      var cdt = directText(el);
      if (cdt.trim()) emitText(depth + 1, cdt);
      children(el, depth + 1);
      return;
    }
    var rh = reactHandlers(el);
    if (rh && rh.click && tag !== 'body' && tag !== 'html' && el.id !== 'root') {
      stats.interactive++;
      var cn = clean(el.innerText || '', 80) || lucideIcon(el);
      push(depth, 'clickable ' + q(cn) + ' [' + refOf(el) + ']' + (tag === 'tr' ? ' (row)' : ''));
      if (hasInteractive(el)) children(el, depth + 1);
      return;
    }
    if (srOnly(el)) return;
    if ((tag === 'ul' || tag === 'ol' || role === 'list') && el.children.length > 8) {
      if (!push(depth, 'list (' + el.children.length + ' items)')) return;
      for (var i = 0; i < Math.min(5, el.children.length); i++) walk(el.children[i], depth + 1);
      push(depth + 1, '… ' + (el.children.length - 5) + ' more items');
      return;
    }
    if (!hasInteractive(el) && !hasBlock(el)) {
      var txt = el.innerText || '';
      if (txt.trim()) {
        if (txt.length <= 400) { emitText(depth, txt, tag === 'p' || tag === 'li' ? 300 : MAX_TEXT); return; }
      }
    }
    var dt = directText(el);
    if (dt.trim()) emitText(depth, dt);
    children(el, depth);
  }
  function children(el, depth) {
    var kids = Array.prototype.slice.call(el.children);
    if (el.shadowRoot) kids = Array.prototype.slice.call(el.shadowRoot.children).concat(kids);
    if (kids.length > 8) {
      var sig = signature(kids[1]);
      var same = kids.filter(function (k) { return signature(k) === sig; }).length;
      if (same >= kids.length - 2 && same > 8) {
        for (var i = 0; i < 4; i++) walk(kids[i], depth);
        push(depth, '… ' + (kids.length - 4) + ' more similar items');
        return;
      }
    }
    for (var j = 0; j < kids.length && !truncated; j++) walk(kids[j], depth);
  }

  walk(document.body, 0);
  window.__lsRefCounter = counter;

  var links = {};
  Array.prototype.slice.call(document.querySelectorAll('a[href]')).forEach(function (a) {
    try { var u = new URL(a.getAttribute('href'), location.href); if (/^https?:$/.test(u.protocol)) links[u.href] = clean(a.innerText || a.getAttribute('aria-label') || '', 60); } catch (e) {}
  });
  var toasts = Array.prototype.slice.call(document.querySelectorAll('[data-sonner-toast], [role=status], [role=alert], .Toastify__toast'))
    .map(function (t) { return clean(t.innerText, 200); }).filter(function (t) { return t; });
  var headings = Array.prototype.slice.call(document.querySelectorAll('h1, h2')).filter(visible).map(function (h) { return h.tagName.toLowerCase() + ': ' + clean(h.innerText, 100); });
  var bodyText = (document.body.innerText || '').toLowerCase();
  var notFound = /\b404\b/.test(bodyText) && /not found/.test(bodyText);
  return {
    url: location.href,
    title: document.title,
    outline: lines.join('\n'),
    lineCount: lines.length,
    truncated: truncated,
    links: links,
    toasts: toasts,
    headings: headings,
    notFound: notFound,
    stats: stats,
    viewport: { width: innerWidth, height: innerHeight, scrollHeight: document.documentElement.scrollHeight }
  };
}`;

export interface PageSnapshot {
	url: string;
	title: string;
	outline: string;
	lineCount: number;
	truncated: boolean;
	links: Record<string, string>;
	toasts: string[];
	headings: string[];
	notFound: boolean;
	stats: { interactive: number; forms: number; tables: number; dialogs: number; images: number };
	viewport: { width: number; height: number; scrollHeight: number };
}

export function snapshotExpression(opts: { maxLines?: number; maxText?: number } = {}): string {
	return `(${SNAPSHOT_FN_SRC})(${JSON.stringify(opts)})`;
}
