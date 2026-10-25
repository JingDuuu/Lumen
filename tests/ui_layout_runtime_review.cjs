/* Isolated runtime review: never connects to the real 8088 app or model engine. */
const path = require('node:path'), fs = require('node:fs'), { spawn } = require('node:child_process');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE_PATH || 'playwright');
const root = path.resolve(__dirname, '..'), out = path.join(root, 'diagnostics');
const fixture = spawn(require('./runtime.cjs').python, [path.join(__dirname, 'ui_fixture.py')], { cwd: root, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
let browser, errors = '', result = {}; fixture.stderr.on('data', d => errors += d);
(async () => {
  const url = await new Promise((resolve, reject) => { let text = ''; const timer = setTimeout(() => reject(Error(errors)), 15000); fixture.stdout.on('data', d => { text += d; const m = text.match(/http:\/\/127\.0\.0\.1:\d+/); if (m) { clearTimeout(timer); resolve(m[0]); } }); });
  browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--enable-unsafe-swiftshader'] });
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } }); result.browserErrors = [];
  page.on('pageerror', e => result.browserErrors.push(e.message));
  await page.addInitScript(() => {
    window.__previsBuffers = { created: 0, deleted: 0 };
    for (const prototype of [WebGLRenderingContext.prototype, WebGL2RenderingContext.prototype]) {
      const create = prototype.createBuffer, remove = prototype.deleteBuffer;
      prototype.createBuffer = function (...args) { window.__previsBuffers.created++; return create.apply(this, args); };
      prototype.deleteBuffer = function (...args) { window.__previsBuffers.deleted++; return remove.apply(this, args); };
    }
  });
  await page.goto(url); await page.waitForFunction(() => !!window.LumenLayout);
  await page.evaluate(async () => {
    const T = await import('/static/vendor/three/three.module.js'), render = T.WebGLRenderer.prototype.render;
    T.WebGLRenderer.prototype.render = function (scene, camera) {
      const value = render.call(this, scene, camera);
      window.__previsLastRender = { environment: !!scene.environment, geometries: this.info.memory.geometries, textures: this.info.memory.textures, camera: camera.position.toArray(), objects: scene.children.map(o => o.name) };
      return value;
    };
  });
  await page.locator('#layout-open').click(); await page.waitForSelector('#layout-canvas');
  const scene = { version: 3, name: 'Runtime review', objects: [{ id: 'actor', type: 'adult_female', position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] }], viewport: { playhead: 2 }, sequence: { duration: 4, fps: 24, tracks: [{ id: 'motion', targetId: 'actor', property: 'position', interpolation: 'linear', keys: [{ id: 'a', time: 0, value: [0, 0, 0] }, { id: 'b', time: 4, value: [10, 5, 0] }] }] } };
  await page.evaluate(value => window.LumenLayout.loadScene(value), scene);
  await page.waitForTimeout(200);
  result.beforeSingleAxisEdit = await page.evaluate(() => window.LumenLayout.getEvaluatedScene().objects[0].position);
  await page.locator('#detail-actor-position-0').fill('6'); await page.locator('#detail-actor-position-0').press('Tab'); await page.waitForTimeout(200);
  result.afterSingleAxisEdit = await page.evaluate(() => window.LumenLayout.getEvaluatedScene().objects[0].position);
  result.preservedUneditedAxes = result.afterSingleAxisEdit[1] === result.beforeSingleAxisEdit[1];
  await page.evaluate(value => window.LumenLayout.loadScene(value), scene);
  const baseline = await page.evaluate(() => JSON.stringify(window.LumenLayout.getScene().objects));
  await page.locator('#layout-play').click(); await page.waitForTimeout(400); await page.locator('#layout-play').click();
  result.playbackPreservesBaseObjects = baseline === await page.evaluate(() => JSON.stringify(window.LumenLayout.getScene().objects));
  result.afterPlaybackMemory = await page.evaluate(() => window.__previsLastRender);
  const parentScene = { version: 3, objects: [{ id: 'group', type: 'group', position: [0.1, 0, 0], rotation: [0, 25, 0], scale: [1.25, 0.9, 1.1] }, { id: 'actor', type: 'adult_female', parentId: 'group', position: [0, 0, 0], rotation: [0, 10, 0], scale: [1, 1, 1] }], sequence: { duration: 4, fps: 24, tracks: [] } };
  await page.evaluate(value => window.LumenLayout.loadScene(value), parentScene); await page.waitForTimeout(200);
  const target = await page.evaluate(async () => {
    const T = await import('/static/vendor/three/three.module.js'), A = await import('/static/layout-assets.js'), s = window.LumenLayout.getScene();
    const p = s.objects.find(o => o.id === 'group'), r = s.objects.find(o => o.id === 'actor'), parent = new T.Group(), asset = A.createAsset(r.type, r);
    parent.position.fromArray(p.position); parent.rotation.set(...p.rotation.map(T.MathUtils.degToRad)); parent.scale.fromArray(p.scale); parent.add(asset);
    asset.position.fromArray(r.position); asset.rotation.set(...r.rotation.map(T.MathUtils.degToRad)); asset.scale.fromArray(r.scale); parent.updateMatrixWorld(true);
    const point = A.getIKTargets(asset).find(t => t.id === 'leftHand').object.getWorldPosition(new T.Vector3());
    const b = document.querySelector('#layout-canvas').getBoundingClientRect(), camera = new T.PerspectiveCamera(50, b.width / b.height, 0.05, 1000), c = s.viewport.editorCamera;
    camera.filmGauge = 36; camera.position.fromArray(c.position); camera.quaternion.fromArray(c.quaternion); camera.setFocalLength(c.focal); camera.updateMatrixWorld();
    const projected = point.clone().project(camera), x = b.x + (projected.x + 1) * b.width / 2, y = b.y + (1 - projected.y) * b.height / 2;
    const ray = new T.Raycaster(); ray.setFromCamera(new T.Vector2(2 * (x - 24 - b.x) / b.width - 1, 1 - 2 * (y - 14 - b.y) / b.height), camera);
    const end = ray.ray.intersectPlane(new T.Plane().setFromNormalAndCoplanarPoint(camera.getWorldDirection(new T.Vector3()), point), new T.Vector3());
    A.disposeAsset(asset); return { x, y, end: end.toArray() };
  });
  const poseBefore = await page.evaluate(() => JSON.stringify(window.LumenLayout.getScene().objects.find(o => o.id === 'actor').pose));
  await page.mouse.move(target.x, target.y); await page.mouse.down(); await page.mouse.move(target.x - 24, target.y - 14, { steps: 12 }); await page.mouse.up(); await page.waitForTimeout(100);
  result.parentedIK = await page.evaluate(async ({ target, poseBefore }) => {
    const T = await import('/static/vendor/three/three.module.js'), A = await import('/static/layout-assets.js'), s = window.LumenLayout.getScene(), r = s.objects.find(o => o.id === 'actor'), p = s.objects.find(o => o.id === 'group');
    const parent = new T.Group(), asset = A.createAsset(r.type, r); parent.position.fromArray(p.position); parent.rotation.set(...p.rotation.map(T.MathUtils.degToRad)); parent.scale.fromArray(p.scale); parent.add(asset); asset.position.fromArray(r.position); asset.rotation.set(...r.rotation.map(T.MathUtils.degToRad)); asset.scale.fromArray(r.scale); parent.updateMatrixWorld(true);
    const reached = A.getIKTargets(asset).find(t => t.id === 'leftHand').object.getWorldPosition(new T.Vector3()); A.disposeAsset(asset);
    return { poseChanged: JSON.stringify(r.pose) !== poseBefore, worldError: reached.distanceTo(new T.Vector3(...target.end)) };
  }, { target, poseBefore });
  await page.evaluate(async () => {
    const S = await import('/static/layout-scene.js'), s = window.LumenLayout.getScene();
    S.setKey(s, 'actor', 'face.mouthOpen', 0, 0); S.setKey(s, 'actor', 'face.mouthOpen', 4, 0.8);
    S.setKey(s, 'actor', 'pose.leftElbow', 0, [-7, 0, 0]); S.setKey(s, 'actor', 'pose.leftElbow', 4, [-90, 0, 0]);
    await window.LumenLayout.loadScene(s);
  });
  await page.waitForTimeout(400); const buffersBefore = await page.evaluate(() => ({ ...window.__previsBuffers }));
  await page.locator('#layout-play').click(); await page.waitForTimeout(600); await page.locator('#layout-play').click();
  result.playbackBuffers = { before: buffersBefore, after: await page.evaluate(() => window.__previsBuffers) };
  await page.locator('#layout-canvas').screenshot({ path: path.join(out, 'previs-runtime-parented-ik.png') });
  let gltfStarted = false;
  await page.route('**/api/previs/assets/review-delayed.glb', async route => {
    gltfStarted = true; await new Promise(resolve => setTimeout(resolve, 1200));
    await route.fulfill({ status: 200, contentType: 'model/gltf+json', body: JSON.stringify({ asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ name: 'DelayedModel' }] }) });
  });
  await page.evaluate(() => {
    window.__staleOutliner = [];
    new MutationObserver(() => { if (document.querySelector('#layout-object-list').textContent.includes('STALE')) window.__staleOutliner.push('STALE'); }).observe(document.querySelector('#layout-object-list'), { childList: true, subtree: true });
    window.__delayedScene = window.LumenLayout.loadScene({ version: 3, objects: [{ id: 'old-import', type: 'imported', label: 'STALE', asset: { url: '/api/previs/assets/review-delayed.glb' } }], sequence: { duration: 2, tracks: [] } });
  });
  while (!gltfStarted) await new Promise(resolve => setTimeout(resolve, 20));
  await page.evaluate(() => window.LumenLayout.loadScene({ version: 3, objects: [{ id: 'fresh-box', type: 'box', label: 'FRESH' }], sequence: { duration: 2, tracks: [] } }));
  await page.waitForTimeout(1500);
  result.sceneSwitch = await page.evaluate(() => ({ staleOutlinerUpdates: window.__staleOutliner.length, objectId: window.LumenLayout.getScene().objects[0].id, visibleLabel: document.querySelector('#layout-object-list').textContent }));
  let hdriStarted = false, hdriFinished = false;
  await page.route('**/static/hdri/studio_small_09_1k.hdr', async route => { hdriStarted = true; await new Promise(resolve => setTimeout(resolve, 1800)); await route.continue(); hdriFinished = true; });
  const envScene = { ...scene, viewport: { playhead: 0 }, environment: { hdri: 'studio_small_09', background: true }, sequence: { duration: 2, fps: 24, tracks: [] } };
  await page.evaluate(value => window.LumenLayout.loadScene(value), envScene);
  const uploaded = page.waitForRequest(r => r.url().endsWith('/api/upload') && r.method() === 'POST');
  const uploadedResponse = page.waitForResponse(r => r.url().endsWith('/api/upload') && r.request().method() === 'POST');
  await page.locator('#layout-save').click(); await uploaded;
  result.exportDuringHDRLoad = { hdriStarted, hdriFinished, render: await page.evaluate(() => window.__previsLastRender) };
  const uploadedFile = await (await uploadedResponse).json();
  const image = await page.request.get(url + '/input/' + uploadedFile.name);
  fs.writeFileSync(path.join(out, 'previs-runtime-clean-export.png'), await image.body());
  await page.waitForTimeout(2000);
  fs.writeFileSync(path.join(out, 'previs-runtime-review.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => { await browser?.close(); fixture.stdin.end('quit\n'); setTimeout(() => { if (fixture.exitCode === null) fixture.kill(); }, 2000).unref(); });
