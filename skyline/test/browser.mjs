/**
 * Browser test.
 *
 * The Node suites cover the geometry; this covers everything that only exists
 * in a browser — the ES module graph, the worker, WebGL, Leaflet, and the
 * control wiring — by driving the real page.
 *
 * The network is stubbed from `test/.cache` fixtures rather than hit live.
 * That is not a compromise: it makes the run deterministic and fast, it keeps
 * the free public APIs out of a loop that runs on every change, and the live
 * contracts are already exercised by `smoke.mjs`. Populate the cache by
 * running that suite first.
 *
 *   node test/browser.mjs [--headed] [--keep]
 */

import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile, mkdir, readdir } from 'node:fs/promises';
import { extname, join, normalize, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const SHOTS = join(HERE, 'shots');
const CACHE = join(HERE, '.cache');
const PORT = 8137;

// Manhattan Midtown — the fixture the Overpass stub replays.
const FIXTURE = { lat: 40.7549, lon: -73.984, areaMetres: 1200, name: 'Midtown Manhattan' };

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

const PIXEL = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64'
);

let failures = 0;
let checks = 0;

function ok(label, condition, detail = '') {
  checks++;
  if (condition) {
    console.log(`  ✓ ${label}`);
  } else {
    failures++;
    console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

function serve() {
  const server = createServer(async (req, res) => {
    try {
      let path = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
      if (path === '/') path = '/index.html';
      const file = join(ROOT, normalize(path).replace(/^(\.\.[/\\])+/, ''));
      const body = await readFile(file);
      res.writeHead(200, {
        'Content-Type': TYPES[extname(file)] || 'application/octet-stream',
        'Cache-Control': 'no-store',
      });
      res.end(body);
    } catch {
      res.writeHead(404).end('not found');
    }
  });
  return new Promise((resolve) => server.listen(PORT, () => resolve(server)));
}

/** Google encoded polyline, precision 6 — the format Valhalla returns. */
function encodePolyline(points, precision = 6) {
  const factor = 10 ** precision;
  let last = [0, 0];
  let out = '';
  const chunk = (value) => {
    let v = value < 0 ? ~(value << 1) : value << 1;
    let s = '';
    while (v >= 0x20) {
      s += String.fromCharCode((0x20 | (v & 0x1f)) + 63);
      v >>= 5;
    }
    return s + String.fromCharCode(v + 63);
  };
  for (const [lat, lon] of points) {
    const la = Math.round(lat * factor);
    const lo = Math.round(lon * factor);
    out += chunk(la - last[0]) + chunk(lo - last[1]);
    last = [la, lo];
  }
  return out;
}

async function installStubs(page, osm) {
  const seen = { overpass: 0, elevation: 0, route: 0, geocode: 0 };

  await page.route('**://*/api/interpreter', (route) => {
    seen.overpass++;
    route.fulfill({ contentType: 'application/json', body: JSON.stringify(osm) });
  });

  await page.route('**://photon.komoot.io/**', (route) => {
    seen.geocode++;
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        features: [
          {
            geometry: { type: 'Point', coordinates: [FIXTURE.lon, FIXTURE.lat] },
            properties: {
              name: FIXTURE.name,
              city: 'New York',
              state: 'New York',
              country: 'United States',
              osm_value: 'suburb',
              extent: [
                FIXTURE.lon - 0.008, FIXTURE.lat + 0.006,
                FIXTURE.lon + 0.008, FIXTURE.lat - 0.006,
              ],
            },
          },
        ],
      }),
    });
  });

  await page.route('**://nominatim.openstreetmap.org/**', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        address: { city: 'New York', state: 'New York', country: 'United States', country_code: 'us' },
        display_name: 'Midtown, Manhattan, New York',
      }),
    })
  );

  await page.route('**://api.open-meteo.com/**', (route) => {
    seen.elevation++;
    const url = new URL(route.request().url());
    const lats = url.searchParams.get('latitude').split(',').map(Number);
    const lons = url.searchParams.get('longitude').split(',').map(Number);
    // A synthetic hill about 500 m across, so the terrain path has real relief
    // to work with. Offsets are converted to metres or the ridge comes out flat
    // at city scale.
    const mPerDegLat = 111320;
    const mPerDegLon = 111320 * Math.cos((FIXTURE.lat * Math.PI) / 180);
    const elevation = lats.map((lat, i) => {
      const dx = (lons[i] - FIXTURE.lon) * mPerDegLon;
      const dy = (lat - FIXTURE.lat) * mPerDegLat;
      return 20 + 90 * Math.exp(-(dx * dx + dy * dy) / (2 * 350 * 350));
    });
    route.fulfill({ contentType: 'application/json', body: JSON.stringify({ elevation }) });
  });

  await page.route('**://valhalla1.openstreetmap.de/**', (route) => {
    seen.route++;
    const path = [];
    for (let i = 0; i <= 24; i++) {
      const t = i / 24;
      path.push([
        FIXTURE.lat - 0.003 + 0.006 * t,
        FIXTURE.lon - 0.004 + 0.008 * t + Math.sin(t * 6) * 0.0006,
      ]);
    }
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        trip: {
          legs: [{ shape: encodePolyline(path) }],
          summary: { length: 1.24, time: 900 },
        },
      }),
    });
  });

  // Map tiles: a transparent pixel is enough to prove Leaflet is wired up.
  await page.route(/basemaps\.cartocdn\.com|tile\.openstreetmap\.org/, (route) =>
    route.fulfill({ contentType: 'image/png', body: PIXEL })
  );

  return seen;
}

