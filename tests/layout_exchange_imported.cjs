/* Imported source-animation acceptance: generated GLB -> Previs exporter -> real GLTFLoader. */
const assert = require("node:assert/strict"),
  fs = require("node:fs"),
  path = require("node:path"),
  { spawn } = require("node:child_process");
const { chromium } = require(
  process.env.PLAYWRIGHT_MODULE_PATH || "playwright",
);
const root = path.resolve(__dirname, "..");
const server = spawn(
  require('./runtime.cjs').python,
  [path.join(__dirname, "ui_fixture.py")],
  { cwd: root, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] },
);
let browser,
  stderr = "";
server.stderr.on("data", (data) => (stderr += data));
(async () => {
  const url = await new Promise((resolve, reject) => {
    let output = "";
    const timer = setTimeout(
      () => reject(Error(stderr || "fixture timeout")),
      15000,
    );
    server.stdout.on("data", (data) => {
      output += data;
      const match = output.match(/http:\/\/127\.0\.0\.1:\d+/);
      if (match) {
        clearTimeout(timer);
        resolve(match[0]);
      }
    });
  });
  browser = await chromium.launch({ channel: "msedge", headless: true });
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route(url + "/", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: '<script type="importmap">{"imports":{"three":"/static/vendor/three/three.module.js"}}</script><body>Imported animation acceptance</body>',
    }),
  );
  await page.goto(url);
  const encoded = await page.evaluate(async () => {
    const T = await import("/static/vendor/three/three.module.js"),
      { GLTFExporter } = await import(
        "/static/vendor/three/examples/jsm/exporters/GLTFExporter.js"
      );
    const scene = new T.Scene(),
      group = new T.Group();
    group.name = "SourceRoot";
    scene.add(group);
    const mover = new T.Mesh(
      new T.BoxGeometry(),
      new T.MeshStandardMaterial({ color: "#7799bb" }),
    );
    mover.name = "AnimatedMover";
    group.add(mover);
    const clips = [
      new T.AnimationClip("WalkX", 4, [
        new T.VectorKeyframeTrack(
          "SourceRoot.position",
          [0, 4],
          [0, 0, 0, 0, 0, 8],
        ),
        new T.VectorKeyframeTrack(
          "AnimatedMover.position",
          [0, 4],
          [0, 0, 0, 16, 0, 0],
        ),
      ]),
      new T.AnimationClip("LiftY", 4, [
        new T.VectorKeyframeTrack(
          "SourceRoot.position",
          [0, 4],
          [0, 0, 0, 0, 0, -4],
        ),
        new T.VectorKeyframeTrack(
          "AnimatedMover.position",
          [0, 4],
          [0, 0, 0, 0, 24, 0],
        ),
      ]),
    ];
    const buffer = await new GLTFExporter().parseAsync(scene, {
      binary: true,
      animations: clips,
    });
    return Array.from(new Uint8Array(buffer));
  });
  const asset =
    "/api/previs/assets/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/fixture.glb";
  await page.route(url + asset, (route) =>
    route.fulfill({
      contentType: "model/gltf-binary",
      body: Buffer.from(encoded),
    }),
  );
  const results = await page.evaluate(async (asset) => {
    const S = await import("/static/layout-scene.js"),
      E = await import("/static/layout-exchange.js"),
      T = await import("/static/vendor/three/three.module.js"),
      { GLTFLoader } = await import(
        "/static/vendor/three/examples/jsm/loaders/GLTFLoader.js"
      );
    const cases = [
      { name: "default clip 0", animation: {} },
      { name: "explicit clip 1", animation: { clip: 1 } },
      {
        name: "speed and offset",
        animation: { clip: 0, speed: 0.5, offset: 0.5 },
      },
      { name: "disabled", animation: { clip: 1, enabled: false } },
      { name: "clip switch", animation: { clip: 0 }, switchClip: true },
      {
        name: "clip switch with default interpolation",
        animation: { clip: 0 },
        linearClip: true,
      },
      { name: "enable switch", animation: { clip: 1 }, switchEnabled: true },
      {
        name: "animated speed offset",
        animation: { clip: 0, speed: 1, offset: 0 },
        animateTime: true,
      },
    ];
    const reports = [];
    for (const spec of cases) {
      const scene = S.normalizeScene({
        version: 3,
        objects: [
          {
            id: "imported",
            type: "imported",
            position: [3, 2, 1],
            asset: { url: asset },
            animation: spec.animation,
          },
        ],
        sequence: { duration: 1, fps: 12, tracks: [] },
      });
      if (spec.switchClip) {
        S.setKey(scene, "imported", "animation.clip", 0, 0, "step");
        S.setKey(scene, "imported", "animation.clip", 0.5, 1, "step");
      }
      if (spec.linearClip) {
        S.setKey(scene, "imported", "animation.clip", 0, 0);
        S.setKey(scene, "imported", "animation.clip", 0.5, 1);
      }
      if (spec.switchEnabled) {
        S.setKey(scene, "imported", "animation.enabled", 0, true, "step");
        S.setKey(scene, "imported", "animation.enabled", 0.5, false, "step");
      }
      if (spec.animateTime) {
        S.setKey(scene, "imported", "animation.speed", 0, 1);
        S.setKey(scene, "imported", "animation.speed", 1, 2);
        S.setKey(scene, "imported", "animation.offset", 0, 0);
        S.setKey(scene, "imported", "animation.offset", 1, 0.25);
      }
      const blob = await E.exportSceneGLB(scene, { fps: 12 });
      const loaded = await new GLTFLoader().parseAsync(
        await blob.arrayBuffer(),
        "",
      );
      const mixer = new T.AnimationMixer(loaded.scene);
      for (const clip of loaded.animations)
        mixer.clipAction(clip).setLoop(T.LoopOnce, 1).play();
      let mover;
      loaded.scene.traverse((node) => {
        if (node.isMesh) mover = node;
      });
      const points = [];
      for (const time of [0, 0.25, 0.5, 0.75, 0.9166666667]) {
        mixer.setTime(time);
        loaded.scene.updateMatrixWorld(true);
        const record = S.evaluateScene(scene, time).objects[0],
          a = record.animation || {},
          t = Math.max(0, time * (a.speed ?? 1) + (a.offset ?? 0)),
          clip = Math.max(0, Math.min(1, Number(a.clip) || 0));
        const expected = [3, 2, 1];
        if (a.enabled !== false) {
          expected[clip === 0 ? 0 : 1] += (clip === 0 ? 4 : 6) * (t % 4);
          expected[2] += (clip === 0 ? 2 : -1) * (t % 4);
        }
        points.push({
          time,
          expected,
          actual: mover.getWorldPosition(new T.Vector3()).toArray(),
        });
      }
      reports.push({
        name: spec.name,
        animations: loaded.animations.length,
        tracks: loaded.animations.flatMap((clip) =>
          clip.tracks.map((track) => track.name),
        ),
        points,
      });
    }
    return reports;
  }, asset);
  fs.writeFileSync(
    path.join(root, "diagnostics/previs-imported-animation-evidence.json"),
    JSON.stringify(results, null, 2),
  );
  for (const report of results) {
    for (const point of report.points)
      assert(
        Math.hypot(
          ...point.actual.map((n, index) => n - point.expected[index]),
        ) < 1e-4,
        report.name + " " + JSON.stringify(point),
      );
    console.log("PASS " + report.name);
  }
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      passed: results.length + 1,
      samples: results.reduce((sum, item) => sum + item.points.length, 0),
      proof: "diagnostics/previs-imported-animation-evidence.json",
    }),
  );
})()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await browser?.close();
    server.stdin.end("\n");
  });
