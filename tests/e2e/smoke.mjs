// End-to-end smoke test against a running instance (e.g. the Docker container).
//   npm install --no-save playwright && npx playwright install chromium
//   BASE_URL=http://localhost:3002 node tests/e2e/smoke.mjs [screenshot_dir]
import { chromium } from 'playwright';
import assert from 'node:assert/strict';

const BASE = process.env.BASE_URL || 'http://localhost:3002';
const SHOTS = process.argv[2];
const errors = [];

// Use localhost (or HTTPS) for BASE_URL: geolocation needs a secure context.
const launch = {};
if (process.env.PW_PROXY) launch.proxy = { server: process.env.PW_PROXY, bypass: new URL(BASE).hostname };
const browser = await chromium.launch(launch);
const context = await browser.newContext({
  viewport: { width: 1280, height: 800 },
  locale: 'fr-FR',
  geolocation: { latitude: 34.6814, longitude: -1.9086 },
  permissions: ['geolocation'],
});
const page = await context.newPage();
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('console', (m) => { if (m.type() === 'error' && !/tile\.openstreetmap|ERR_|net::/.test(m.text())) errors.push(`console: ${m.text()}`); });

const shot = async (name) => { if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}.png` }); };
// Wait until the app has rendered the current URL.
const settled = (pg = page) => pg.waitForFunction(() => document.querySelector('#view').dataset.hash === location.hash);
const step = async (name, fn) => { await fn(); console.log(`ok - ${name}`); };

await step('home lists all 24 lines', async () => {
  await page.goto(BASE + '/');
  await settled();
  await page.waitForSelector('.line-card');
  assert.equal(await page.locator('.line-card').count(), 24);
  assert.equal(await page.getAttribute('html', 'lang'), 'fr');
  await shot('01-home');
});

await step('search finds a stop and opens it', async () => {
  await page.fill('#search', 'aeroport');
  await page.waitForSelector('#search-list [role="option"]');
  await page.keyboard.press('Enter');
  await page.waitForURL(/#\/stop\/507$/);
  await settled();
  assert.equal((await page.textContent('#view h1')).trim(), 'Aéroport');
  await shot('02-stop');
});

await step('search finds a line by number', async () => {
  await page.fill('#search', '25');
  await page.waitForSelector('#search-list [role="option"] .badge');
  assert.equal((await page.textContent('#search-list [role="option"] .badge')).trim(), 'L25');
  await page.keyboard.press('Enter');
  await page.waitForURL(/#\/line\/21$/);
  await settled();
});

await step('line page shows ordered stops, both directions', async () => {
  await page.goto(BASE + '/#/line/21/retour');
  await settled();
  await page.waitForSelector('.timeline li');
  const names = await page.locator('.timeline .stop-name').allTextContents();
  assert.equal(names.length, 31);
  assert.equal(names[12].trim(), 'Bank BMCI');
  assert.equal(await page.locator('.segmented .seg').count(), 2);
  await page.click('.segmented .seg:not(.active)');
  await page.waitForURL(/#\/line\/21\/aller$/);
  await settled();
  assert.equal(await page.locator('.timeline li').count(), 29);
  await shot('03-line');
});

await step('a terminus placed from the Figma map has no warning', async () => {
  await page.goto(BASE + '/#/stop/269');
  await settled();
  await page.waitForSelector('#view h2');
  assert.equal(await page.locator('#view .warning').count(), 0);
});

await step('a merged stop id redirects to the stop it was merged into', async () => {
  await page.goto(BASE + '/#/stop/208');
  await page.waitForURL(/#\/stop\/803$/);
  await settled();
});

await step('favorites persist across reloads', async () => {
  await page.goto(BASE + '/#/stop/922');
  await settled();
  await page.click('[data-fav="stops:922"]');
  await page.goto(BASE + '/#/line/3');
  await settled();
  await page.click('[data-fav="lines:3"]');
  await page.goto(BASE + '/#/favorites');
  await settled();
  await page.reload();
  await page.waitForSelector('#view .stop-item');
  assert.equal(await page.locator('#view a[href="#/stop/922"]').count(), 1);
  assert.equal(await page.locator('#view a[href="#/line/3"]').count(), 1);
});

await step('trip planner finds routes between stops', async () => {
  await page.goto(BASE + '/#/plan?from=stop:922&to=stop:515');
  await settled();
  await page.waitForSelector('.option');
  const n = await page.locator('.option').count();
  assert.ok(n >= 1);
  assert.ok(await page.locator('.option.selected .leg.ride').count() >= 1);
  await shot('04-plan');
  if (n > 1) {
    await page.click('.option:nth-child(2) .option-head');
    await page.waitForURL(/opt=1/);
    await settled();
    await page.waitForSelector('.option:nth-child(2).selected');
  }
});

await step('planner autocomplete and swap', async () => {
  await page.goto(BASE + '/#/plan');
  await settled();
  await page.fill('#plan-from', 'clinique ibn');
  await page.waitForSelector('#plan-from-list [role="option"]');
  await page.keyboard.press('Enter');
  await page.waitForURL(/from=stop:803/);
  await settled();
  await page.fill('#plan-to', 'aeroport');
  await page.waitForSelector('#plan-to-list [role="option"]');
  await page.click('#plan-to-list [role="option"]');
  await page.waitForURL(/to=stop:507/);
  await settled();
  await page.waitForSelector('.option');
  await page.click('[data-plan-swap]');
  await page.waitForURL(/from=stop:507&to=stop:803/);
  await settled();
});

await step('pick a point on the map and use my location', async () => {
  await page.goto(BASE + '/#/plan?to=stop:507');
  await settled();
  await page.click('[data-plan-pick="from"]');
  await page.waitForSelector('.pick-banner');
  const box = await page.locator('#map').boundingBox();
  await page.mouse.click(box.x + box.width / 2 + 3, box.y + box.height / 2 + 3);
  await page.waitForURL(/from=(pt|stop):/);
  await settled();
  await page.click('[data-plan-locate="to"]');
  await page.waitForURL(/to=pt:34\.6814/);
  await settled();
  await page.waitForSelector('#plan-results .option, #plan-results .warning');
});

await step('address search finds a place, opens it and plans a trip to it', async () => {
  // The geocoder is answered here so the test doesn't depend on Nominatim.
  const geocodeCalls = [];
  await page.route('**/api/geocode?**', (route) => {
    geocodeCalls.push(new URL(route.request().url()).searchParams.get('q'));
    return route.fulfill({
      json: [{
        lat: '34.6775498', lon: '-1.9205325', name: 'Lycée Omar Ibn Abdelaziz',
        display_name: 'Lycée Omar Ibn Abdelaziz, Boulevard Bir Anzarene, Hay Al Mahatta, Oujda, Oriental, 60000, Maroc',
      }],
    });
  });
  await page.goto(BASE + '/#/');
  await settled();
  await page.fill('#search', 'lycee omar');
  await page.waitForSelector('#search-list .geo-row');
  assert.deepEqual(geocodeCalls, [], 'no geocoder request while typing');
  await page.click('#search-list .geo-row');
  await page.waitForSelector('#search-list .place-row');
  assert.deepEqual(geocodeCalls, ['lycee omar']);
  await page.click('#search-list .place-row');
  await page.waitForURL(/#\/place\?at=34\.67755\d,-1\.92053\d&name=/);
  await settled();
  assert.equal((await page.textContent('#view h1')).trim(), 'Lycée Omar Ibn Abdelaziz');
  assert.ok(await page.locator('#view .stop-item').count() > 0, 'nearby stops listed');
  await page.click('#view .actions a:nth-child(2)'); // "Go here"
  await page.waitForURL(/to=pt:34\.67755\d,-1\.92053\d&toName=/);
  await settled();
  assert.equal(await page.inputValue('#plan-to'), 'Lycée Omar Ibn Abdelaziz');
  // The planner's own fields search addresses too.
  await page.fill('#plan-from', 'lycee omar');
  await page.waitForSelector('#plan-from-list .geo-row');
  await page.click('#plan-from-list .geo-row');
  await page.waitForSelector('#plan-from-list .place-row');
  assert.equal(geocodeCalls.length, 1, 'repeated searches come from the browser cache');
  await page.click('#plan-from-list .place-row');
  await page.waitForURL(/from=pt:34\.67755\d,-1\.92053\d&fromName=.*to=pt:/);
  await settled();
  await page.goto(BASE + '/#/plan?from=stop:922&to=pt:34.677550,-1.920533&toName=Lyc%C3%A9e%20Omar');
  await settled();
  await page.waitForSelector('.option');
  assert.ok((await page.textContent('.option.selected .legs')).includes('Lycée Omar'), 'last walk names the place');
  await page.unroute('**/api/geocode?**');
});

await step('address search falls back to the browser, and reports failures', async () => {
  const before = errors.length;
  const direct = [];
  let directStatus = 200;
  await page.route('**/api/geocode?**', (route) => route.fulfill({ status: 502, body: 'bad gateway' }));
  await page.route('https://nominatim.openstreetmap.org/**', (route) => {
    const url = new URL(route.request().url());
    direct.push(url.searchParams.get('q'));
    if (directStatus !== 200) return route.fulfill({ status: directStatus, body: 'no' });
    return route.fulfill({
      json: [{ lat: '34.681', lon: '-1.909', name: 'Pharmacie Le Paris', display_name: 'Pharmacie Le Paris, Boulevard Allal Ben Abdallah, Oujda, Maroc' }],
    });
  });
  await page.goto(BASE + '/#/');
  await settled();
  // The server can't reach the geocoder: the browser asks it directly.
  await page.fill('#search', 'pharmacie le paris');
  await page.click('#search-list .geo-row');
  await page.waitForSelector('#search-list .place-row');
  assert.deepEqual(direct, ['pharmacie le paris']);
  assert.ok((await page.textContent('#search-list')).includes('Pharmacie Le Paris'));
  // Both fail: the message says why.
  directStatus = 403;
  await page.fill('#search', 'rue inconnue');
  await page.click('#search-list .geo-row');
  await page.waitForFunction(() => /(indisponible|unavailable|غير متاح).*502/.test(document.querySelector('#search-list').textContent));
  // The site-wide rate limit is not worked around.
  await page.unroute('**/api/geocode?**');
  await page.route('**/api/geocode?**', (route) => route.fulfill({ status: 429, body: 'slow down' }));
  const directBefore = direct.length;
  await page.fill('#search', 'rue lente');
  await page.click('#search-list .geo-row');
  await page.waitForFunction(() => /Trop de recherches|Too many|كثيرة/.test(document.querySelector('#search-list').textContent));
  assert.equal(direct.length, directBefore, 'no direct request after a 429');
  await page.unroute('**/api/geocode?**');
  await page.unroute('https://nominatim.openstreetmap.org/**');
  // The browser logs the errors this step provoked on purpose.
  errors.splice(before, errors.length - before, ...errors.slice(before).filter((e) => !/\b(502|403|429)\b/.test(e)));
});

await step('nearby uses geolocation', async () => {
  await page.goto(BASE + '/#/nearby');
  await settled();
  await page.waitForSelector('#view .stop-item');
  assert.ok(await page.locator('#view .stop-item').count() > 3);
  await shot('05-nearby');
});

await step('about page lists data issues and downloads', async () => {
  await page.goto(BASE + '/#/about');
  await settled();
  await page.waitForSelector('.issues li');
  assert.ok(await page.locator('.issues li').count() >= 1);
  for (const href of await page.locator('.downloads a').evaluateAll((as) => as.map((a) => a.href))) {
    const res = await page.request.get(href);
    assert.equal(res.status(), 200, href);
  }
});

await step('arabic switches to right-to-left', async () => {
  await page.selectOption('#lang', 'ar');
  assert.equal(await page.getAttribute('html', 'dir'), 'rtl');
  assert.equal((await page.textContent('.tabs a[data-tab="lines"]')).trim(), 'الخطوط');
  await page.goto(BASE + '/#/line/1');
  await settled();
  await page.waitForSelector('.timeline li');
  await shot('06-arabic');
  await page.selectOption('#lang', 'en');
  assert.equal((await page.textContent('.tabs a[data-tab="lines"]')).trim(), 'Lines');
});

await step('dark theme toggles', async () => {
  await page.click('#theme-btn'); // auto -> light
  await page.click('#theme-btn'); // light -> dark
  assert.equal(await page.getAttribute('html', 'data-theme'), 'dark');
  await shot('07-dark');
  await page.click('#theme-btn'); // back to auto
});

await step('unknown routes show not found', async () => {
  await page.goto(BASE + '/#/stop/999999');
  await settled();
  await page.waitForSelector('#view .empty');
});

await step('phone layout uses a bottom sheet', async () => {
  const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, locale: 'fr-FR' });
  const p = await phone.newPage();
  p.on('pageerror', (e) => errors.push(`pageerror (phone): ${e.message}`));
  await p.goto(BASE + '/#/line/12');
  await settled(p);
  await p.waitForSelector('.timeline li');
  const panel = await p.locator('#panel').boundingBox();
  const map = await p.locator('#map').boundingBox();
  assert.ok(panel.y > 200 && map.y === 0 && map.height <= panel.y + 1);
  const width = await p.evaluate(() => document.documentElement.scrollWidth);
  assert.ok(width <= 390, `no horizontal scroll (${width})`);
  if (SHOTS) await p.screenshot({ path: `${SHOTS}/08-phone.png` });
  await p.click('#panel-handle');
  await p.waitForFunction(() => document.body.classList.contains('panel-collapsed'));
  if (SHOTS) await p.screenshot({ path: `${SHOTS}/09-phone-collapsed.png` });
  await phone.close();
});

await browser.close();
assert.deepEqual(errors, [], errors.join('\n'));
console.log('all smoke tests passed');
