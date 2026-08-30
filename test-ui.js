/* Drives the demo in a real browser: draws a polygon, checks the selected list
   against an independently-computed expectation, then exercises the three CRM
   sync cases (add / remove / move). Screenshots each step. */
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const HTML = 'file://' + path.join(__dirname, 'store-map-demo.html');
const SHOTS = path.join(__dirname, 'shots');
fs.mkdirSync(SHOTS, { recursive: true });

// same engine the page ships, extracted from the same file
const html = fs.readFileSync(path.join(__dirname, 'store-map-demo.html'), 'utf8');
const src = html.slice(html.indexOf('function pointInPolygon'), html.indexOf('if (typeof module'));
const { storesInPolygon } = new Function(src + '\nreturn { storesInPolygon };')();

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '  ->  ' + extra : '')); }
};

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  await page.goto(HTML);
  await page.waitForSelector('#offline svg circle');

  const shot = n => page.screenshot({ path: path.join(SHOTS, n) });

  // ---------- baseline ----------
  const total = await page.$$eval('#offline svg circle', els => els.length);
  ok('24 demo stores rendered as markers', total === 24, `got ${total}`);
  ok('selection starts empty', (await page.textContent('#selCount')) === '0');
  await shot('1-loaded.png');

  // ---------- draw a polygon ----------
  const box = await page.locator('#offline').boundingBox();
  const at = (fx, fy) => ({ x: box.x + box.width * fx, y: box.y + box.height * fy });

  await page.click('#drawBtn');
  for (const [fx, fy] of [[0.18, 0.20], [0.62, 0.16], [0.68, 0.58], [0.22, 0.62]]) {
    const p = at(fx, fy);
    await page.mouse.click(p.x, p.y);
  }
  await page.click('#drawBtn');   // finish

  // read the polygon the UI actually built, compute what SHOULD be selected,
  // and compare against what the UI put on screen.
  const poly = await page.evaluate(() => polygon);
  const allStores = await page.evaluate(() => stores.map(s => ({ id: s.id, name: s.name, lat: s.lat, lng: s.lng })));
  ok('polygon has 4 vertices', poly.length === 4, `got ${poly.length}`);

  const expected = storesInPolygon(allStores, poly).map(s => s.name).sort();
  const shown = await page.$$eval('#selList .store b', els => els.map(e => e.textContent).sort());
  ok('polygon selected a non-empty set (control positive)', expected.length > 0, `expected ${expected.length}`);
  ok('list matches the engine exactly',
     JSON.stringify(shown) === JSON.stringify(expected),
     `ui=${JSON.stringify(shown)} engine=${JSON.stringify(expected)}`);
  ok('counter matches the list',
     (await page.textContent('#selCount')) === String(expected.length),
     `counter=${await page.textContent('#selCount')} list=${expected.length}`);
  console.log(`       (${expected.length} of 24 stores inside the polygon)`);
  await shot('2-polygon-selection.png');

  // ---------- CRM sync: ADD inside the polygon ----------
  const inside = expected.length ? allStores.find(s => s.name === expected[0]) : null;
  await page.fill('#nName', 'Nueva Tienda CRM');
  await page.fill('#nLat', String(inside.lat));
  await page.fill('#nLng', String(inside.lng));
  await page.click('#addStore');
  const afterAdd = await page.$$eval('#selList .store b', els => els.map(e => e.textContent));
  ok('store added in the CRM appears in the selection',
     afterAdd.includes('Nueva Tienda CRM'), JSON.stringify(afterAdd));
  ok('counter incremented on add',
     (await page.textContent('#selCount')) === String(expected.length + 1));
  ok('marker count incremented on add',
     (await page.$$eval('#offline svg circle', e => e.length)) === total + 1 + poly.length,
     'markers + polygon vertices');
  await shot('3-after-add.png');

  // ---------- CRM sync: MOVE it outside ----------
  const newId = await page.evaluate(() => stores[stores.length - 1].id);
  await page.evaluate(id => moveStore(id, 40.470, -3.640), newId);
  const afterMove = await page.$$eval('#selList .store b', els => els.map(e => e.textContent));
  ok('moving a store out of the polygon deselects it', !afterMove.includes('Nueva Tienda CRM'));
  ok('counter back to the original count',
     (await page.textContent('#selCount')) === String(expected.length));

  // ---------- CRM sync: REMOVE ----------
  await page.evaluate(id => removeStore(id), newId);
  ok('removed store is gone from the map',
     (await page.$$eval('#offline svg circle', e => e.length)) === total + poly.length);

  // ---------- category filter ----------
  await page.uncheck('#legend input[data-cat="franchise"]');
  const filtered = await page.$$eval('#selList .store b', els => els.map(e => e.textContent));
  const expectFiltered = expected.filter(n => {
    const s = allStores.find(x => x.name === n);
    return true; // recomputed below from the page's own category data
  });
  const cats = await page.evaluate(() => Object.fromEntries(stores.map(s => [s.name, s.cat])));
  const want = expected.filter(n => cats[n] !== 'franchise');
  ok('hiding a category drops those stores from the selection',
     JSON.stringify(filtered.sort()) === JSON.stringify(want.sort()),
     `ui=${JSON.stringify(filtered)} want=${JSON.stringify(want)}`);
  await shot('4-category-filtered.png');
  await page.check('#legend input[data-cat="franchise"]');

  // ---------- clear ----------
  await page.click('#clearBtn');
  ok('clear resets the selection', (await page.textContent('#selCount')) === '0');
  ok('clear removes the polygon from the map',
     (await page.$$eval('#offline svg polygon', e => e.length)) === 0);

  await browser.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
