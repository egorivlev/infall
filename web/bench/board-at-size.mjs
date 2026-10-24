// The Board at size, measured in a real browser (docs/specs/scale.md). Starts Chrome for Testing (the copy Playwright
// keeps in ~/Library/Caches/ms-playwright; set CHROME to another binary) with a throwaway profile, drives it over the
// DevTools protocol against a Local Workspace served by `big_workspace serve`, and prints what it measured as JSON
// (and each number on stderr as it comes). No dependencies: Node 22 or later.
//
//   node web/bench/board-at-size.mjs <entry URL> <long Page Card id> [label] [open Branch name]
//
// HEADLESS=1 runs it without a window: use it when the machine may hide or sleep the window (a hidden window gets
// no frames, and every step then times out). EXPERIMENT=wc|layers|trace measures one thing about panning instead.
import { spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const [entry, longCard, label = 'run', openBranch] = process.argv.slice(2)
const CHROME = process.env.CHROME ?? `${process.env.HOME}/Library/Caches/ms-playwright/chromium-1243/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`
const PORT = 9300 + Math.floor(Math.random() * 600)
const profile = mkdtempSync(join(process.env.BENCH_TMP ?? tmpdir(), 'prof-'))
const chrome = spawn(CHROME, [
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
  '--window-size=1440,900', '--window-position=40,40', '--disable-background-timer-throttling',
  '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows', ...(process.env.HEADLESS ? ['--headless=new'] : []), 'about:blank',
], { stdio: 'ignore' })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let targets
for (let i = 0; i < 100; i++) {
  try { targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json(); if (targets.some((t) => t.type === 'page')) break } catch {}
  await sleep(100)
}
const page = targets.find((t) => t.type === 'page')
const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((r) => ws.addEventListener('open', r))
let nextId = 1
const pending = new Map()
const listeners = []
ws.addEventListener('message', (m) => {
  const msg = JSON.parse(m.data)
  if (msg.id && pending.has(msg.id)) { const { res, rej } = pending.get(msg.id); pending.delete(msg.id); if (msg.error) rej(new Error(JSON.stringify(msg.error))); else res(msg.result) }
  else listeners.forEach((l) => l(msg))
})
const send = (method, params = {}) => new Promise((res, rej) => { const id = nextId++; pending.set(id, { res, rej }); ws.send(JSON.stringify({ id, method, params })); setTimeout(() => { if (pending.has(id)) { pending.delete(id); console.error('CDP timeout', method); res({ result: {} }) } }, 20000) })
const ev = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? JSON.stringify(r.exceptionDetails))
  return r.result.value
}
const waitFor = async (expr, timeout = 60000) => {
  const t = Date.now()
  while (Date.now() - t < timeout) { if (await ev(expr).catch(() => false)) return Date.now() - t; await sleep(20) }
  throw new Error(`timed out: ${expr}`)
}
const frame = () => ev('new Promise(r => requestAnimationFrame(() => setTimeout(() => r(performance.now()))))')

// In-page instruments: long tasks, and a frame recorder.
const INSTR = `
  window.__lt = []
  new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__lt.push({ s: e.startTime, d: e.duration }) }).observe({ type: 'longtask', buffered: true })
  window.__rec = { on: false, ts: [] }
  window.__startRec = () => { const r = window.__rec; r.on = true; r.ts = []; const f = (t) => { if (!r.on) return; r.ts.push(t); requestAnimationFrame(f) }; requestAnimationFrame(f); window.__ltMark = performance.now() }
  window.__stopRec = () => { const r = window.__rec; r.on = false; const ts = r.ts; const d = []; for (let i = 1; i < ts.length; i++) d.push(ts[i] - ts[i-1]); d.sort((a,b)=>a-b)
    const span = ts.length > 1 ? ts[ts.length-1] - ts[0] : 0
    const lt = window.__lt.filter(e => e.s >= window.__ltMark)
    return { fps: span ? (ts.length - 1) / span * 1000 : 0, p50: d[Math.floor(d.length*0.5)] ?? 0, p95: d[Math.floor(d.length*0.95)] ?? 0, max: d[d.length-1] ?? 0, frames: ts.length, longTasks: lt.length, longestTask: Math.max(0, ...lt.map(e=>e.d)) } }
`
await send('Page.enable')
await send('Runtime.enable')
await send('Network.enable')
await send('Page.addScriptToEvaluateOnNewDocument', { source: INSTR })
let bytes = 0
listeners.push((m) => { if (m.method === 'Network.loadingFinished') bytes += m.params.encodedDataLength })
await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 860, deviceScaleFactor: 0, mobile: false }).catch(() => {})