(async () => {
  console.log('Skyline Forge — browser test');
  console.log('============================\n');

  let osm;
  try {
    osm = JSON.parse(await readFile(join(CACHE, 'osm-manhattan-midtown.json'), 'utf8'));
  } catch {
    console.log('  ! No fixture found. Run `node test/smoke.mjs` first to populate test/.cache.');
    process.exit(1);
  }
  console.log(`Fixture: ${osm.elements.length.toLocaleString()} OSM elements\n`);

  await mkdir(SHOTS, { recursive: true });
  const server = await serve();
  const browser = await chromium.launch({
    headless: !process.argv.includes('--headed'),
    executablePath: await findChromium(),
    args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
  });

  const page = await browser.newPage({ viewport: { width: 1580, height: 940 } });
  page.setDefaultTimeout(120000);

  const errors = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('requestfailed', (r) => {
    if (r.url().startsWith(`http://localhost:${PORT}`)) {
      errors.push(`asset failed: ${r.url()} ${r.failure()?.errorText || ''}`);
    }
  });

  const seen = await installStubs(page, osm);

  try {
    await page.goto(`http://localhost:${PORT}/index.html`, { waitUntil: 'load' });

    /* ---------- boot ---------- */
    console.log('Boot');
    await page.waitForFunction(() => window.skylineForge !== undefined, { timeout: 20000 });
    ok('app boots', true);
    ok('module graph resolves cleanly', errors.length === 0, errors.slice(0, 3).join(' | '));
    ok('WebGL context is live', await page.evaluate(() =>
      Boolean(window.skylineForge.viewer.renderer.getContext())));
    ok('Leaflet map is live', await page.evaluate(() =>
      Boolean(window.skylineForge.picker.map.getCenter())));
    ok('all ten shapes are offered', (await page.locator('.shape-btn').count()) === 10);
    ok('all eleven layers are listed', (await page.locator('.layer-row').count()) === 11);
    ok('all four export formats are offered', (await page.locator('.format-opt').count()) === 4);

    /* ---------- first model ---------- */
    console.log('\nFirst build (worker + Overpass)');
    await page.evaluate((f) => {
      const app = window.skylineForge;
      app.settings.location = { lat: f.lat, lon: f.lon, label: f.name };
      app.settings.size.areaMetres = f.areaMetres;
      app.picker.update(app.settings);
      app.syncUi();
    }, FIXTURE);
    await page.click('#generate-btn');
    await page.waitForFunction(
      () => window.skylineForge.model?.parts?.length > 0 && !window.skylineForge.busy,
      { timeout: 150000 }
    );

    const first = await page.evaluate(() => ({
      parts: window.skylineForge.model.parts.map((p) => p.id),
      stats: window.skylineForge.model.stats,
    }));
    console.log(
      `    ${first.parts.length} parts (${first.parts.join(', ')}), ` +
        `${first.stats.triangles.toLocaleString()} triangles in ${first.stats.elapsedMs} ms`
    );
    ok('the worker returned geometry', first.stats.triangles > 10000);
    ok('buildings were extruded', first.stats.buildingCount > 200,
      `${first.stats.buildingCount} buildings`);
    ok('the plate is the size that was asked for',
      Math.abs(first.stats.widthMm - 160) < 1.5,
      `${first.stats.widthMm.toFixed(1)} mm across`);
    ok('the scale readout is right',
      Math.abs(first.stats.scaleDenominator - 7500) < 200,
      `1:${first.stats.scaleDenominator}`);
    ok('export is enabled', await page.locator('#export-btn').isEnabled());
    ok('meshes reached the scene',
      await page.evaluate(() => window.skylineForge.viewer.parts.size > 3));
    await page.screenshot({ path: join(SHOTS, '01-manhattan.png') });

    /* ---------- search ---------- */
    console.log('\nSearch');
    await page.fill('#search-input', 'Midtown');
    await page.waitForSelector('#search-results li:not(.r-empty)');
    ok('typeahead lists suggestions',
      (await page.locator('#search-results li').count()) > 0);
    await page.locator('#search-results li').first().click();
    await page.waitForTimeout(400);
    ok('picking a suggestion fills the nameplate title',
      (await page.evaluate(() => window.skylineForge.settings.nameplate.title)).length > 0);

    /* ---------- shapes ---------- */
    console.log('\nShapes');
    for (const shape of ['hexagon', 'heart', 'star', 'rectangle', 'triangle']) {
      await page.click(`.shape-btn[data-shape="${shape}"]`);
      await page.waitForTimeout(650);
      await page.waitForFunction(() => !window.skylineForge.busy);
      const size = await page.evaluate(() => ({
        w: window.skylineForge.model.stats.widthMm,
        d: window.skylineForge.model.stats.depthMm,
      }));
      // Whatever the outline, the printed footprint must stay inside the
      // requested size (plus the nameplate bar, which extends downwards).
      ok(`${shape} stays within the printed size`,
        size.w <= 161 && size.d <= 161 + 20,
        `${size.w.toFixed(1)} × ${size.d.toFixed(1)} mm`);
    }
    await page.screenshot({ path: join(SHOTS, '02-triangle.png') });
    await page.click('.shape-btn[data-shape="circle"]');
    await page.waitForTimeout(650);

    /* ---------- live geometry updates ---------- */
    console.log('\nLive updates');
    const overpassBefore = seen.overpass;
    const buildingVolume = () =>
      page.evaluate(() =>
        window.skylineForge.model.parts.find((p) => p.id === 'buildings').volumeMm3);
    const before = await buildingVolume();
    await page.evaluate(() => {
      const el = document.querySelector('[data-bind="heights.buildingScale"]');
      el.value = '3';
      el.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await page.waitForTimeout(700);
    await page.waitForFunction(() => !window.skylineForge.busy);
    const after = await buildingVolume();
    // Volume rather than peak height: Midtown's tallest towers already sit at
    // the height cap, so the tallest point barely moves while everything below
    // it grows.
    ok('raising the height scale makes the skyline taller', after > before * 1.8,
      `${(before / 1000).toFixed(1)} cm³ -> ${(after / 1000).toFixed(1)} cm³`);
    ok('a geometry change reuses the cached map data',
      seen.overpass === overpassBefore,
      `${seen.overpass - overpassBefore} extra downloads`);

    /* ---------- colours ---------- */
    console.log('\nColours');
    await page.click('[data-palette="blueprint"]');
    const painted = await page.evaluate(() => {
      const mesh = window.skylineForge.viewer.parts.get('ground');
      return mesh ? `#${mesh.material.color.getHexString()}` : null;
    });
    ok('a palette repaints without rebuilding', painted === '#12395c', `ground is ${painted}`);
    await page.click('[data-palette="classic"]');

    /* ---------- layer toggles ---------- */
    console.log('\nLayer toggles');
    await page.evaluate(() => {
      const row = [...document.querySelectorAll('.layer-row')]
        .find((r) => r.textContent.includes('Water'));
      row.querySelector('input[type="checkbox"]').click();
    });
    await page.waitForTimeout(700);
    ok('turning a layer off hides it', await page.evaluate(() => {
      const m = window.skylineForge.viewer.parts.get('water');
      return m ? !m.visible : true;
    }));
    ok('a hidden layer is left out of the export', await page.evaluate(() => {
      const app = window.skylineForge;
      return !app.model.parts
        .filter((p) => app.settings.layers[p.id === 'water' ? 'water' : 'buildings'] !== false)
        .some((p) => p.id === 'water');
    }));

    /* ---------- terrain ---------- */
    console.log('\nTerrain');
    await page.evaluate(() => {
      const app = window.skylineForge;
      app.settings.layers.water = true;
      app.settings.terrain.enabled = true;
      app.syncUi();
    });
    await page.click('#generate-btn');
    await page.waitForFunction(
      () => !window.skylineForge.busy && window.skylineForge.model?.stats?.terrainRelief > 0,
      { timeout: 180000 }
    );
    const relief = await page.evaluate(() => window.skylineForge.model.stats.terrainRelief);
    ok('terrain sampling reached the model', relief > 20, `${relief.toFixed(0)} m of relief`);
    ok('the elevation API was called', seen.elevation > 0, `${seen.elevation} requests`);
    await page.screenshot({ path: join(SHOTS, '03-terrain.png') });
    await page.evaluate(() => {
      window.skylineForge.settings.terrain.enabled = false;
      window.skylineForge.syncUi();
      window.skylineForge.onChange('geometry');
    });
    await page.waitForTimeout(700);
    await page.waitForFunction(() => !window.skylineForge.busy);

    /* ---------- route ---------- */
    console.log('\nRoute');
    await page.evaluate((f) => {
      const app = window.skylineForge;
      const points = [
        { lat: f.lat - 0.003, lon: f.lon - 0.004 },
        { lat: f.lat + 0.003, lon: f.lon + 0.004 },
      ];
      app.settings.layers.route = true;
      app.settings.route.waypoints = points;
      app.picker.setWaypoints(points);
      app.renderWaypoints();
      return app.resolveRoute();
    }, FIXTURE);
    // resolveRoute schedules the rebuild on a debounce, so wait for it to be
    // picked up before asking whether the model contains a route.
    await page.waitForFunction(
      () => window.skylineForge.settings.route.points?.length > 2,
      { timeout: 60000 }
    );
    await page.waitForTimeout(700);
    await page.waitForFunction(() => !window.skylineForge.busy, { timeout: 90000 });

    const route = await page.evaluate(() => ({
      points: window.skylineForge.settings.route.points?.length || 0,
      distance: window.skylineForge.settings.route.distance,
      part: window.skylineForge.model.parts.find((p) => p.id === 'route'),
    }));
    ok('the router returned a path', route.points > 5, `${route.points} points`);
    ok('the distance is reported', route.distance > 1000, `${route.distance} m`);
    ok('the route becomes its own coloured part',
      route.part && route.part.triangleCount > 50,
      `${route.part?.triangleCount || 0} triangles`);
    ok('the waypoint list is rendered',
      (await page.locator('#waypoint-list li').count()) === 2);
    await page.screenshot({ path: join(SHOTS, '04-route.png') });

    /* ---------- nameplate ---------- */
    console.log('\nNameplate');
    await page.evaluate(() => {
      const app = window.skylineForge;
      app.settings.nameplate.title = 'NEW YORK';
      app.settings.nameplate.subtitle = '40.7549° N  73.9840° W';
      app.syncUi();
      app.onChange('geometry');
    });
    await page.waitForTimeout(700);
    await page.waitForFunction(() => !window.skylineForge.busy);
    const label = await page.evaluate(() =>
      window.skylineForge.model.parts.find((p) => p.id === 'label'));
    ok('lettering becomes real geometry', label && label.triangleCount > 200,
      `${label?.triangleCount || 0} triangles`);
    await page.evaluate(() => window.skylineForge.viewer.setView('top'));
    await page.waitForTimeout(500);
    await page.screenshot({ path: join(SHOTS, '05-nameplate.png') });

    /* ---------- exports ---------- */
    console.log('\nExports');
    for (const format of ['3mf', 'stl', 'stl-parts', 'obj']) {
      const result = await page.evaluate(
        (fmt) =>
          import('./js/export/index.js').then(({ buildExport }) => {
            const app = window.skylineForge;
            const { blob, filename } = buildExport(fmt, app.model.parts, {
              title: app.settings.nameplate.title,
            });
            return { size: blob.size, filename, type: blob.type };
          }),
        format
      );
      ok(`${format} exports`, result.size > 5000,
        `${result.filename}, ${(result.size / 1024).toFixed(0)} kB`);
    }

    const download = await Promise.all([
      page.waitForEvent('download', { timeout: 30000 }),
      page.click('#export-btn'),
    ]).then(([d]) => d);
    ok('the Download button produces a file',
      download.suggestedFilename().endsWith('.3mf'), download.suggestedFilename());

    /* ---------- share link ---------- */
    console.log('\nShare link');
    const restored = await page.evaluate(() => {
      const app = window.skylineForge;
      const url = app.writeHash();
      const saved = location.hash;
      location.hash = url.split('#')[1];
      const parsed = app.readHash();
      location.hash = saved;
      return { title: parsed?.nameplate?.title, lat: parsed?.location?.lat, length: url.length };
    });
    ok('a share link round-trips every setting',
      restored.title === 'NEW YORK' && Math.abs(restored.lat - FIXTURE.lat) < 1e-6,
      `${restored.length} characters`);

    /* ---------- persistence ---------- */
    console.log('\nReload');
    await page.reload({ waitUntil: 'load' });
    await page.waitForFunction(() => window.skylineForge !== undefined, { timeout: 20000 });
    const persisted = await page.evaluate(() => window.skylineForge.settings.nameplate.title);
    ok('settings survive a reload', persisted === 'NEW YORK', `got "${persisted}"`);

    /* ---------- console hygiene ---------- */
    console.log('\nConsole');
    const real = errors.filter((e) => !/favicon/i.test(e));
    ok('no console errors across the whole run', real.length === 0,
      real.slice(0, 4).join(' | '));

    await page.waitForFunction(
      () => window.skylineForge.model?.parts?.length > 0 && !window.skylineForge.busy,
      { timeout: 150000 }
    );
    await page.evaluate(() => window.skylineForge.viewer.setView('iso'));
    await page.waitForTimeout(600);
    await page.screenshot({ path: join(SHOTS, '06-final.png') });
    console.log(`\n    Screenshots in ${SHOTS}`);
  } catch (err) {
    failures++;
    console.log(`\n  ✗ run threw: ${err.message}`);
    if (errors.length) console.log(`    console: ${errors.slice(0, 5).join(' | ')}`);
    await page.screenshot({ path: join(SHOTS, 'failure.png') }).catch(() => {});
  } finally {
    if (!process.argv.includes('--keep')) await browser.close();
    server.close();
  }

  console.log(`\n${failures ? '✗' : '✓'} ${checks - failures}/${checks} checks passed\n`);
  process.exit(failures ? 1 : 0);
})();

/** Playwright's bundled Chromium moves around between images. */
async function findChromium() {
  const roots = [process.env.PLAYWRIGHT_BROWSERS_PATH, '/opt/pw-browsers'].filter(Boolean);
  for (const root of roots) {
    let entries;
    try {
      entries = await readdir(root);
    } catch {
      continue;
    }
    for (const entry of entries.filter((e) => e.startsWith('chromium'))) {
      for (const candidate of ['chrome-linux/chrome', 'chrome-linux/headless_shell']) {
        const path = join(root, entry, candidate);
        try {
          await readFile(path, { flag: 'r' });
          return path;
        } catch { /* keep looking */ }
      }
    }
  }
  return undefined; // fall back to Playwright's own resolution
}
