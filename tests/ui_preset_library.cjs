/* Public-safe generated fixtures; no production board, library or model activity. */
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs/promises");
const { spawn } = require("node:child_process");
const { once } = require("node:events");
const { chromium } = require(
  process.env.PLAYWRIGHT_MODULE_PATH || "playwright",
);
const root = path.resolve(__dirname, "..");
const server = spawn(
  require("./runtime.cjs").python,
  [path.join(__dirname, "ui_fixture.py")],
  { cwd: root, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] },
);
let stderr = "",
  browser,
  page,
  expectedNetworkError = false;
const checks = [],
  errors = [];
server.stderr.on("data", (chunk) => (stderr += chunk));
async function check(name, run) {
  await run();
  checks.push(name);
  console.log("PASS " + name);
}
(async () => {
  const url = await new Promise((resolve, reject) => {
    let output = "";
    const timer = setTimeout(
      () => reject(Error(stderr || "Fixture timeout")),
      15000,
    );
    server.once("exit", (code) =>
      reject(Error("Fixture exit " + code + stderr)),
    );
    server.stdout.on("data", (chunk) => {
      output += chunk;
      const match = output.match(/http:\/\/127\.0\.0\.1:\d+/);
      if (match) {
        clearTimeout(timer);
        resolve(match[0]);
      }
    });
  });
  browser = await chromium.launch({ channel: "msedge", headless: true });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 960 },
    acceptDownloads: true,
  });
  await context.addInitScript(() =>
    localStorage.setItem("lumen-model-onboarding-seen", "1"),
  );
  page = await context.newPage();
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error" && !expectedNetworkError)
      errors.push(message.text());
  });
  // A small, reproducible illustration drawn solely for this acceptance fixture.
  const image = await page.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 960;
    canvas.height = 540;
    const c = canvas.getContext("2d"),
      sky = c.createLinearGradient(0, 0, 0, 380);
    sky.addColorStop(0, "#102a43");
    sky.addColorStop(1, "#e99776");
    c.fillStyle = sky;
    c.fillRect(0, 0, 960, 540);
    c.fillStyle = "#f5c695";
    c.beginPath();
    c.arc(720, 258, 52, 0, Math.PI * 2);
    c.fill();
    const sea = c.createLinearGradient(0, 340, 0, 540);
    sea.addColorStop(0, "#367282");
    sea.addColorStop(1, "#102739");
    c.fillStyle = sea;
    c.fillRect(0, 340, 960, 200);
    for (let i = 0; i < 22; i++) {
      c.fillStyle = i % 2 ? "#80a7ac55" : "#c2c2a733";
      c.fillRect(30 + i * 27, 357 + i * 7, 140 + i * 8, 2);
    }
    c.fillStyle = "#142f35";
    c.beginPath();
    c.moveTo(0, 540);
    c.lineTo(0, 420);
    c.lineTo(170, 398);
    c.lineTo(290, 438);
    c.lineTo(390, 540);
    c.fill();
    c.fillStyle = "#e9e3cc";
    c.beginPath();
    c.moveTo(155, 400);
    c.lineTo(174, 184);
    c.lineTo(212, 184);
    c.lineTo(233, 400);
    c.closePath();
    c.fill();
    c.fillStyle = "#b85a4f";
    c.fillRect(169, 236, 48, 30);
    c.fillRect(163, 310, 62, 30);
    c.fillStyle = "#1a3b4b";
    c.fillRect(163, 169, 60, 26);
    c.fillStyle = "#f9dfad";
    c.fillRect(173, 174, 39, 16);
    c.fillStyle = "#132e3b";
    c.beginPath();
    c.moveTo(154, 168);
    c.lineTo(193, 139);
    c.lineTo(232, 168);
    c.fill();
    c.fillRect(186, 369, 19, 31);
    return canvas.toDataURL("image/png").split(",")[1];
  });
  const uploaded = await context.request.post(url + "/api/upload", {
    multipart: {
      file: {
        name: "lighthouse-fixture.png",
        mimeType: "image/png",
        buffer: Buffer.from(image, "base64"),
      },
    },
  });
  assert(uploaded.ok(), await uploaded.text());
  const file = (await uploaded.json()).name;
  const read = async () =>
    (await context.request.get(url + "/api/agent/board")).json();
  const replace = async (board) => {
    const current = await read();
    const response = await context.request.put(url + "/api/agent/board", {
      data: { expected_revision: current.revision, board },
    });
    assert(response.ok(), await response.text());
    return response.json();
  };
  const seed = (await read()).board;
  seed.items.find((item) => item.id === "image-c").file = file;
  seed.items.find((item) => item.id === "image-c").reference_role = "scene";
  seed.items.find((item) => item.id === "image-c").notes =
    "海边灯塔 · 暮色海岸 · 暖光与冷海面";
  seed.connections = [
    { id: "fixture-edge", from: "image-c", to: "scene-a", label: "reference" },
  ];
  await replace(seed);
  await page.goto(url);
  await page.waitForFunction(
    () =>
      document.querySelectorAll(".board-card").length === 3 &&
      document.querySelector("#save-state").textContent === "草稿已保存",
  );
  const library = page.locator("#reference-preset-library"),
    editor = page.locator("#reference-preset-editor");
  const waitSaved = () =>
    page.waitForFunction(
      () => document.querySelector("#save-state").textContent === "草稿已保存",
    );
  const save = async () => {
    await page.locator("#canvas").focus();
    await page.keyboard.press("Control+s");
    await waitSaved();
    return (await read()).board;
  };
  let original, presetId;
  await check(
    "save selected named references preserves original cards, configuration and internal links",
    async () => {
      await page.locator("#canvas").focus();
      await page.keyboard.press("Control+a");
      original = await save();
      await page.locator("#save-reference-preset").click();
      await editor.locator("#reference-preset-name").fill("海边灯塔");
      await editor.locator("#reference-preset-category").selectOption("scene");
      await editor
        .locator("#reference-preset-description")
        .fill("暮色中的海岸场景。保留灯塔位置、暖色灯光和缓慢推进的镜头。");
      await editor
        .getByRole("button", { name: "保存预设", exact: true })
        .click();
      await library.locator(".reference-preset-card").waitFor();
      presetId = await library
        .locator(".reference-preset-card")
        .getAttribute("data-preset-id");
      const preset = (
        await (
          await context.request.get(url + "/api/asset-presets/" + presetId)
        ).json()
      ).preset;
      assert.equal(preset.items.length, 3);
      assert.equal(preset.connections.length, 1);
      assert.deepEqual(preset.params, original.params);
      const current = (await read()).board;
      assert.deepEqual(current.items, original.items);
      assert.deepEqual(current.connections, original.connections);
      assert.deepEqual(current.params, original.params);
    },
  );
  await check(
    "search, category filter and metadata rename are visible and reversible",
    async () => {
      const search = library.getByRole("searchbox", { name: "搜索参考预设" });
      await search.fill("不存在的教室");
      await page.waitForFunction(
        () => document.querySelectorAll(".reference-preset-card").length === 0,
      );
      await search.fill("灯塔");
      await library.locator(".reference-preset-card").waitFor();
      await library
        .getByRole("combobox", { name: "预设类别筛选" })
        .selectOption("character");
      await page.waitForFunction(
        () => document.querySelectorAll(".reference-preset-card").length === 0,
      );
      await library
        .getByRole("combobox", { name: "预设类别筛选" })
        .selectOption("scene");
      await library.locator(".reference-preset-card").waitFor();
      await library.getByRole("button", { name: "编辑", exact: true }).click();
      await editor.locator("#reference-preset-name").fill("海边灯塔 · 暮色");
      await editor
        .getByRole("button", { name: "保存预设", exact: true })
        .click();
      await library.getByRole("heading", { name: "海边灯塔 · 暮色" }).waitFor();
    },
  );
  await check(
    "instantiate appends fresh cards and internal links in matching spaces, then undo restores original",
    async () => {
      await library
        .getByRole("button", { name: "加入画板", exact: true })
        .click();
      await library.waitFor({ state: "hidden" });
      await waitSaved();
      const current = (await read()).board;
      assert.equal(current.items.length, 6);
      assert.equal(current.connections.length, 2);
      assert.deepEqual(current.params, original.params);
      assert.deepEqual(current.items.slice(0, 3), original.items);
      const ids = new Set(current.items.map((item) => item.id));
      assert.equal(ids.size, 6);
      const added = current.items.slice(3);
      assert(added.every((item) => item.preset_name === "海边灯塔 · 暮色"));
      for (const item of added) {
        const zone = current.zones.find((zone) => zone.id === item.zone_id);
        assert(zone);
        assert(
          item.x >= zone.x &&
            item.y >= zone.y &&
            item.x + item.w <= zone.x + zone.w &&
            item.y + item.h <= zone.y + zone.h,
        );
      }
      assert(added.some((item) => item.id === current.connections[1].from));
      assert(added.some((item) => item.id === current.connections[1].to));
      await page.locator("#canvas").focus();
      await page.keyboard.press("Control+z");
      await waitSaved();
      assert.deepEqual((await read()).board.items, original.items);
    },
  );
  await check(
    "portable ZIP downloads and imports through the real browser file chooser",
    async () => {
      await page.locator("#open-reference-presets").click();
      await library.locator(".reference-preset-card").waitFor();
      const [download] = await Promise.all([
        page.waitForEvent("download"),
        library.getByRole("link", { name: "导出包" }).click(),
      ]);
      const downloaded = await download.path();
      assert((await fs.stat(downloaded)).size > 1000);
      const [chooser] = await Promise.all([
        page.waitForEvent("filechooser"),
        library.getByRole("button", { name: "导入预设包" }).click(),
      ]);
      await chooser.setFiles(downloaded);
      await page.waitForFunction(
        () => document.querySelectorAll(".reference-preset-card").length === 2,
      );
      assert.deepEqual((await read()).board.items, original.items);
      const card = library.locator(".reference-preset-card").first();
      await card.getByRole("button", { name: "编辑", exact: true }).click();
      await editor
        .locator("#reference-preset-name")
        .fill("灯塔场景 · 可携带素材");
      await editor
        .getByRole("button", { name: "保存预设", exact: true })
        .click();
      await library
        .getByRole("heading", { name: "灯塔场景 · 可携带素材" })
        .waitFor();
    },
  );
  await check(
    "public-safe library screenshot and compact dialog remain readable",
    async () => {
      await fs.mkdir(path.join(root, "docs", "images"), { recursive: true });
      await page.screenshot({
        path: path.join(root, "docs", "images", "preset-library.png"),
        animations: "disabled",
      });
      await page.setViewportSize({ width: 1040, height: 720 });
      assert(
        await library
          .getByRole("button", { name: "关闭参考预设库" })
          .isVisible(),
      );
      assert.equal(
        await page.evaluate(() => document.body.scrollWidth > innerWidth),
        false,
      );
      await page.setViewportSize({ width: 1440, height: 960 });
      await library.getByRole("button", { name: "关闭参考预设库" }).click();
    },
  );
  await check(
    "clean board automatically receives external revision updates",
    async () => {
      const changed = structuredClone((await read()).board);
      changed.items.find((item) => item.id === "scene-a").content =
        "命令行更新的灯塔场景";
      await replace(changed);
      await page.waitForFunction(
        () =>
          document.querySelector('[data-id="scene-a"] textarea')?.value ===
          "命令行更新的灯塔场景",
        {},
        { timeout: 10000 },
      );
      assert.equal(await page.locator("#board-conflict").isVisible(), false);
    },
  );
  await check(
    "dirty local draft detects external changes, survives reload and never silently overwrites",
    async () => {
      expectedNetworkError = true;
      const offline = (route) =>
        route.request().method() === "PUT"
          ? route.fulfill({
              status: 503,
              json: { ok: false, error: "Isolated offline fixture" },
            })
          : route.continue();
      await page.route("**/api/agent/board", offline);
      await page
        .locator('[data-id="scene-a"] textarea')
        .fill("我的尚未同步灯塔细节");
      await page.waitForFunction(() =>
        document.querySelector("#save-state").textContent.includes("待同步"),
      );
      const changed = structuredClone((await read()).board);
      changed.items.find((item) => item.id === "scene-a").content =
        "另一位协作者的新灯塔版本";
      const remote = await replace(changed);
      await page.waitForFunction(
        () => !document.querySelector("#board-conflict").hidden,
        {},
        { timeout: 10000 },
      );
      await page.unroute("**/api/agent/board", offline);
      await page.reload();
      await page.waitForFunction(
        () =>
          document.querySelector('[data-id="scene-a"] textarea')?.value ===
          "我的尚未同步灯塔细节",
      );
      assert(await page.locator("#board-conflict").isVisible());
      assert.equal((await read()).revision, remote.revision);
      const cached = await page.evaluate(() =>
        JSON.parse(localStorage.getItem("lumen-board-v2")),
      );
      assert(cached.dirty);
      assert.notEqual(cached.baseRevision, remote.revision);
      await page.locator("#board-conflict").click();
      const [download] = await Promise.all([
        page.waitForEvent("download"),
        page.getByRole("button", { name: "另存当前草稿 JSON" }).click(),
      ]);
      const savedDraft = JSON.parse(
        await fs.readFile(await download.path(), "utf8"),
      );
      assert.equal(
        savedDraft.items.find((item) => item.id === "scene-a").content,
        "我的尚未同步灯塔细节",
      );
      await page
        .getByRole("button", { name: "载入最新画板（当前版本仍可撤销）" })
        .click();
      await page.waitForFunction(
        () =>
          document.querySelector('[data-id="scene-a"] textarea')?.value ===
          "另一位协作者的新灯塔版本",
      );
      assert.equal(await page.locator("#board-conflict").isVisible(), false);
      await page.locator("#canvas").focus();
      await page.keyboard.press("Control+z");
      await waitSaved();
      assert.equal(
        (await read()).board.items.find((item) => item.id === "scene-a")
          .content,
        "我的尚未同步灯塔细节",
      );
      expectedNetworkError = false;
    },
  );
  await check(
    "a real HTTP 409 pauses autosave without adopting the new revision",
    async () => {
      expectedNetworkError = true;
      const baseline = await read();
      const hidePoll = (route) =>
        route.request().method() === "GET"
          ? route.fulfill({ status: 200, json: baseline })
          : route.continue();
      await page.route("**/api/agent/board", hidePoll);
      const changed = structuredClone(baseline.board);
      changed.items.find((item) => item.id === "scene-a").content =
        "API 已保存的第三版灯塔";
      const remote = await replace(changed);
      const conflict = page.waitForResponse(
        (response) =>
          response.url().endsWith("/api/agent/board") &&
          response.status() === 409,
      );
      await page
        .locator('[data-id="scene-a"] textarea')
        .fill("本地 409 后也不能丢掉的内容");
      await page.locator("#canvas").focus();
      await page.keyboard.press("Control+s");
      await conflict;
      await page.waitForFunction(
        () => !document.querySelector("#board-conflict").hidden,
      );
      assert.equal((await read()).revision, remote.revision);
      const cached = await page.evaluate(() =>
        JSON.parse(localStorage.getItem("lumen-board-v2")),
      );
      assert.equal(cached.baseRevision, baseline.revision);
      assert.equal(
        cached.items.find((item) => item.id === "scene-a").content,
        "本地 409 后也不能丢掉的内容",
      );
      await page.unroute("**/api/agent/board", hidePoll);
      expectedNetworkError = false;
    },
  );
  await check("no unexpected browser errors", async () =>
    assert.deepEqual(errors, []),
  );
  console.log(JSON.stringify({ passed: checks.length, checks }, null, 2));
})()
  .catch((error) => {
    console.error(error);
    console.error(stderr);
    process.exitCode = 1;
  })
  .finally(async () => {
    await browser?.close();
    server.stdin.end("\n");
    await Promise.race([
      once(server, "exit"),
      new Promise((resolve) => setTimeout(resolve, 4000)),
    ]);
    if (server.exitCode === null) server.kill();
  });
