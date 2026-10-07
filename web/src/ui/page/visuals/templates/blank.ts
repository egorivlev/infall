// Starter: a commented skeleton. Plain HTML for the Visual frame — no backticks or "${" inside.
export const BLANK = String.raw`<!--
  A Visual is plain HTML, CSS and JavaScript that runs in a sandbox:
  no network, no external files, no access to Qoop. Everything it needs is in this source.

  Colours: use the --q-* variables, so the Visual follows the light and the dark theme.
    --q-ink  --q-ink-2  --q-ink-3                      text, from strong to quiet
    --q-line  --q-line-soft                            rules and borders
    --q-accent  --q-accent-soft  --q-accent-ink        the one highlight colour
    --q-surface  --q-raised  --q-sunken  --q-hover     backgrounds
    --q-st-idea  --q-st-reading  --q-st-understood  --q-st-question  --q-st-dead
    --q-danger
-->
<style>
  .wrap { padding: 16px 18px 18px; }
  canvas { display: block; width: 100%; height: 180px; border: 1px solid var(--q-line-soft); border-radius: 5px; }
  p { margin: 10px 0 0; font-size: 12px; line-height: 1.45; color: var(--q-ink-3); }
</style>

<div class="wrap">
  <canvas id="view" role="img" aria-label="An empty drawing area with a diagonal and a dot"></canvas>
  <p>Draw in draw(), or replace the canvas with your own HTML or SVG.</p>
</div>

<script>
  var canvas = document.getElementById('view');
  var ctx = canvas.getContext('2d');

  // In CSS write var(--q-ink). A canvas needs the value itself:
  function color(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  }

  function draw() {
    // Size the bitmap to the element, so lines stay sharp at any width and pixel density.
    var ratio = window.devicePixelRatio || 1;
    var w = canvas.clientWidth, h = canvas.clientHeight;
    canvas.width = Math.round(w * ratio);
    canvas.height = Math.round(h * ratio);
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.clearRect(0, 0, w, h);

    // Your drawing goes here. Coordinates are CSS pixels: (0, 0) is the top left corner.
    ctx.strokeStyle = color('--q-ink-3');
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(16, h - 16);
    ctx.lineTo(w - 16, 16);
    ctx.stroke();

    ctx.fillStyle = color('--q-accent');
    ctx.beginPath();
    ctx.arc(w / 2, h / 2, 5, 0, 2 * Math.PI);
    ctx.fill();
  }

  // The Visual is as wide as the Page: draw again when that changes.
  window.addEventListener('resize', draw);
  draw();
</script>
`