const out = new Proxy({ label }, { set(o, k, v) { o[k] = v; console.error(k, JSON.stringify(v)); return true } })
const t0 = Date.now()
await send('Page.navigate', { url: entry })
await waitFor(`document.querySelectorAll('.react-flow__node-card').length > 0`, 120000)
out.firstBoardMs = Date.now() - t0
// "Interactive": the first moment after which 500 ms pass with no long task.
const tti = await ev(`new Promise((res) => { const t0 = performance.timeOrigin; let last = performance.now();
  const check = () => { const lt = window.__lt; const end = lt.length ? lt[lt.length-1].s + lt[lt.length-1].d : 0; if (performance.now() - Math.max(end, last) > 500) res(Math.max(end, last)); else setTimeout(check, 50) }
  last = performance.now(); check() })`)
out.interactiveMs = Math.round(tti) // from navigation start of the board page (after the entry redirect)
out.loadLongTasks = await ev(`window.__lt.map(e => Math.round(e.d))`)
out.loadBytes = bytes
out.nodesInDom = await ev(`document.querySelectorAll('.react-flow__node').length`)
out.edgesInDom = await ev(`document.querySelectorAll('.react-flow__edge').length`)

const zoomNow = () => ev(`(() => { const m = /scale\\(([\\d.]+)\\)/.exec(document.querySelector('.react-flow__viewport').style.transform); return m ? +m[1] : 0 })()`)
const CX = 720, CY = 450
const wheel = (dx, dy, mods = 0) => send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: CX, y: CY, deltaX: dx, deltaY: dy, modifiers: mods })
async function zoomTo(target) {
  const t0 = Date.now()
  for (let i = 0; i < 200 && Date.now() - t0 < 15000; i++) {
    const z = await zoomNow()
    if (Math.abs(Math.log(z / target)) < 0.08) return z
    await wheel(0, z < target ? -8 : 8, 2 /* ctrl */)
    await frame()
  }
  return zoomNow()
}
async function pan(ms = 2500) {
  await ev('window.__startRec()')
  const t = Date.now(); let i = 0
  while (Date.now() - t < ms) { await wheel(i % 40 < 20 ? 12 : -12, i % 30 < 15 ? 6 : -6); i++; await sleep(16) }
  await frame()
  return ev('window.__stopRec()')
}
async function zoomBurst(ms = 2000) {
  await ev('window.__startRec()')
  const t = Date.now(); let i = 0
  while (Date.now() - t < ms) { await wheel(0, i % 40 < 20 ? -20 : 20, 2); i++; await sleep(16) }
  await frame()
  return ev('window.__stopRec()')
}

