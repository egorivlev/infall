// Loaded by index.html in <head>, synchronously, before the first paint (a same-origin file: the server's CSP,
// `default-src 'self'`, refuses an inline script). The theme and scales from this device's settings
// (ui/settings/prefs.ts, key "infall-settings"), so a light theme or a larger interface never flashes in as dark or
// 100%. The app applies the same settings again once it has loaded; anything unreadable here is simply left to it.
try {
  var s = JSON.parse(localStorage.getItem('infall-settings') || 'null')
  var t = s && s.v === 1 ? s.theme : localStorage.getItem('qoop-theme')
  if (t === 'system') t = matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'
  if (t === 'light' || t === 'dark') document.documentElement.setAttribute('data-theme', t)
  if (s && s.v === 1) {
    var r = document.documentElement.style
    if ([80, 90, 100, 110, 125, 150].indexOf(s.interfaceScale) >= 0) {
      r.setProperty('--q-ui-zoom', s.interfaceScale / 100)
      r.setProperty('--q-ui-unzoom', 100 / s.interfaceScale)
    }
    if ([85, 90, 100, 110, 120, 130].indexOf(s.textSize) >= 0) r.setProperty('--q-text', s.textSize / 100)
  }
} catch {}
// The room the interface has (ui/settings/apply.ts, applyRoom): the window in zoomed pixels, so the rail and the
// AI sidebar are laid out right from the first paint.
try {
  var d = document.documentElement
  var k = 1 / (parseFloat(d.style.getPropertyValue('--q-ui-zoom')) || 1)
  var w = d.clientWidth * k
  d.setAttribute('data-room', w >= 1100 ? 'wide' : w >= 900 ? 'medium' : 'narrow')
  d.style.setProperty('--q-vw', Math.floor(w) + 'px')
  d.style.setProperty('--q-vh', Math.floor(d.clientHeight * k) + 'px')
} catch {}
