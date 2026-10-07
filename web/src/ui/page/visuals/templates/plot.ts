// Starter: plot a function of x. Plain HTML for the Visual frame — no backticks or "${" inside.
export const PLOT = String.raw`<style>
  .wrap { display: flex; flex-direction: column; gap: 12px; padding: 16px 18px 18px; }
  .mono, input[type=text] { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
  .row { display: flex; align-items: center; gap: 10px; font-size: 13px; }
  .row label { flex: none; color: var(--q-ink-2); }
  input[type=text] { flex: 1; min-width: 0; height: 30px; padding: 0 8px; border: 1px solid var(--q-line); border-radius: 4px; background: var(--q-sunken); color: var(--q-ink); font-size: 13px; }
  input[type=range] { flex: 1; min-width: 60px; margin: 0; accent-color: var(--q-accent); }
  input:focus-visible { outline: 2px solid var(--q-accent); outline-offset: 2px; }
  .value { flex: none; width: 40px; text-align: right; color: var(--q-ink-2); }
  canvas { display: block; width: 100%; height: 220px; border: 1px solid var(--q-line-soft); border-radius: 5px; background: var(--q-surface); }
  #message { margin: 0; min-height: 17px; font-size: 12px; line-height: 1.4; color: var(--q-st-question); }
  .hint { margin: 0; font-size: 12px; color: var(--q-ink-3); }
  @media (max-width: 460px) { .range { flex-wrap: wrap; } }
</style>

<div class="wrap">
  <div class="row mono">
    <label for="expr">f(x) =</label>
    <input id="expr" type="text" value="sin(3 * x) * exp(-x * x / 8)" spellcheck="false" autocomplete="off" aria-describedby="hint">
  </div>
  <canvas id="plot" role="img" aria-label="Plot of f(x)"></canvas>
  <div class="row range mono">
    <label for="from">x from</label>
    <input id="from" type="range" min="-20" max="20" step="0.5" value="-6">
    <span class="value" id="fromValue"></span>
    <label for="to">to</label>
    <input id="to" type="range" min="-20" max="20" step="0.5" value="6">
    <span class="value" id="toValue"></span>
  </div>
  <p id="message" role="status"></p>
  <p class="hint" id="hint">A JavaScript expression in x. Math is in scope: sin(x), exp(-x * x), PI, x ** 2, abs(x) &lt; 1 ? 1 : 0.</p>
</div>

<script>
  var expr = document.getElementById('expr'), from = document.getElementById('from'), to = document.getElementById('to');
  var canvas = document.getElementById('plot'), ctx = canvas.getContext('2d');
  var PAD = { left: 44, right: 12, top: 10, bottom: 22 };

  function color(name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); }
  function say(text) { document.getElementById('message').textContent = text; }
  function label(v) { return String(+v.toPrecision(3)); }

  // A round step that gives about five ticks across the span.
  function step(span) {
    var raw = span / 5, pow = Math.pow(10, Math.floor(Math.log10(raw))), m = raw / pow;
    return (m < 1.5 ? 1 : m < 3.5 ? 2 : m < 7.5 ? 5 : 10) * pow;
  }

  function draw() {
    var ratio = window.devicePixelRatio || 1, w = canvas.clientWidth, h = canvas.clientHeight;
    canvas.width = Math.round(w * ratio);
    canvas.height = Math.round(h * ratio);
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.clearRect(0, 0, w, h);
    var x0 = +from.value, x1 = +to.value;
    document.getElementById('fromValue').textContent = label(x0);
    document.getElementById('toValue').textContent = label(x1);
    if (x0 >= x1) return say('Nothing to plot: "x from" has to be less than "to".');

    // The expression is checked and run here; whatever goes wrong is shown as text, not thrown.
    var f, xs = [], ys = [], n = Math.max(200, Math.round(w));
    try {
      f = new Function('x', 'with (Math) { return (' + expr.value + '\n); }');
      for (var i = 0; i <= n; i++) {
        var x = x0 + (x1 - x0) * i / n, y = Number(f(x));
        xs.push(x);
        ys.push(isFinite(y) ? y : NaN);
      }
    } catch (error) {
      return say('This expression cannot be plotted: ' + (error && error.message ? error.message : error));
    }
    var finite = ys.filter(function (y) { return y === y; }).sort(function (a, b) { return a - b; });
    if (!finite.length) return say('f(x) has no finite value in this range.');
    say('');

    // The y range: all values, except that rare spikes (a pole of tan x) do not flatten the rest.
    var lo = finite[Math.floor(finite.length * 0.02)], hi = finite[Math.ceil(finite.length * 0.98) - 1];
    var y0 = Math.max(finite[0], lo - (hi - lo) * 1.5), y1 = Math.min(finite[finite.length - 1], hi + (hi - lo) * 1.5);
    if (y1 - y0 < 1e-12) { y0 -= 1; y1 += 1; }
    var margin = (y1 - y0) * 0.08;
    y0 -= margin; y1 += margin;

    var pw = w - PAD.left - PAD.right, ph = h - PAD.top - PAD.bottom;
    function X(x) { return PAD.left + (x - x0) / (x1 - x0) * pw; }
    function Y(y) { return PAD.top + (y1 - y) / (y1 - y0) * ph; }
    function rule(ax, ay, bx, by, stroke) {
      ctx.strokeStyle = stroke; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(Math.round(ax) + 0.5, Math.round(ay) + 0.5); ctx.lineTo(Math.round(bx) + 0.5, Math.round(by) + 0.5); ctx.stroke();
    }

    // Grid with numbers, then the two axes where they are in view.
    var soft = color('--q-line-soft'), sx = step(x1 - x0), sy = step(y1 - y0), t;
    ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
    ctx.fillStyle = color('--q-ink-3');
    ctx.textBaseline = 'top'; ctx.textAlign = 'center';
    for (t = Math.ceil(x0 / sx) * sx; t <= x1 + sx * 1e-9; t += sx) {
      rule(X(t), PAD.top, X(t), PAD.top + ph, soft);
      ctx.fillText(label(Math.abs(t) < sx * 1e-9 ? 0 : t), X(t), PAD.top + ph + 6);
    }
    ctx.textBaseline = 'middle'; ctx.textAlign = 'right';
    for (t = Math.ceil(y0 / sy) * sy; t <= y1 + sy * 1e-9; t += sy) {
      rule(PAD.left, Y(t), PAD.left + pw, Y(t), soft);
      ctx.fillText(label(Math.abs(t) < sy * 1e-9 ? 0 : t), PAD.left - 6, Y(t));
    }
    var axis = color('--q-ink-3');
    if (y0 <= 0 && y1 >= 0) rule(PAD.left, Y(0), PAD.left + pw, Y(0), axis);
    if (x0 <= 0 && x1 >= 0) rule(X(0), PAD.top, X(0), PAD.top + ph, axis);

    // The curve, broken where f(x) is not a finite number, clipped to the plot area.
    ctx.save();
    ctx.beginPath(); ctx.rect(PAD.left, PAD.top, pw, ph); ctx.clip();
    ctx.strokeStyle = color('--q-accent'); ctx.lineWidth = 1.8; ctx.lineJoin = 'round';
    ctx.beginPath();
    var pen = false;
    for (var k = 0; k < xs.length; k++) {
      if (ys[k] !== ys[k]) { pen = false; continue; }
      if (pen) ctx.lineTo(X(xs[k]), Y(ys[k])); else ctx.moveTo(X(xs[k]), Y(ys[k]));
      pen = true;
    }
    ctx.stroke();
    ctx.restore();
  }

  expr.addEventListener('input', draw);
  from.addEventListener('input', draw);
  to.addEventListener('input', draw);
  window.addEventListener('resize', draw);
  draw();
</script>
`
