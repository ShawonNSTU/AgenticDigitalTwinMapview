// Usage (web app running): npm i puppeteer-core; B=http://localhost:3000 OUT=/tmp/ui node tools/ui_audit.js
// Needs Google Chrome at /usr/bin/google-chrome (edit executablePath for another browser).
// UI audit: every page and state at desktop, tablet and phone sizes. Finds wrapped one-line controls, clipped text,
// overlays off-screen or on top of each other, uneven control heights in a row, page-level sideways scroll.
// The 3D iframe is stubbed (renderer events are injected) so layout is checked fast and deterministically;
// a separate run checks the real 3D on a tablet.
const puppeteer = require('puppeteer-core');
const fs = require('fs');
const wait = ms => new Promise(r => setTimeout(r, ms));
const B = process.env.B || 'http://localhost:3000';
const OUT = process.env.OUT || '/tmp/ui';
fs.mkdirSync(OUT, { recursive: true });
const ONLY = process.env.ONLY ? new RegExp(process.env.ONLY) : null;

const VIEWS = [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'laptop', width: 1280, height: 720 },
  { name: 'ipadpro-land', width: 1366, height: 1024, touch: true },
  { name: 'ipad-land', width: 1180, height: 820, touch: true },
  { name: 'ipad-port', width: 820, height: 1180, touch: true },
  { name: 'tab-port', width: 768, height: 1024, touch: true },
  { name: 'phone', width: 390, height: 844, touch: true, phone: true },
];