if (process.env.EXPERIMENT === 'layers') {
  out.svgs = await ev(`document.querySelectorAll('svg').length`)
  out.labels = await ev(`document.querySelectorAll('.qb-conn-label').length`)
  let layers = null
  listeners.push((m) => { if (m.method === 'LayerTree.layerTreeDidChange' && m.params.layers) layers = m.params.layers })
  await send('LayerTree.enable')
  await pan(500)
  await sleep(500)
  out.layerCount = layers?.length
  const reasons = {}
  for (const l of (layers ?? []).slice(0, 400)) {
    const r = await send('LayerTree.compositingReasons', { layerId: l.layerId }).catch(() => null)
    for (const x of r?.compositingReasonIds ?? r?.compositingReasons ?? []) reasons[x] = (reasons[x] ?? 0) + 1
  }
  out.reasons = reasons
  console.log(JSON.stringify({ ...out }, null, 1)); chrome.kill(); process.exit(0)
}
if (process.env.EXPERIMENT === 'trace') {
  const events = []
  listeners.push((m) => { if (m.method === 'Tracing.dataCollected') events.push(...m.params.value) })
  const done = new Promise((r) => listeners.push((m) => { if (m.method === 'Tracing.tracingComplete') r() }))
  await zoomTo(Number(process.env.ZOOM ?? 0.1))
  await sleep(1000)
  await send('Tracing.start', { categories: 'devtools.timeline,blink,cc,gpu,v8.execute,disabled-by-default-devtools.timeline', transferMode: 'ReportEvents' })
  out.pan = await pan(2000)
  await send('Tracing.end')
  await done
  const main = events.filter((e) => e.ph === 'X' && e.dur)
  const agg = {}
  for (const e of main) { const k = e.name; agg[k] = (agg[k] ?? 0) + e.dur / 1000 }
  out.top = Object.entries(agg).sort((a, b) => b[1] - a[1]).slice(0, 25).map(([k, v]) => `${k} ${v.toFixed(0)}`)
  console.log(JSON.stringify({ ...out }, null, 1)); chrome.kill(); process.exit(0)
}
if (process.env.EXPERIMENT) {
  const variants = process.env.EXPERIMENT === 'wc' ? { asis: '', willChange: '.react-flow__viewport { will-change: transform }', asis2: '' } : { asis: '', noEdges: '.react-flow__edges, .react-flow__edgelabel-renderer { display: none !important }', noNodes: '.react-flow__nodes { display: none !important }', noBoth: '.react-flow__edges, .react-flow__nodes, .react-flow__edgelabel-renderer { display: none !important }', noBg: '.react-flow__background { display: none !important }' }
  for (const [name, css] of Object.entries(variants)) {
    await ev(`(() => { let st = document.getElementById('__exp'); if (!st) { st = document.createElement('style'); st.id = '__exp'; document.head.append(st) } st.textContent = ${JSON.stringify(css)} })()`)
    await sleep(500)
    out['pan_' + name] = await pan(2000)
    out['zoom_' + name] = await zoomBurst(2000)
  }
  console.log(JSON.stringify({ ...out }, null, 1)); chrome.kill(); process.exit(0)
}
out.fitZoom = await zoomNow()
out.panAtFit = await pan()
out.nodesInDomAtFit = await ev(`document.querySelectorAll('.react-flow__node').length`)
out.zoomAtFit = await zoomBurst()
// Over Cards, not empty canvas: search for a common word and take the first match.
async function centreOnCards() {
  await ev(`document.querySelector('input[placeholder="Search Cards"]').focus()`)
  await send('Input.insertText', { text: 'Pilot' })
  await sleep(300)
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
  await sleep(800)
}
await centreOnCards()
out.centred = await ev(`({ vp: document.querySelector('.react-flow__viewport').style.transform, sel: document.querySelectorAll('.qb-card.is-selected').length, nodes: document.querySelectorAll('.react-flow__node-card').length })`)
for (const z of [0.3, 0.6, 1.0]) {
  await ev('window.__lt.length = 0')
  const got = await zoomTo(z)
  out[`zoomingTo@${z}LongTasks`] = await ev('window.__lt.map(e => Math.round(e.d))')
  await sleep(300)
  const before = await ev(`({ nodes: document.querySelectorAll('.react-flow__node-card').length, edges: document.querySelectorAll('.react-flow__edge').length })`)
  out[`pan@${z}`] = { zoom: +got.toFixed(2), ...before, ...(await pan()) }
}
// At 100%: click a Card, then drag it.
// Bring Cards into view the way a person would: search, Enter.
await ev(`document.querySelector('input[placeholder="Search Cards"]').focus()`)
await send('Input.insertText', { text: 'Pilot' })
await sleep(300)
await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
await sleep(800)
const cardBox = await ev(`(() => { const els = [...document.querySelectorAll('.react-flow__node-card:not(.selected)')]
  for (const el of els) { const r = el.getBoundingClientRect(); const x = r.left + r.width / 2, y = r.top + r.height * 0.75
    if (x < 300 || y < 150 || x > innerWidth - 400 || y > innerHeight - 150) continue
    const hit = document.elementFromPoint(x, y)?.closest('.react-flow__node-card'); if (hit === el) return { id: el.dataset.id, x, y } }
  return null })()`)
out.clickedCard = cardBox
await ev(`window.__lt.length = 0; window.__clickWatch = new Promise(res => { const id = ${JSON.stringify(cardBox?.id)}; const t = performance.now(); const tick = () => document.querySelector('[data-id="' + id + '"] .qb-card.is-selected') ? res(performance.now() - t) : performance.now() - t > 15000 ? res(-1) : requestAnimationFrame(tick); tick() }); 0`)
await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: cardBox.x, y: cardBox.y, button: 'left', clickCount: 1 })
await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: cardBox.x, y: cardBox.y, button: 'left', clickCount: 1 })
out.selectMs = Math.round(await ev('window.__clickWatch'))
await sleep(300)
await ev('window.__startRec()')
await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: cardBox.x, y: cardBox.y, button: 'left', clickCount: 1 })
for (let i = 1; i <= 60; i++) { await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: cardBox.x + i * 3, y: cardBox.y + i, button: 'left', buttons: 1 }); await sleep(16) }
const tDrop = Date.now()
await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: cardBox.x + 180, y: cardBox.y + 60, button: 'left', clickCount: 1 })
await frame()
out.dropToFrameMs = Date.now() - tDrop
out.drag = await ev('window.__stopRec()')
await sleep(500)

