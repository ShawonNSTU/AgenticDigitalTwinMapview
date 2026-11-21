// Usage: node tools/ui_audit_deep.js (web app and assistant running; makes /tmp/plan_sample.png first:
//   cd assistant && python -c "from tests.floorplan import plan_synth as p; import cv2; cv2.imwrite('/tmp/plan_sample.png', p.draw()[0])")
// Deep UI audit: every menu, fold, dialog, device control and secondary page the first audit did not open.
const puppeteer = require('puppeteer-core');
const fs = require('fs');
const wait = ms => new Promise(r => setTimeout(r, ms));
const B = 'http://localhost:3000', OUT = process.env.OUT || '/tmp/uid';
fs.mkdirSync(OUT, { recursive: true });
const src = fs.readFileSync(__dirname + '/ui_audit.js', 'utf8');
const a = src.indexOf('const CHECK = ') + 14, b = src.indexOf('\n};\n', a) + 2;
const CHECK = eval('(' + src.slice(a, b) + ')');
const ONLY = process.env.ONLY ? new RegExp(process.env.ONLY) : null;
const VIEWS = [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'ipad-land', width: 1180, height: 820, touch: true },
  { name: 'ipad-port', width: 820, height: 1180, touch: true },
  { name: 'phone', width: 390, height: 844, touch: true, phone: true },
];
const R = (p, ev) => p.evaluate(e => window.postMessage({ source: 'twin-renderer', ...e }, '*'), ev).then(() => wait(250));
const click = (p, sel, re) => p.evaluate((s, r) => { const x = [...document.querySelectorAll(s)].find(e => !r || new RegExp(r).test(e.textContent)); x?.click(); return !!x; }, sel, re ? re.source : null);
const openAll = (p, scope) => p.evaluate(s => document.querySelectorAll(`${s} details`).forEach(d => { d.open = true; }), scope);
const boot = async p => { await R(p, { type: 'ready', version: '0.8.0' }); await R(p, { type: 'floorBuilt', rooms: 29, devices: 21 }); await wait(600); };

