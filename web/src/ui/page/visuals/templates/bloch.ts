// Starter: one qubit on the Bloch sphere (after design/QPage.dc.html). Plain HTML for the Visual
// frame — no backticks or "${" inside.
export const BLOCH = String.raw`<style>
  .wrap { display: grid; grid-template-columns: minmax(160px, 240px) 1fr; gap: 20px; align-items: center; padding: 16px 18px 18px; }
  @media (max-width: 460px) { .wrap { grid-template-columns: 1fr; justify-items: center; } .side { width: 100%; } }
  svg { display: block; width: 100%; max-width: 240px; height: auto; overflow: visible; }
  .mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
  .sphere { fill: var(--q-accent-soft); fill-opacity: .3; stroke: var(--q-ink-2); stroke-width: 1.1; }
  .ring { fill: none; stroke: var(--q-ink-3); stroke-width: 1; stroke-opacity: .9; }
  .ring.back { stroke-dasharray: 3 3; stroke-opacity: .6; }
  .axis { stroke: var(--q-ink-3); stroke-width: .8; stroke-opacity: .7; }
  .name { fill: var(--q-ink-2); font-size: 11px; text-anchor: middle; }
  .drop { stroke: var(--q-accent); stroke-width: 1; stroke-dasharray: 3 3; stroke-opacity: .7; }
  .state { stroke: var(--q-accent); stroke-width: 2.2; }
  .tip { fill: var(--q-accent); }
  .origin { fill: var(--q-ink-2); }
  .side { display: flex; flex-direction: column; gap: 14px; min-width: 0; }
  .angle { display: grid; grid-template-columns: 22px 1fr 44px; align-items: center; gap: 10px; font-size: 13px; }
  .angle label { font-size: 15px; font-style: italic; }
  .angle span { text-align: right; color: var(--q-ink-2); }
  input[type=range] { width: 100%; margin: 0; accent-color: var(--q-accent); }
  input:focus-visible { outline: 2px solid var(--q-accent); outline-offset: 3px; }
  .psi { margin: 0; padding: 10px 12px; border-radius: 5px; background: var(--q-sunken); font-size: 13px; }
  .means { margin: 0; display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; font-size: 12px; color: var(--q-ink-2); }
</style>

<div class="wrap">
  <svg id="sphere" viewBox="0 0 240 240" role="img" aria-label="Bloch sphere with the state vector"></svg>
  <div class="side">
    <div class="angle mono">
      <label for="theta">θ</label>
      <input id="theta" type="range" min="0" max="180" step="1" value="62" aria-label="theta, the polar angle, in degrees">
      <span id="thetaValue"></span>
    </div>
    <div class="angle mono">
      <label for="phi">φ</label>
      <input id="phi" type="range" min="0" max="360" step="1" value="110" aria-label="phi, the azimuth, in degrees">
      <span id="phiValue"></span>
    </div>
    <p class="psi mono" id="psi"></p>
    <p class="means mono"><span id="ex"></span><span id="ey"></span><span id="ez"></span></p>
  </div>
</div>

<script>
  var S = 240, c = S / 2, R = 92;
  var az = 35 * Math.PI / 180, el = 18 * Math.PI / 180; // where the sphere is looked at from

  // A point in space (z up) to the drawing: [x, y, depth towards the viewer].
  function P(x, y, z) {
    var sx = -x * Math.sin(az) + y * Math.cos(az);
    var sy = -x * Math.sin(el) * Math.cos(az) - y * Math.sin(el) * Math.sin(az) + z * Math.cos(el);
    var depth = x * Math.cos(el) * Math.cos(az) + y * Math.cos(el) * Math.sin(az) + z * Math.sin(el);
    return [c + R * sx, c - R * sy, depth];
  }

  // The front (solid) or back (dashed) part of a great circle, as polylines.
  function ring(point, back) {
    var out = '', pts = [];
    function flush() {
      if (pts.length > 1) out += '<polyline class="ring' + (back ? ' back' : '') + '" points="' + pts.join(' ') + '"/>';
      pts = [];
    }
    for (var k = 0; k <= 90; k++) {
      var p = point(k / 90 * 2 * Math.PI);
      if (back ? p[2] < 0 : p[2] >= 0) pts.push(p[0].toFixed(1) + ',' + p[1].toFixed(1)); else flush();
    }
    flush();
    return out;
  }
  function equator(t) { return P(Math.cos(t), Math.sin(t), 0); }
  function meridian(t) { return P(Math.cos(t), 0, Math.sin(t)); }
  function line(cls, a, b) {
    return '<line class="' + cls + '" x1="' + a[0].toFixed(1) + '" y1="' + a[1].toFixed(1) + '" x2="' + b[0].toFixed(1) + '" y2="' + b[1].toFixed(1) + '"/>';
  }

  var theta = document.getElementById('theta'), phi = document.getElementById('phi');
  var o = P(0, 0, 0);
  var axes = [[1, 0, 0, 'x'], [0, 1, 0, 'y'], [0, 0, 1, '|0⟩'], [0, 0, -1, '|1⟩']];

  function draw() {
    var t = theta.value * Math.PI / 180, p = phi.value * Math.PI / 180;
    var v = [Math.sin(t) * Math.cos(p), Math.sin(t) * Math.sin(p), Math.cos(t)]; // (⟨X⟩, ⟨Y⟩, ⟨Z⟩)
    var tip = P(v[0], v[1], v[2]), foot = P(v[0], v[1], 0);

    var svg = '<circle class="sphere" cx="' + c + '" cy="' + c + '" r="' + R + '"/>';
    svg += ring(equator, true) + ring(meridian, true) + ring(equator, false) + ring(meridian, false);
    axes.forEach(function (a) {
      var label = P(a[0] * 1.18, a[1] * 1.18, a[2] * 1.18);
      svg += line('axis', o, P(a[0], a[1], a[2]));
      svg += '<text class="name mono" x="' + label[0].toFixed(1) + '" y="' + (label[1] + 4).toFixed(1) + '">' + a[3] + '</text>';
    });
    svg += line('drop', o, foot) + line('drop', foot, tip) + line('state', o, tip);
    svg += '<circle class="tip" cx="' + tip[0].toFixed(1) + '" cy="' + tip[1].toFixed(1) + '" r="4.5"/>';
    svg += '<circle class="origin" cx="' + o[0] + '" cy="' + o[1] + '" r="2"/>';
    document.getElementById('sphere').innerHTML = svg;

    function f(x) { return (Math.abs(x) < 0.005 ? 0 : x).toFixed(2); }
    document.getElementById('thetaValue').textContent = theta.value + '°';
    document.getElementById('phiValue').textContent = phi.value + '°';
    theta.setAttribute('aria-valuetext', theta.value + ' degrees');
    phi.setAttribute('aria-valuetext', phi.value + ' degrees');
    document.getElementById('psi').innerHTML = '|ψ⟩ = ' + Math.cos(t / 2).toFixed(3) + ' |0⟩ + e<sup>i ' + p.toFixed(2) + '</sup> ' + Math.sin(t / 2).toFixed(3) + ' |1⟩';
    document.getElementById('ex').textContent = '⟨X⟩ = ' + f(v[0]);
    document.getElementById('ey').textContent = '⟨Y⟩ = ' + f(v[1]);
    document.getElementById('ez').textContent = '⟨Z⟩ = ' + f(v[2]);
  }

  theta.addEventListener('input', draw);
  phi.addEventListener('input', draw);
  // The drawing is SVG with a viewBox: it scales with the width by itself. Drawing again on
  // resize keeps the pattern for Visuals that measure the width.
  window.addEventListener('resize', draw);
  draw();
</script>
`
