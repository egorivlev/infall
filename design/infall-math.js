(function () {
  var R = window.__resources || {};
  var CSS = R.katexCss || 'https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/katex.min.css';
  if (!window.katex && !document.getElementById('q-katex')) {
    var s = document.createElement('script');
    s.id = 'q-katex';
    s.src = R.katexJs || 'https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/katex.min.js';
    document.head.appendChild(s);
  }
  if (!document.getElementById('q-katex-css')) {
    var l = document.createElement('link');
    l.id = 'q-katex-css'; l.rel = 'stylesheet'; l.href = CSS;
    document.head.appendChild(l);
  }
  if (customElements.get('q-math')) return;
  var kSheet = new CSSStyleSheet();
  var hSheet = new CSSStyleSheet();
  hSheet.replaceSync(':host{display:inline}:host([display]){display:block;margin:2px 0}.katex{font-size:1.06em}.katex-display{margin:0}');
  fetch(CSS).then(function (r) { return r.text(); }).then(function (t) {
    kSheet.replaceSync(t.replace(/@font-face\{[^}]*\}/g, ''));
  }).catch(function () {});
  class QMath extends HTMLElement {
    static get observedAttributes() { return ['tex', 'display']; }
    connectedCallback() { this.r(); }
    attributeChangedCallback() { this.r(); }
    r() {
      if (!this._root) {
        this._root = this.attachShadow({ mode: 'open' });
        this._root.adoptedStyleSheets = [kSheet, hSheet];
        this._out = document.createElement('span');
        this._root.appendChild(this._out);
      }
      var tex = this.getAttribute('tex') || '';
      if (tex === this._last) return;
      if (!window.katex) { this._out.textContent = tex; clearTimeout(this._t); this._t = setTimeout(() => this.r(), 80); return; }
      this._last = tex;
      try { window.katex.render(tex, this._out, { displayMode: this.hasAttribute('display'), throwOnError: false }); } catch (e) { this._out.textContent = tex; }
    }
  }
  customElements.define('q-math', QMath);
})();