// in-page checks
const CHECK = () => {
  const out = [];
  const vis = el => { if (el.closest('details:not([open]) > :not(summary)')) return false; const r = el.getBoundingClientRect(); const cs = getComputedStyle(el); return r.width > 1 && r.height > 1 && cs.visibility !== 'hidden' && cs.display !== 'none' && +cs.opacity > 0.05 && !el.closest('[aria-hidden="true"]'); };
  const name = el => { const p = []; let e = el; for (let i = 0; i < 3 && e && e !== document.body; i++, e = e.parentElement) p.unshift(e.tagName.toLowerCase() + (e.classList.length ? '.' + [...e.classList].slice(0, 2).join('.') : '')); const t = (el.innerText || el.value || '').trim().replace(/\s+/g, ' ').slice(0, 40); return p.join(' > ') + (t ? ` "${t}"` : ''); };
  // lines of text: a new line starts only when a box starts below the previous line (mixed font sizes and icons on one line count once)
  const lines = el => { const r = document.createRange(); r.selectNodeContents(el); const rs = [...r.getClientRects()].filter(x => x.width > 2 && x.height > 4).sort((a, b) => a.top - b.top); let n = 0, bottom = -1e9; for (const x of rs) { if (x.top >= bottom - 2) { n++; bottom = x.bottom; } else bottom = Math.max(bottom, x.bottom); } return n; };
  const inScroll = el => { for (let e = el.parentElement; e; e = e.parentElement) { const cs = getComputedStyle(e); if (/(auto|scroll)/.test(cs.overflowY + cs.overflowX) && (e.scrollHeight > e.clientHeight + 1 || e.scrollWidth > e.clientWidth + 1)) return e; } return null; };
  const W = innerWidth, H = innerHeight;
  // 1. one-line controls that wrap
  for (const el of document.querySelectorAll('button, select, .stat, .state-chip, .eta-chip, .badge, .chip, .ready-chip, .floor-chip, .tabs button, .seg button, .eco-tag, .st-tag, .sim-tag, em.st')) {
    if (!vis(el)) continue;
    const t = (el.innerText || '').trim();
    if (!t || t.length < 3 || el.matches('.fault-opt') || el.closest('.ag-tasks, .ag-sugg, .story-rail, .stepper, .part, .alert-row, .dev-row, .comfort-row, .ops-row')) continue;
    if (el.tagName === 'SELECT') { if (el.scrollWidth > el.clientWidth + 2) out.push({ kind: 'select-clipped', el: name(el) }); continue; }
    if (lines(el) > 1) out.push({ kind: 'wrapped', el: name(el), h: Math.round(el.getBoundingClientRect().height) });
  }
  // 2. text cut off without an ellipsis (content wider than its box, and the box clips)
  for (const el of document.querySelectorAll('body *')) {
    if (!vis(el) || el.children.length > 3 || ['svg', 'path', 'canvas', 'iframe', 'input', 'textarea', 'select', 'option', 'img', 'html'].includes(el.tagName.toLowerCase())) continue;
    const cs = getComputedStyle(el);
    if (cs.overflowX === 'visible' || /(auto|scroll)/.test(cs.overflowX)) continue;
    if (el.scrollWidth > el.clientWidth + 2 && (el.innerText || '').trim() && cs.textOverflow !== 'ellipsis') out.push({ kind: 'clipped', el: name(el), over: el.scrollWidth - el.clientWidth });
  }
  // 3. text that spills out of its box (overflow visible) over a neighbour
  for (const el of document.querySelectorAll('b, small, span, em, h1, h2, h3, p, label, a, li, dt, dd')) {
    if (!vis(el) || el.children.length) continue;
    const p = el.parentElement; if (!p || !vis(p)) continue;
    const r = el.getBoundingClientRect(), q = p.getBoundingClientRect(), cs = getComputedStyle(p);
    if (cs.overflow !== 'visible' || cs.display === 'contents') continue;
    if (r.right > q.right + 3 || r.left < q.left - 3) out.push({ kind: 'spills', el: name(el), by: Math.round(Math.max(r.right - q.right, q.left - r.left)) });
  }
  // 4. overlays (absolute / fixed) off the screen or out of their stage
  const overlays = [...document.querySelectorAll('body *')].filter(el => { const cs = getComputedStyle(el); return (cs.position === 'absolute' || cs.position === 'fixed') && vis(el) && el.getBoundingClientRect().width > 40 && el.getBoundingClientRect().height > 20 && !el.matches('iframe, .twin, canvas') && !el.closest('.modal-back') && !inScroll(el); });
  for (const el of overlays) {
    const r = el.getBoundingClientRect();
    const stage = el.closest('.stage, .guest-stage, .story-stage');
    const box = stage && stage !== el ? stage.getBoundingClientRect() : { left: 0, top: 0, right: W, bottom: H };
    if (r.left < box.left - 1 || r.top < box.top - 1 || r.right > box.right + 1 || r.bottom > box.bottom + 1) out.push({ kind: 'offscreen', el: name(el), r: [r.left, r.top, r.right, r.bottom].map(Math.round), box: [box.left, box.top, box.right, box.bottom].map(Math.round) });
  }
  // 5. overlays covering each other (top-level overlays in the same stage only)
  const tops = overlays.filter(el => !overlays.some(o => o !== el && o.contains(el)) && !el.matches('.toasts, .toast, .loading, .walk-stick, .hint-close, .fs-btn, .fullscreen, .top-menu, .layers-pop, .more-menu > div') && !el.closest('.toasts'));
  for (let i = 0; i < tops.length; i++) for (let j = i + 1; j < tops.length; j++) {
    const a = tops[i].getBoundingClientRect(), b = tops[j].getBoundingClientRect();
    const x = Math.min(a.right, b.right) - Math.max(a.left, b.left), y = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
    if (x > 6 && y > 6) out.push({ kind: 'overlap', el: name(tops[i]), with: name(tops[j]), area: Math.round(x) + 'x' + Math.round(y) });
  }
  // 6. controls in one row with different heights
  for (const row of document.querySelectorAll('.walk-bar, .map-toolbar, .stats, .row, .btns, .guest-walk, .topbar, .tabs, .seg')) {
    if (!vis(row)) continue;
    const cs = getComputedStyle(row); if (!cs.display.includes('flex') || cs.flexDirection.startsWith('column') || cs.flexWrap === 'wrap') continue;
    const ctl = [...row.children].filter(c => c.matches('button, select, input, a') && vis(c));
    const sameLine = ctl.filter(c => Math.abs(c.getBoundingClientRect().top - ctl[0].getBoundingClientRect().top) < 30);
    if (sameLine.length < 2) continue;
    const hs = sameLine.map(c => c.getBoundingClientRect().height);
    if (Math.max(...hs) - Math.min(...hs) > 6) out.push({ kind: 'uneven', el: name(row), heights: hs.map(Math.round) });
  }
  // 7. sideways scroll of the page, and squashed controls
  if (document.scrollingElement.scrollWidth > W + 1) out.push({ kind: 'page-hscroll', by: document.scrollingElement.scrollWidth - W });
  for (const el of document.querySelectorAll('button, select, input:not([type=range]):not([type=checkbox])')) {
    if (!vis(el)) continue; const r = el.getBoundingClientRect();
    if (r.height < 22 && (el.innerText || '').trim().length > 1) out.push({ kind: 'tiny-control', el: name(el), h: Math.round(r.height) });
  }
  return out;
};