// Search: type a word one key at a time; time to the next frame after each key.
await ev(`document.querySelector('input[placeholder="Search Cards"]').focus()`)
const keyTimes = []
await ev('window.__lt.length = 0; window.__ltMark = 0')
for (const ch of 'replication') { const t = Date.now(); await send('Input.insertText', { text: ch }); await frame(); keyTimes.push(Date.now() - t) }
out.searchKeyMs = { max: Math.max(...keyTimes), mean: +(keyTimes.reduce((a, b) => a + b, 0) / keyTimes.length).toFixed(1) }
out.searchResults = await ev(`document.querySelectorAll('.q-search__list [role=option]').length`)
out.searchLongTasks = await ev('window.__lt.map(e => Math.round(e.d))')
await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
await ev(`document.activeElement.blur(); document.querySelector('.qb-board').focus()`)

// The long Page: select its Card through the bridge-free way (click its node after focusing it via search would move
// the view); here: dispatch a double click on its node once it is in view, else open by keyboard after selecting.
if (longCard) {
  await ev('window.__lt.length = 0')
  const t = Date.now()
  await ev(`(async () => { const input = document.querySelector('input[placeholder="Search Cards"]'); input.focus() })()`)
  const title = 'Lab notebook 1'
  await send('Input.insertText', { text: title })
  await frame()
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
  await waitFor(`!!document.querySelector('[data-id="${longCard}"] .qb-card.is-selected')`, 10000).catch(() => null)
  await sleep(600)
  await ev(`window.__lt.length = 0; document.querySelector('.qb-board').focus()`)
  const t1 = Date.now()
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'o', code: 'KeyO', text: 'o', windowsVirtualKeyCode: 79 })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'o', code: 'KeyO', windowsVirtualKeyCode: 79 })
  await waitFor(`document.querySelectorAll('.qp-panel .qp-block').length > 100`, 30000)
  await frame()
  out.openLongPageMs = Date.now() - t1
  out.openLongPageBlocks = await ev(`document.querySelectorAll('.qp-panel .qp-block').length`)
  out.openLongPageLongTasks = await ev('window.__lt.map(e => Math.round(e.d))')
  void t
  // Typing in its tenth Block.
  await sleep(500)
  await ev(`(() => { const v = document.querySelectorAll('.qp-panel .qp-block__view.is-editable')[10]; v.scrollIntoView({ block: 'center' }); v.click() })()`)
  await waitFor(`!!document.querySelector('.qp-panel .qp-block.is-editing textarea')`, 5000)
  await ev(`(() => { const ta = document.querySelector('.qp-panel .qp-block.is-editing textarea'); ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length) })()`)
  await ev('window.__lt.length = 0')
  const typed = []
  for (const ch of ' and then a few more words typed here.') { const t = Date.now(); await send('Input.insertText', { text: ch }); await frame(); typed.push(Date.now() - t) }
  await sleep(1500) // a save goes out
  out.pageKeyMs = { max: Math.max(...typed), mean: +(typed.reduce((a, b) => a + b, 0) / typed.length).toFixed(1) }
  out.pageTypingLongTasks = await ev('window.__lt.map(e => Math.round(e.d))')
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  await sleep(300)
  await ev(`document.querySelector('[aria-label^="Close"]')?.click()`)
  await sleep(500)
}

// History: open it and wait for its counts.
await ev('window.__lt.length = 0')
const th = Date.now()
await ev(`document.querySelector('[data-tour="history"]').click()`)
await waitFor(`(document.querySelector('[data-testid="history-counts"]')?.textContent ?? '').trim().length > 0 && !document.querySelector('.qh-panel [aria-busy="true"]')`, 120000)
await frame()
out.historyOpenMs = Date.now() - th
out.historyLongTasks = await ev('window.__lt.map(e => Math.round(e.d))')

if (openBranch) {
  await ev(`document.querySelector('[aria-label="Close History"]')?.click()`)
  await sleep(500)
  await ev('window.__lt.length = 0')
  const tm = Date.now()
  await ev(`history.pushState({}, '', '/merge?from=' + encodeURIComponent(${JSON.stringify(openBranch)}) + '&into=main'); dispatchEvent(new PopStateEvent('popstate')); 0`)
  await waitFor(`!!document.querySelector('.q-merge__head')`, 120000)
  await frame()
  out.mergeReviewMs = Date.now() - tm
  out.mergeLongTasks = await ev('window.__lt.map(e => Math.round(e.d))')
}
console.log(JSON.stringify({ ...out }, null, 1))
ws.close()
chrome.kill()
process.exit(0)
