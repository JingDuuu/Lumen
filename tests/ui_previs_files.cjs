/* File modal acceptance against the temporary Flask library; no real user files. */
const assert = require("node:assert/strict");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { once } = require("node:events");
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
  page,
  stderr = "";
server.stderr.on("data", (value) => (stderr += value));
(async () => {
  const url = await new Promise((resolve, reject) => {
    let text = "";
    const timer = setTimeout(() => reject(Error(stderr)), 15000);
    server.stdout.on("data", (chunk) => {
      text += chunk;
      const match = text.match(/http:\/\/127\.0\.0\.1:\d+/);
      if (match) {
        clearTimeout(timer);
        resolve(match[0]);
      }
    });
  });
  browser = await chromium.launch({ channel: "msedge", headless: true });
  page = await browser.newPage({ viewport: { width: 1400, height: 950 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/file-ui-test", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: '<link rel="stylesheet" href="/static/style.css"><link rel="stylesheet" href="/static/layout.css"><div id="file-mount"></div>',
    }),
  );
  await page.goto(url + "/file-ui-test");
  await page.evaluate(async () => {
    const { mountFileUI } = await import("/static/layout-file-ui.js");
    window.__scene = {
      version: 3,
      objects: [
        { id: "parent", type: "group", parentId: null },
        { id: "child", type: "cube", parentId: "parent" },
        { id: "outside", type: "sphere", parentId: null },
      ],
      sequence: {
        fps: 12,
        duration: 1,
        tracks: [
          { targetId: "child", keys: [] },
          { targetId: "outside", keys: [] },
        ],
      },
    };
    window.__exports = [];
    window.__cancelled = 0;
    window.__files = mountFileUI(document.querySelector("#file-mount"), {
      getScene: () => window.__scene,
      loadScene: (scene) => (window.__loaded = scene),
      getSelection: () => ["parent"],
      addPrefab: (scene) => (window.__prefab = scene),
      onImportAsset: () => {},
      exportGLB: (options) => {
        window.__exports.push({
          fps: options.fps,
          includeAnimation: options.includeAnimation,
        });
        options.onProgress({
          stage: "烘焙测试进度",
          frame: 2,
          totalFrames: 13,
          progress: 30,
        });
        return new Promise(
          (resolve, reject) => (window.__rejectExport = reject),
        );
      },
      cancelExport: () => {
        window.__cancelled++;
        window.__rejectExport(Error("导出已取消"));
      },
    });
  });
  await page.getByRole("button", { name: "文件 / 模板", exact: true }).click();
  await page.getByLabel("场景名称").fill("场景原件");
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await page.waitForFunction(() =>
    document
      .querySelector(".previs-file-progress")
      .textContent.includes("已保存"),
  );
  let docs = (
    await (await page.request.get(url + "/api/previs/documents")).json()
  ).documents;
  assert.equal(docs.length, 1);
  await page.getByLabel("场景名称").fill("另存副本");
  await page.getByRole("button", { name: "另存为", exact: true }).click();
  await page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/previs/documents") &&
      response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "保存为模板", exact: true }).click();
  await page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/previs/documents") &&
      response.request().method() === "POST",
  );
  await page
    .getByRole("button", { name: "选中层级存为预制体", exact: true })
    .click();
  await page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/previs/documents") &&
      response.request().method() === "POST",
  );
  docs = (await (await page.request.get(url + "/api/previs/documents")).json())
    .documents;
  assert.equal(docs.length, 4);
  const prefab = docs.find((doc) => doc.kind === "prefab");
  const saved = (
    await (
      await page.request.get(url + "/api/previs/documents/" + prefab.id)
    ).json()
  ).document;
  assert.deepEqual(
    saved.scene.objects.map((item) => item.id),
    ["parent", "child"],
  );
  assert.equal(saved.scene.sequence.tracks.length, 1);
  console.log(
    "PASS save, save-as, template and hierarchical prefab persist in temporary library",
  );
  assert.equal(await page.getByLabel("导出帧率").inputValue(), "12");
  await page.getByRole("button", { name: "导出当前场景", exact: true }).click();
  assert(
    await page
      .getByRole("button", { name: "导出当前场景", exact: true })
      .isDisabled(),
  );
  assert.match(
    await page.locator(".previs-file-progress").textContent(),
    /烘焙测试进度.*2\/13.*30%/,
  );
  await page
    .getByRole("button", { name: "取消导出 / 转换", exact: true })
    .click();
  await page.waitForFunction(() =>
    document
      .querySelector(".previs-file-progress")
      .textContent.includes("导出已取消"),
  );
  assert.equal(await page.evaluate(() => window.__cancelled), 1);
  console.log(
    "PASS modal bake progress, cancellation and duplicate export guard",
  );
  await page.getByLabel("包含动画").uncheck();
  await page.getByLabel("导出帧率").fill("30");
  await page.getByRole("button", { name: "导出当前场景", exact: true }).click();
  assert.deepEqual(await page.evaluate(() => window.__exports.at(-1)), {
    fps: 30,
    includeAnimation: false,
  });
  await page
    .getByRole("button", { name: "取消导出 / 转换", exact: true })
    .click();
  await page.waitForFunction(() =>
    document
      .querySelector(".previs-file-progress")
      .textContent.includes("导出已取消"),
  );
  console.log("PASS export FPS and static model option reach exporter");
  await page.evaluate(() => (window.__scene.sequence.duration = 400));
  await page.getByLabel("包含动画").check();
  await page.getByRole("button", { name: "导出当前场景", exact: true }).click();
  await page.waitForFunction(() =>
    document
      .querySelector(".previs-file-progress")
      .textContent.includes("3600"),
  );
  assert.equal(await page.evaluate(() => window.__exports.length), 2);
  console.log(
    "PASS over-limit animation is blocked with static export guidance",
  );
  assert.deepEqual(errors, []);
  console.log("PASS no runtime errors");
})()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    if (browser) await browser.close();
    const exited = once(server, "exit");
    server.stdin.end("quit\n");
    await Promise.race([
      exited,
      new Promise((resolve) => setTimeout(resolve, 5000)),
    ]);
    if (server.exitCode === null) server.kill();
  });