async function renderer(p, ev) { await p.evaluate(e => window.postMessage({ source: 'twin-renderer', ...e }, '*'), ev); await wait(250); }

async function run() {
  const b = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox', '--no-proxy-server'], headless: 'new', protocolTimeout: 120000 });
  const pass = await (await fetch(B + '/api/guest', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ room: 'smartthings-experience-zone', hours: 4, label: 'Ayesha Rahman' }) })).json();
  const report = [];
  const pageErrors = [];
  const shot = async (p, view, state, extra) => {
    const issues = await p.evaluate(CHECK);
    const f = `${OUT}/${view.name}__${state}.png`;
    await p.screenshot({ path: f });
    report.push({ view: view.name, state, issues });
    console.log(`${view.name.padEnd(13)} ${state.padEnd(26)} ${issues.length ? issues.length + ' issue(s)' : 'ok'}`);
  };
  const STATES = [
    // admin
    ['admin', '/', async p => {
      await renderer(p, { type: 'ready', version: '0.8.0' }); await renderer(p, { type: 'floorBuilt', rooms: 29, devices: 21 }); await wait(800);
    }, [
      ['map', async () => {}],
      ['room-card', async p => { await renderer(p, { type: 'roomClicked', room: 'gym-room', roomName: 'GYM Room' }); }],
      ['walk', async p => { await renderer(p, { type: 'roomClicked', room: '', roomName: '' }); await renderer(p, { type: 'walk', on: true, room: 'gym-room', roomName: 'GYM Room' }); }],
      ['walk-zone-qr', async p => { await renderer(p, { type: 'walk', on: true, room: 'smartthings-experience-zone', roomName: 'Smart Things Experience Zone' }); }],
      ['map-again', async p => { await renderer(p, { type: 'walk', on: false }); }],
      ['live-ops', async p => { await p.evaluate(() => [...document.querySelectorAll('.tabs button')].find(x => /Live ops/.test(x.textContent))?.click()); await wait(2500); }],
      ['agent', async p => { await p.evaluate(() => [...document.querySelectorAll('.tabs button')].find(x => /AI agent/.test(x.textContent))?.click()); await wait(1500); }],
      ['device-panel', async p => { await p.evaluate(() => [...document.querySelectorAll('.tabs button')].find(x => /Devices/.test(x.textContent))?.click()); await wait(400); await p.evaluate(() => document.querySelector('.dev-row')?.click()); await wait(1500); }],
      ['device-panel-light', async p => { await renderer(p, { type: 'deviceClicked', id: 'LT-01' }); await wait(1500); }],
    ]],
    ['tech', '/tech', async p => { await renderer(p, { type: 'ready', version: '0.8.0' }); await renderer(p, { type: 'floorBuilt', rooms: 29, devices: 21 }); await wait(1500); }, [
      ['list', async () => {}],
      ['alert', async p => { await p.evaluate(() => document.querySelector('.alert-row:not(.predicted)')?.click()); await wait(1200); }],
      ['predicted', async p => { await p.evaluate(() => document.querySelector('.alert-row.predicted')?.click()); await wait(1000); }],
    ]],
    ['guest', `/guest/${pass.token}`, async p => { await wait(1500); await renderer(p, { type: 'ready', version: '0.8.0' }); await renderer(p, { type: 'floorBuilt', rooms: 29, devices: 18 }); }, [
      ['walking', async p => { await renderer(p, { type: 'walk', on: true, guest: 'walking', from: 'Lift Lobby', to: 'Smart Things Experience Zone', metres: 16 }); await wait(1200); }],
      ['arrived', async p => { await renderer(p, { type: 'walk', on: true, guest: 'arrived', roomName: 'Smart Things Experience Zone' }); await wait(1200); }],
      ['room-tab', async p => { await p.evaluate(() => [...document.querySelectorAll('.tabs button')].find(x => /^Room/.test(x.textContent))?.click()); await wait(800); }],
      ['holo', async p => { await renderer(p, { type: 'deviceClicked', id: 'LT-01' }); await renderer(p, { type: 'anchor', id: 'LT-01', x: 0.5, y: 0.4, visible: true }); await wait(800); }],
      ['holo-ac', async p => { await renderer(p, { type: 'deviceClicked', id: 'AC-01' }); await renderer(p, { type: 'anchor', id: 'AC-01', x: 0.8, y: 0.2, visible: true }); await wait(800); }],
      ['tour', async p => { await p.evaluate(() => document.querySelector('.holo .hint-close, .holo button[aria-label="Close"]')?.click()); await wait(300); await p.evaluate(() => [...document.querySelectorAll('button')].find(x => /Take the tour/.test(x.textContent))?.click()); await wait(800); }],
      ['assistant', async p => { await p.evaluate(() => [...document.querySelectorAll('.tour button')].find(x => /End tour/.test(x.textContent))?.click()); await p.evaluate(() => [...document.querySelectorAll('.tabs button')].find(x => /Assistant/.test(x.textContent))?.click()); await wait(800); }],
      ['stay', async p => { await p.evaluate(() => [...document.querySelectorAll('.tabs button')].find(x => /Your stay/.test(x.textContent))?.click()); await wait(1500); }],
    ]],
    ['story', '/story', async p => { await wait(2500); }, [['story', async () => {}]]],
    ['setup', '/setup', async p => { await wait(1500); }, [['setup', async () => {}]]],
    ['integrations', '/integrations', async p => { await wait(1500); }, [['integrations', async () => {}]]],
    ['signin', '/signin', async p => { await wait(800); }, [['signin', async () => {}]]],
  ];
  for (const view of VIEWS) {
    for (const [pg, path, init, states] of STATES) {
      if (view.phone && !['guest', 'signin'].includes(pg)) continue;
      if (ONLY && !ONLY.test(`${view.name}:${pg}`)) continue;
      const p = await b.newPage();
      p.on('pageerror', e => pageErrors.push(`${view.name} ${pg}: ${e.message}`));
      await p.setViewport({ width: view.width, height: view.height, hasTouch: !!view.touch, isMobile: !!view.phone, deviceScaleFactor: 1 });
      if (view.touch) await p.setUserAgent(view.phone ? 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1' : 'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1');
      await p.setRequestInterception(true);
      p.on('request', r => { if (r.url().includes('/godot/index.html') && r.method() === 'GET') r.respond({ status: 200, contentType: 'text/html', body: '<html><body style="margin:0;background:#1c2430"></body></html>' }); else r.continue(); });
      try {
        await p.goto(B + path, { waitUntil: 'networkidle2', timeout: 60000 }).catch(() => {});
        await init(p);
        for (const [state, act] of states) { await act(p); await shot(p, view, `${pg}-${state}`); }
      } catch (e) { console.log('ERR', view.name, pg, e.message); }
      await p.close();
    }
  }
  fs.writeFileSync(OUT + '/report.json', JSON.stringify({ report, pageErrors }, null, 1));
  const n = report.reduce((a, r) => a + r.issues.length, 0);
  console.log(`\n${n} issues in ${report.filter(r => r.issues.length).length}/${report.length} screens; page errors: ${pageErrors.length}`);
  await b.close();
}
run();
