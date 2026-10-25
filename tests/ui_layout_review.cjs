/* Independent visual/interaction review; all scene data lives in the temporary fixture. */
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE_PATH || 'playwright');
const root = path.resolve(__dirname, '..'), out = path.join(root, 'diagnostics');
const server = spawn(require('./runtime.cjs').python, [path.join(__dirname, 'ui_fixture.py')], { cwd: root, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
let browser, stderr = ''; server.stderr.on('data', d => stderr += d);
(async () => {
  const url = await new Promise((resolve, reject) => { let output = ''; const timeout = setTimeout(() => reject(Error(stderr)), 15000); server.stdout.on('data', d => { output += d; const match = output.match(/http:\/\/127\.0\.0\.1:\d+/); if (match) { clearTimeout(timeout); resolve(match[0]); } }); });
  browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--enable-unsafe-swiftshader'] });
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } }), errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(url); await page.waitForFunction(() => !!window.LumenLayout);
  await page.locator('#layout-open').click(); await page.waitForSelector('#layout-canvas');
  const field = async (id, value) => { await page.locator('#' + id).fill(String(value)); await page.locator('#' + id).press('Tab'); };
  const scene = () => page.evaluate(() => window.LumenLayout.getScene());
  const load = async value => { await page.locator('#layout-scene-file').setInputFiles({ name: 'review.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(value)) }); await page.waitForTimeout(180); };
  const capture = async name => { await page.waitForTimeout(200); await page.locator('#layout-canvas').screenshot({ path: path.join(out, name + '.png') }); };
  const make = async (types, preset = 'standing') => page.evaluate(async ({ types, preset }) => {
    const T = await import('/static/vendor/three/three.module.js'), A = await import('/static/layout-assets.js');
    const c = new T.PerspectiveCamera(); c.position.set(0, 1.65, types.length === 1 ? 3.6 : 7.0); c.lookAt(0, 0.95, 0);
    return { version: 2, camera: { position: c.position.toArray(), quaternion: c.quaternion.toArray(), focal: 35 }, lighting: 'studio', sequence: { duration: 2, keys: [], interpolation: 'smooth' }, objects: types.map((type, i) => { const a = A.createAsset(type); A.applyPose(a, preset); const data = { id: 'person-' + i, type, label: type, position: [(i - (types.length - 1) / 2) * 1.25, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1], color: '#8faed0', ...A.serializeRig(a) }; A.disposeAsset(a); return data; }) };
  }, { types, preset });
  await load(await make(['adult_female', 'child_girl', 'strong_adult'])); await capture('layout-review-proportions');
  await load(await make(['adult_female']));
  await page.locator('#layout-pose').selectOption('sitting'); await capture('layout-review-sitting');
  const seated = (await scene()).objects[0].pose.pelvisTranslation;
  await page.locator('#layout-pose').selectOption('standing'); await page.locator('#layout-pose').selectOption('sitting');
  assert.deepEqual((await scene()).objects[0].pose.pelvisTranslation, seated);
  await page.locator('#layout-pose').selectOption('reaching');
  await page.locator('#layout-hand-left').selectOption('peace'); await page.locator('#layout-hand-right').selectOption('fist');
  await capture('layout-review-hands');
  await field('layout-rot-y', 28); await field('layout-scale-x', 1.4); await field('layout-scale-y', 0.9); await field('layout-scale-z', 1.15);
  await page.locator('#layout-ik-mode').check(); await page.locator('#layout-ik-target').selectOption('leftHand');
  await capture('layout-review-ik-scaled');
  await field('layout-scale-x', 1.2);
  await page.waitForTimeout(300);
  const after = await scene();
  const beforeIK = JSON.stringify(after.objects[0].pose);
  await page.locator('#layout-ik-target').selectOption('leftHand');
  let dragged = false;
  for (const amount of [0.04, 0.08, 0.12, 0.18, 0.25, 0.35, 0.5]) {
    const p = await page.evaluate(async amount => {
      const T = await import('/static/vendor/three/three.module.js'), A = await import('/static/layout-assets.js'), s = window.LumenLayout.getScene(), r = s.objects[0];
      const a = A.createAsset(r.type, r); a.position.fromArray(r.position); a.rotation.set(...r.rotation.map(T.MathUtils.degToRad)); a.scale.fromArray(r.scale); a.updateMatrixWorld(true);
      const p = A.getIKTargets(a).find(t => t.id === 'leftHand').object.getWorldPosition(new T.Vector3()); p.x += amount; A.disposeAsset(a);
      const c = new T.PerspectiveCamera(50, 16 / 9, 0.05, 250); c.filmGauge = 36; c.position.fromArray(s.camera.position); c.quaternion.fromArray(s.camera.quaternion); c.setFocalLength(s.camera.focal); c.updateMatrixWorld(); p.project(c);
      const b = document.querySelector('#layout-canvas').getBoundingClientRect(); return { x: b.x + (p.x + 1) * b.width / 2, y: b.y + (1 - p.y) * b.height / 2 };
    }, amount);
    await page.mouse.move(p.x, p.y); await page.mouse.down(); await page.mouse.move(p.x + 35, p.y, { steps: 8 }); await page.mouse.up();
    if (JSON.stringify((await scene()).objects[0].pose) !== beforeIK) { dragged = true; break; }
  }
  assert.ok(dragged, 'transformed person accepts actual IK pointer drag after numeric scale');
  await capture('layout-review-ik-scaled-after-drag');
  await page.locator('#layout-tool-translate').click();
  await page.locator('#layout-lighting').selectOption('daylight'); await capture('layout-review-daylight');
  await page.locator('#layout-lighting').selectOption('cinematic'); await capture('layout-review-cinematic');
  await page.locator('#layout-asset-category').selectOption('furniture');
  await page.locator('.layout-library').screenshot({ path: path.join(out, 'layout-review-library.png') });
  const thumbnail = await page.locator('.layout-asset').first().evaluate(n => ({ height: n.getBoundingClientRect().height, labelHeight: n.querySelector('span').getBoundingClientRect().height }));
  assert.ok(thumbnail.height > 70 && thumbnail.labelHeight > 10, 'thumbnails and labels remain visible');
  fs.writeFileSync(path.join(out, 'layout-review-results.json'), JSON.stringify({ errors, actualIKDrag: dragged, afterNumericTransform: after.objects[0], thumbnail, assets: await page.locator('.layout-asset').count() }, null, 2));
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ errors, screenshots: 8, actualIKDrag: dragged, thumbnail, scale: after.objects[0].scale }));
})().catch(e => { console.error(e); process.exitCode = 1; }).finally(async () => { await browser?.close(); server.stdin.end('quit\n'); setTimeout(() => { if (server.exitCode === null) server.kill(); }, 2000).unref(); });