(async () => {
  const br = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox', '--no-proxy-server'], headless: 'new', protocolTimeout: 180000 });
  const post = (u, body) => fetch(B + u, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(r => r.json());
  const guest = await post('/api/guest', { room: 'smartthings-experience-zone', hours: 4, label: 'Ayesha Rahman' });
  const pinned = await post('/api/guest', { room: 'smartthings-experience-zone', hours: 4, label: 'PIN guest', verify: true });
  const cp = (await (await fetch(B + '/api/positioning')).json()).checkpoints?.[0]?.id ?? 'x';
  const devs = (await (await fetch(B + '/api/floor')).json()).devices.filter(d => d.room === 'smartthings-experience-zone');
  const byName = n => devs.find(d => d.name.split(' · ')[0] === n)?.id;
  const HOLO = [['light-colour', byName('Light 1')], ['light-switch', byName('TV Lamp')], ['window', byName('Left Window Light')], ['shade', byName('Aqara Roller Shade Controller')], ['plug', byName('Blinds Switch')], ['ac', byName('Ceiling AC')], ['tv', byName('TV 65"')], ['purifier', byName('Air purifier')], ['lock', byName('Door lock')], ['sensor', byName('Temp & humidity')]];
  const report = [], errors = [];
  const PAGES = [
    ['admin', '/', boot, [
      ['layers-open', async p => { await p.evaluate(() => { document.querySelector('.layers-menu').open = true; }); }],
      ['map-help', async p => { await p.evaluate(() => { document.querySelector('.layers-menu').open = false; }); await click(p, '.map-nav button[aria-label="Controls"]'); }],
      ['top-menu-open', async p => { await click(p, '.map-nav button[aria-label="Controls"]'); await p.evaluate(() => { const d = document.querySelector('.top-more'); if (getComputedStyle(d).display !== 'none') d.open = true; }); }],
      ['device-more', async p => { await p.evaluate(() => { document.querySelector('.top-more').open = false; }); await R(p, { type: 'deviceClicked', id: 'LT-01' }); await wait(1200); await p.evaluate(() => { document.querySelector('.more-menu').open = true; }); }],
      ['device-folds', async p => { await p.evaluate(() => { document.querySelector('.more-menu').open = false; }); await openAll(p, '.side'); await wait(300); }],
      ['device-ac-folds', async p => { await R(p, { type: 'deviceClicked', id: byName('Ceiling AC') }); await wait(1200); await openAll(p, '.side'); }],
      ['device-twin-open', async p => { await click(p, '.side .btns button', /Look inside/); await wait(500); }],
      ['room-furniture', async p => { await click(p, '.side .btns button', /Back to floor/); await wait(400); await R(p, { type: 'roomClicked', room: 'smartthings-experience-zone', roomName: 'Smart Things Experience Zone' }); await click(p, '.room-card button', /^Furniture$/); await wait(800); }],
      ['guest-qr-form', async p => { await click(p, '.room-card button', /^Furniture$/); await click(p, '.room-card button', /Check in a guest/); await wait(800); }],
      ['guest-qr-more', async p => { await openAll(p, '.modal'); }],
      ['guest-qr-made', async p => { await click(p, '.modal button', /Create QR code/); await wait(1500); }],
      ['agent-reply', async p => { await click(p, '.modal .hint-close'); await click(p, '.tabs button', /AI agent/); await wait(600); await p.evaluate(() => { const t = document.querySelector('.ag textarea, .ag input[type=text]'); if (t) { const set = Object.getOwnPropertyDescriptor(t.__proto__, 'value').set; set.call(t, 'How many rooms are on this floor?'); t.dispatchEvent(new Event('input', { bubbles: true })); } }); await p.keyboard.press('Enter').catch(() => {}); await click(p, '.ag button[type=submit], .ag-send'); await wait(8000); }],
    ]],
    ['tech', '/tech', boot, [
      ['alert-folds', async p => { await click(p, '.alert-row:not(.predicted)'); await wait(1000); await openAll(p, '.side'); }],
    ]],
    ['setup', '/setup', async () => {}, [
      ['upload', async () => {}],
      ['review', async p => { const i = await p.$('.drop input[type=file]'); await i.uploadFile('/tmp/plan_sample.png'); await p.waitForSelector('.setup-head', { timeout: 60000 }); await wait(500); }],
      ['edit-rooms', async p => { await click(p, '.plan-tools button', /Edit plan/); await wait(300); }],
      ['edit-doors', async p => { await click(p, '.plan-tools .seg button', /Doors/); }],
      ['edit-straighten', async p => { await click(p, '.plan-tools .seg button', /Straighten/); }],
    ]],
    ['guest', `/guest/${guest.token}`, async p => { await wait(1200); await boot(p); }, [
      ['locator-open', async p => { await click(p, '.locator-pill'); }],
      ['stay-folds', async p => { await click(p, '.locator .hint-x'); await openAll(p, '.guest-panel'); await wait(500); }],
      ...HOLO.map(([n, id]) => [`holo-${n}`, async p => { await R(p, { type: 'deviceClicked', id }); await R(p, { type: 'anchor', id, x: 0.45, y: 0.4, visible: true }); await wait(700); }]),
    ]],
    ['guest-pin', `/guest/${pinned.token}`, async () => { await wait(1000); }, [['pin', async () => {}]]],
    ['guest-denied', '/guest/not-a-real-token', async () => { await wait(1000); }, [['denied', async () => {}]]],
    ['here', `/here/${cp}`, async () => { await wait(1500); }, [['here', async () => {}]]],
    ['story', '/story', async () => { await wait(2500); }, [['start', async () => {}]]],
  ];
  for (const v of VIEWS) for (const [pg, path, init, states] of PAGES) {
    if (v.phone && !/guest|here|signin/.test(pg)) continue;
    if (ONLY && !ONLY.test(`${v.name}:${pg}`)) continue;
    const p = await br.newPage();
    p.on('pageerror', e => errors.push(`${v.name} ${pg}: ${e.message}`));
    await p.setViewport({ width: v.width, height: v.height, hasTouch: !!v.touch, isMobile: !!v.phone });
    await p.setRequestInterception(true);
    p.on('request', r => { if (r.url().includes('/godot/index.html') && r.method() === 'GET') r.respond({ status: 200, contentType: 'text/html', body: '<html><body style="margin:0;background:#1c2430"></body></html>' }); else r.continue(); });
    try {
      await p.goto(B + path, { waitUntil: 'networkidle2', timeout: 60000 }).catch(() => {});
      await init(p);
      for (const [st, act] of states) {
        try { await act(p); } catch (e) { console.log('step error', v.name, pg, st, e.message.slice(0, 80)); }
        await wait(250);
        const issues = await p.evaluate(CHECK);
        await p.screenshot({ path: `${OUT}/${v.name}__${pg}-${st}.png` });
        report.push({ view: v.name, state: `${pg}-${st}`, issues });
        console.log(`${v.name.padEnd(10)} ${(pg + '-' + st).padEnd(30)} ${issues.length ? issues.length + ' issue(s)' : 'ok'}`);
      }
    } catch (e) { console.log('ERR', v.name, pg, e.message); }
    await p.close();
  }
  fs.writeFileSync(OUT + '/report.json', JSON.stringify({ report, errors }, null, 1));
  console.log(`\n${report.reduce((n, r) => n + r.issues.length, 0)} issues in ${report.filter(r => r.issues.length).length}/${report.length} screens; page errors: ${errors.length}`);
  await br.close();
})();
