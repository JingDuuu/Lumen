/* Offline WebGL contact sheets for original expressions and blocking poses. */
const path = require('node:path'), fs = require('node:fs'), { spawn } = require('node:child_process');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE_PATH || 'playwright');
const root = path.resolve(__dirname, '..'), out = path.join(root, 'diagnostics');
const server = spawn(require('./runtime.cjs').python, [path.join(__dirname, 'ui_fixture.py')], { cwd: root, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
let browser, err = ''; server.stderr.on('data', d => err += d);
(async () => {
  const url = await new Promise((resolve, reject) => { let text = ''; const t = setTimeout(() => reject(Error(err)), 15000); server.stdout.on('data', d => { text += d; const m = text.match(/http:\/\/127\.0\.0\.1:\d+/); if (m) { clearTimeout(t); resolve(m[0]); } }); });
  browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--enable-unsafe-swiftshader'] });
  const page = await browser.newPage({ viewport: { width: 1200, height: 960 } }), errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(url + '/static/layout-assets.js');
  await page.setContent('<style>body{margin:0;background:#172231;color:#e3ebf6;font:16px system-ui}#grid{display:grid;grid-template-columns:repeat(6,1fr)}figure{margin:0;padding:5px}img{width:100%;display:block}figcaption{text-align:center;padding:4px}</style><div id="grid"></div>');
  const faceEvidence = await page.evaluate(async url => {
    const T = await import(url + '/static/vendor/three/three.module.js'), A = await import(url + '/static/layout-assets.js');
    const renderer = new T.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true }); renderer.setSize(320, 320); renderer.outputColorSpace = T.SRGBColorSpace; renderer.toneMapping = T.ACESFilmicToneMapping;
    const scene = new T.Scene(); scene.background = new T.Color('#b9c6d1'); scene.add(new T.HemisphereLight('#ffffff', '#788493', 2.5)); const sun = new T.DirectionalLight('#ffffff', 2.2); sun.position.set(2, 4, 5); scene.add(sun);
    const camera = new T.PerspectiveCamera(30, 1, 0.01, 10), images = [];
    const asset = A.createAsset('adult_female', { id: 'expression-demo' }), rig = asset.userData.rig, head = rig.joints.head.node, parent = head.parent, h = rig.faceRig.height;
    head.removeFromParent(); scene.add(head); camera.position.set(0.014, h * 0.53, h * 2.45); camera.lookAt(0, h * 0.51, 0);
    const count = renderer.info.memory.geometries;
    for (const style of [0, 1]) for (const preset of A.EXPRESSION_PRESETS) {
      A.applyFace(asset, { ...preset.face, style }); renderer.render(scene, camera);
      const image = renderer.domElement.toDataURL(); images.push(image);
      const f = document.createElement('figure'), img = document.createElement('img'), caption = document.createElement('figcaption'); img.src = image; caption.textContent = preset.label + (style ? ' · 立体' : ' · 平面'); f.append(img, caption); document.querySelector('#grid').append(f);
    }
    const geometries = renderer.info.memory.geometries;
    for (let frame = 0; frame < 240; frame++) { A.applyFace(asset, { mouthOpen: (Math.sin(frame / 20) + 1) / 2, browHeight: Math.sin(frame / 30), style: frame / 240 }); renderer.render(scene, camera); }
    const stable = renderer.info.memory.geometries === geometries;
    scene.remove(head); parent.add(head); A.disposeAsset(asset); renderer.dispose();
    return { presets: A.EXPRESSION_PRESETS.length, fields: A.FACE_FIELDS.length, styleModes: 2, distinctImages: new Set(images).size, geometriesStableAcross240Frames: stable, poseCount: A.POSES.length };
  }, url);
  await page.screenshot({ path: path.join(out, 'previs-face-contact-sheet.png'), fullPage: true });
  await page.evaluate(() => { document.querySelector('#grid').replaceChildren(); document.querySelector('#grid').style.gridTemplateColumns = 'repeat(8,1fr)'; });
  await page.evaluate(async url => {
    const T = await import(url + '/static/vendor/three/three.module.js'), A = await import(url + '/static/layout-assets.js');
    const renderer = new T.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true }); renderer.setSize(200, 240); renderer.outputColorSpace = T.SRGBColorSpace; renderer.toneMapping = T.ACESFilmicToneMapping;
    const scene = new T.Scene(); scene.background = new T.Color('#bdc8d1'); scene.add(new T.HemisphereLight('#ffffff', '#62728c', 2.5)); const sun = new T.DirectionalLight('#ffffff', 2); sun.position.set(3, 5, 5); scene.add(sun);
    const camera = new T.PerspectiveCamera(35, 200 / 240, 0.01, 20);
    for (const pose of A.POSES) {
      const asset = A.createAsset('adult_female'); A.applyPose(asset, pose.id); scene.add(asset);
      const bounds = new T.Box3().setFromObject(asset), center = bounds.getCenter(new T.Vector3()), size = bounds.getSize(new T.Vector3()), radius = Math.max(size.x, size.y, size.z) * 1.9;
      camera.position.copy(center).add(new T.Vector3(0.3, 0.18, 1).normalize().multiplyScalar(radius)); camera.lookAt(center); renderer.render(scene, camera);
      const f = document.createElement('figure'), img = document.createElement('img'), caption = document.createElement('figcaption'); img.src = renderer.domElement.toDataURL(); caption.textContent = pose.label; f.append(img, caption); document.querySelector('#grid').append(f); scene.remove(asset); A.disposeAsset(asset);
    }
    renderer.dispose();
  }, url);
  await page.screenshot({ path: path.join(out, 'previs-pose-contact-sheet.png'), fullPage: true });
  fs.writeFileSync(path.join(out, 'previs-assets-visual-evidence.json'), JSON.stringify({ ...faceEvidence, errors }, null, 2));
  console.log(JSON.stringify({ ...faceEvidence, errors }));
  if (errors.length || !faceEvidence.geometriesStableAcross240Frames || faceEvidence.distinctImages !== 24) process.exitCode = 1;
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => { await browser?.close(); server.stdin.end('quit\n'); setTimeout(() => { if (server.exitCode === null) server.kill(); }, 2000).unref(); });
