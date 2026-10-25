/* Fixed spatial workspace acceptance. All data and uploads live in the isolated UI fixture. */
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
server.stderr.on("data", (data) => (stderr += data));
const checks = [],
  errors = [];
async function check(name, fn) {
  await fn();
  checks.push(name);
  console.log("PASS " + name);
}
(async () => {
  const url = await new Promise((resolve, reject) => {
    let output = "";
    const timer = setTimeout(
      () => reject(Error(stderr || "fixture timeout")),
      15000,
    );
    server.once("exit", (code) => reject(Error("fixture exit " + code)));
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
  const context = await browser.newContext({
    viewport: { width: 1440, height: 960 },
    acceptDownloads: true,
  });
  const getBoard = async () =>
    (await context.request.get(url + "/api/boards/default")).json();
  const seed = await getBoard();
  seed.zones = [
    {
      id: "legacy-character-one",
      name: "船长",
      purpose: "character",
      notes: "深蓝制服",
      x: 0,
      y: 0,
      w: 800,
      h: 700,
    },
    {
      id: "legacy-character-two",
      name: "水手",
      purpose: "character",
      notes: "白色帽子",
      x: 900,
      y: 0,
      w: 800,
      h: 700,
    },
    {
      id: "legacy-empty-style",
      name: "风格",
      purpose: "style",
      x: 0,
      y: 900,
      w: 800,
      h: 700,
    },
  ];
  seed.items.push(
    {
      id: "character-one",
      kind: "image",
      role: "reference",
      reference_role: "character",
      zone_id: "legacy-character-one",
      file: "fixture.png",
      x: 40,
      y: 100,
      w: 320,
      h: 300,
    },
    {
      id: "character-two",
      kind: "image",
      role: "reference",
      reference_role: "character",
      zone_id: "legacy-character-two",
      file: "fixture.png",
      x: 940,
      y: 100,
      w: 320,
      h: 300,
    },
  );
  seed.connections = [
    { id: "initial-edge", from: "scene-a", to: "camera-b", label: "镜头" },
  ];
  assert.equal(
    (
      await context.request.put(url + "/api/boards/default", { data: seed })
    ).status(),
    200,
  );
  page = await context.newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => {
    if (m.type() === "error" && !m.text().includes("400 (BAD REQUEST)"))
      errors.push(m.text());
  });
  await page.goto(url);
  await page.waitForFunction(
    () => document.querySelectorAll(".board-card").length === 5,
  );
  const card = (id) => page.locator(`.board-card[data-id="${id}"]`);
  const save = async () => {
    await page.keyboard.press("Control+s");
    await page.waitForFunction(
      () => document.querySelector("#save-state").textContent === "草稿已保存",
    );
    return getBoard();
  };
  const focus = async (id) => {
    const b = await save();
    const item = b.items.find((i) => i.id === id);
    await page
      .locator(`.quadrant-chip[data-zone-id="${item.zone_id}"]`)
      .click();
    await card(id).locator(".card-head").click();
    await page.keyboard.press("f");
  };
  const undo = async () => {
    await page.locator("#canvas").focus();
    await page.keyboard.press("Control+z");
  };
  const closeInfo = () => page.locator("#info-dialog .close-dialog").click();
  const inside = (item, zone) =>
    item.x >= zone.x &&
    item.y >= zone.y &&
    item.x + item.w <= zone.x + zone.w &&
    item.y + item.h <= zone.y + zone.h;
  await check(
    "legacy migration preserves named identity groups, content, edges and maps cards into fixed cells",
    async () => {
      const b = await save();
      assert.equal(b.items.length, 5);
      assert.equal(b.connections.length, 1);
      assert.equal(b.zones.length, 6);
      assert.equal(new Set(b.zones.map((z) => z.slot)).size, b.zones.length);
      for (let slot = 0; slot < 4; slot++)
        assert(b.zones.some((z) => z.slot === slot));
      assert(!b.zones.some((z) => z.id === "legacy-empty-style"));
      assert.equal(
        b.zones.find((z) => z.id === "legacy-character-two").notes,
        "白色帽子",
      );
      assert.notEqual(
        b.items.find((i) => i.id === "character-one").zone_id,
        b.items.find((i) => i.id === "character-two").zone_id,
      );
      for (const item of b.items)
        assert(
          inside(
            item,
            b.zones.find((z) => z.id === item.zone_id),
          ),
          item.id,
        );
      assert.equal(
        await page.locator(".zone-resize,.zone-collapse").count(),
        0,
      );
    },
  );
  await check(
    "quadrants are fixed backgrounds, navigation focuses readable cards",
    async () => {
      await focus("scene-a");
      const before = await save();
      const z = before.zones.find((z) => z.purpose === "scene");
      await page.locator(`.quadrant-chip[data-zone-id="${z.id}"]`).click();
      assert((await card("scene-a").boundingBox()).width >= 300);
      const heading = page.locator(
        `.board-zone[data-zone-id="${z.id}"] .quadrant-title`,
      );
      if (await heading.isVisible()) {
        const box = await heading.boundingBox();
        await page.mouse.move(box.x + 30, box.y + 15);
        await page.mouse.down();
        await page.mouse.move(box.x + 120, box.y + 75);
        await page.mouse.up();
      }
      const after = await save();
      assert.deepEqual(after.zones, before.zones);
    },
  );
  await check(
    "direct purpose and character view move into corresponding space; undo restores",
    async () => {
      await focus("image-c");
      await card("image-c")
        .locator(".card-reference-role")
        .selectOption("character");
      let b = await save(),
        item = b.items.find((i) => i.id === "image-c");
      assert.equal(
        b.zones.find((z) => z.id === item.zone_id).purpose,
        "character",
      );
      assert(
        inside(
          item,
          b.zones.find((z) => z.id === item.zone_id),
        ),
      );
      await focus("image-c");
      await card("image-c")
        .locator(".card-character-view")
        .selectOption("side");
      assert.equal(
        (await save()).items.find((i) => i.id === "image-c").character_view,
        "side",
      );
      await undo();
      await undo();
      b = await save();
      assert.equal(
        b.items.find((i) => i.id === "image-c").reference_role,
        "general",
      );
    },
  );
  await check(
    "single image click selects, double click opens full original without duplicating cards",
    async () => {
      await focus("image-c");
      await card("image-c").locator("img.card-media").click();
      assert.equal(
        await page.locator("#image-dialog").evaluate((el) => el.open),
        false,
      );
      await card("image-c").locator("img.card-media").dblclick();
      await page.waitForFunction(
        () => document.querySelector("#image-preview").naturalWidth === 320,
      );
      assert.equal(
        await page.locator("#image-dialog").evaluate((el) => el.open),
        true,
      );
      assert.equal(await page.locator(".board-card").count(), 5);
      assert.match(
        await page.locator("#image-preview-meta").textContent(),
        /320.*180/,
      );
    },
  );
  await check(
    "copy original writes a PNG blob, permission failure explains download fallback, download is original",
    async () => {
      await page.evaluate(() => {
        window.__originalWrite = navigator.clipboard.write.bind(
          navigator.clipboard,
        );
        navigator.clipboard.write = async (entries) => {
          const blob = await entries[0].getType("image/png");
          window.__copiedPng = {
            type: blob.type,
            size: blob.size,
            signature: Array.from(
              new Uint8Array(await blob.arrayBuffer()).slice(0, 8),
            ),
          };
        };
      });
      await page.locator("#copy-original-image").click();
      await page.waitForFunction(() => window.__copiedPng);
      const png = await page.evaluate(() => window.__copiedPng);
      assert.equal(png.type, "image/png");
      assert.deepEqual(png.signature, [137, 80, 78, 71, 13, 10, 26, 10]);
      assert(png.size > 50);
      await page.evaluate(
        () =>
          (navigator.clipboard.write = async () => {
            throw Error("测试权限拒绝");
          }),
      );
      await page.locator("#copy-original-image").click();
      await page.waitForFunction(() =>
        document
          .querySelector("#image-copy-status")
          .textContent.includes("测试权限拒绝"),
      );
      assert.match(
        await page.locator("#image-copy-status").textContent(),
        /下载/,
      );
      const downloaded = page.waitForEvent("download");
      await page.locator("#download-original-image").click();
      assert.equal((await downloaded).suggestedFilename(), "fixture.png");
      await page.evaluate(
        () => (navigator.clipboard.write = window.__originalWrite),
      );
      await page.locator("#image-dialog .close-dialog").click();
    },
  );
  await check(
    "custom fixed area rename and purpose apply atomically and undo",
    async () => {
      const before = await save();
      await page.locator("#add-zone").click();
      await page.locator("#quadrant-name").fill("色彩实验");
      await page.locator("#quadrant-purpose").selectOption("style");
      await page
        .getByRole("button", { name: "保存区域设置", exact: true })
        .click();
      let b = await save();
      assert.equal(b.zones.length, before.zones.length + 1);
      assert(
        b.zones.some((z) => z.name === "色彩实验" && z.purpose === "style"),
      );
      await undo();
      await undo();
      assert.equal((await save()).zones.length, before.zones.length);
    },
  );
  await check(
    "storyboard sequence, notes, enabled flags persist without changing original file",
    async () => {
      await focus("image-c");
      await card("image-c")
        .locator(".card-reference-role")
        .selectOption("storyboard");
      await page.locator("#selected-shot-order").fill("2");
      await page.locator("#selected-shot-order").press("Tab");
      await page
        .locator("#selected-notes")
        .fill("第二镜：沿海岸向灯塔推进，保持空间方向");
      await page.locator("#selected-enabled").uncheck();
      let b = await save(),
        i = b.items.find((i) => i.id === "image-c");
      assert.equal(i.shot_order, 2);
      assert.equal(i.enabled, false);
      assert.equal(i.file, "fixture.png");
      assert.equal(b.zones.find((z) => z.id === i.zone_id).slot, 3);
      await page.locator("#selected-enabled").check();
      await save();
    },
  );
  await check(
    "input audit shows real thumbnails, text, relationships, storyboard order and exact packet",
    async () => {
      await page.locator("#preview-inputs").click();
      await page.locator(".compiled-prompt").waitFor();
      assert.equal(await page.locator(".manifest-item").count(), 5);
      assert.equal(await page.locator(".generation-notes").count(), 1);
      assert.equal(
        await page
          .locator(".generation-notes")
          .evaluate((element) => element.open),
        false,
      );
      assert.equal(await page.locator(".input-preview > .warning").count(), 0);
      assert.equal(
        await page.evaluate(
          () =>
            !!(
              document
                .querySelector(".compiled-prompt")
                .compareDocumentPosition(
                  document.querySelector(".generation-notes"),
                ) & Node.DOCUMENT_POSITION_FOLLOWING
            ),
        ),
        true,
      );
      assert.equal(await page.locator("img.manifest-preview").count(), 3);
      assert.match(
        await page.locator(".manifest-content").first().textContent(),
        /海边灯塔/,
      );
      assert.match(
        await page
          .locator('.manifest-item[data-item-id="image-c"]')
          .textContent(),
        /分镜顺序：2/,
      );
      assert.match(
        await page.locator(".compiled-prompt").textContent(),
        /第二镜/,
      );
      assert((await page.locator(".manifest-relation").count()) > 0);
      await page
        .locator(".input-packet:not(.generation-notes) summary")
        .click();
      const packet = JSON.parse(
        await page.locator(".input-packet pre").textContent(),
      );
      assert.equal(packet.layout_metadata_sent, false);
      assert.equal(packet.images.length, 3);
      assert(packet.text);
      await closeInfo();
      await page.route(
        "**/api/estimate",
        async (route) => {
          const response = await route.fetch();
          const payload = await response.json();
          payload.warnings.push({
            severity: "error",
            message: "输入不兼容：此处为隔离测试提示",
          });
          await route.fulfill({ response, json: payload });
        },
        { times: 1 },
      );
      await page.locator("#preview-inputs").click();
      await page.locator(".compiled-prompt").waitFor();
      assert.match(
        await page.locator(".input-preview > .warning").textContent(),
        /输入不兼容/,
      );
      await closeInfo();
    },
  );
  await check(
    "existing card drag keeps membership and exact coordinates after reload",
    async () => {
      await focus("scene-a");
      const head = await card("scene-a").locator(".card-head").boundingBox();
      await page.mouse.move(head.x + 110, head.y + 20);
      await page.mouse.down();
      await page.mouse.move(head.x + 155, head.y + 55, { steps: 6 });
      await page.mouse.up();
      const b = await save();
      const positions = b.items.map(({ id, x, y, zone_id }) => ({
        id,
        x,
        y,
        zone_id,
      }));
      await page.reload();
      await page.waitForSelector(".board-card");
      const reloaded = await save();
      assert.deepEqual(
        reloaded.items.map(({ id, x, y, zone_id }) => ({ id, x, y, zone_id })),
        positions,
      );
    },
  );
  await check(
    "organize retains separate named character groups and is undoable",
    async () => {
      const before = await save();
      await page.locator("#organize-board").click();
      let b = await save();
      assert.notEqual(
        b.items.find((i) => i.id === "character-one").zone_id,
        b.items.find((i) => i.id === "character-two").zone_id,
      );
      for (const i of b.items)
        assert(
          inside(
            i,
            b.zones.find((z) => z.id === i.zone_id),
          ),
        );
      await undo();
      b = await save();
      assert.deepEqual(b.items, before.items);
    },
  );
  await check(
    "layout image interface preserves v2 metadata and uses layout quadrant",
    async () => {
      const metadata = {
        version: 2,
        camera: { position: [1, 2, 3] },
        objects: [{ id: "object-1", position: [2, 0, 4] }],
      };
      const created = await page.evaluate(
        async (metadata) =>
          window.LumenBoard.addLayoutReference({
            file: "fixture.png",
            notes: "镜头构图测试",
            layout: metadata,
          }),
        metadata,
      );
      assert.deepEqual(created.layout, metadata);
      assert.equal(created.reference_role, "layout");
      assert.equal(
        await page.evaluate(() => typeof window.LumenBoard.addLayoutVideo),
        "function",
      );
      const b = await save();
      assert.equal(b.zones.find((z) => z.id === created.zone_id).slot, 3);
      await undo();
      await save();
    },
  );
  await check(
    "layout WebM upload and video reference retain metadata; PNG export preserves original video",
    async () => {
      const result = await page.evaluate(async () => {
        const canvas = document.createElement("canvas");
        canvas.width = 320;
        canvas.height = 180;
        const context = canvas.getContext("2d"),
          stream = canvas.captureStream(24),
          chunks = [];
        const recorder = new MediaRecorder(stream, {
          mimeType: "video/webm;codecs=vp8",
        });
        recorder.ondataavailable = (event) => chunks.push(event.data);
        const finished = new Promise((resolve) => (recorder.onstop = resolve));
        recorder.start();
        for (let frame = 0; frame < 24; frame++) {
          context.fillStyle = frame % 2 ? "#345" : "#567";
          context.fillRect(0, 0, 320, 180);
          await new Promise((resolve) => setTimeout(resolve, 42));
        }
        recorder.stop();
        await finished;
        stream.getTracks().forEach((track) => track.stop());
        const body = new FormData();
        body.append(
          "file",
          new Blob(chunks, { type: "video/webm" }),
          "layout-fixture.webm",
        );
        const uploaded = await (
          await fetch("/api/upload", { method: "POST", body })
        ).json();
        const metadata = {
          version: 2,
          objects: [{ id: "actor", position: [1, 0, 2] }],
          camera: { position: [0, 2, 4] },
        };
        const video = await window.LumenBoard.addLayoutVideo({
          file: uploaded.name,
          notes: "摄影机沿海岸移动",
          layout: metadata,
          duration: 0.8,
        });
        const image = await window.LumenBoard.addLayoutReference({
          file: "fixture.png",
          notes: "同一机位静帧",
          layout: metadata,
          itemId: video.id,
        });
        return { video, image };
      });
      assert.notEqual(result.video.id, result.image.id);
      assert.equal(result.video.kind, "video");
      let b = await save();
      assert.equal(b.items.length, 7);
      assert.equal(
        b.items.find((item) => item.id === result.video.id).kind,
        "video",
      );
      await page.locator("#preview-inputs").click();
      await page.locator(".compiled-prompt").waitFor();
      const plan = await page
        .locator(
          `.manifest-item[data-item-id="${result.video.id}"] .manifest-video-plan`,
        )
        .textContent();
      assert.match(plan, /原片.*申请.*实际选用/);
      assert.equal(await page.locator("video.manifest-preview").count(), 1);
      await closeInfo();
      await undo();
      await undo();
      await save();
    },
  );
  await check(
    "clipboard carries relationships and metadata without remigrating the board",
    async () => {
      await focus("image-c");
      await page.keyboard.press("Control+d");
      const b = await save();
      assert.equal(b.items.length, 6);
      const duplicate = b.items.find(
        (i) => i.id !== "image-c" && i.notes?.startsWith("第二镜"),
      );
      assert(duplicate);
      assert.equal(duplicate.shot_order, 2);
      assert.equal(duplicate.reference_role, "storyboard");
      assert.equal(b.zones.length, 6);
      await undo();
      await save();
    },
  );
  await check(
    "large ports can connect by click and audit retains custom relationship",
    async () => {
      await focus("character-one");
      await card("character-one").locator(".card-port.out").click();
      await page.locator("#canvas").focus();
      await page.keyboard.press("Home");
      await card("character-two").locator(".card-port.in").click();
      const b = await save();
      assert(
        b.connections.some(
          (e) => e.from === "character-one" && e.to === "character-two",
        ),
      );
      await undo();
      await save();
    },
  );
  await check(
    "focused and overview workspace remain readable at wide and compact sizes",
    async () => {
      await focus("image-c");
      if (process.env.LUMEN_SCREENSHOT_DIR)
        await page.screenshot({
          path: path.join(
            process.env.LUMEN_SCREENSHOT_DIR,
            "lumen-spatial-focused.png",
          ),
        });
      await page.locator("#arrange-board").click();
      if (process.env.LUMEN_SCREENSHOT_DIR)
        await page.screenshot({
          path: path.join(
            process.env.LUMEN_SCREENSHOT_DIR,
            "lumen-spatial-overview.png",
          ),
        });
      await page.setViewportSize({ width: 1040, height: 720 });
      await focus("scene-a");
      assert((await card("scene-a").boundingBox()).width > 280);
      assert.equal(
        await page.evaluate(
          () => document.documentElement.scrollWidth > innerWidth,
        ),
        false,
      );
      if (process.env.LUMEN_SCREENSHOT_DIR)
        await page.screenshot({
          path: path.join(
            process.env.LUMEN_SCREENSHOT_DIR,
            "lumen-spatial-compact.png",
          ),
        });
    },
  );
  await check("no runtime errors", async () => assert.deepEqual(errors, []));
  console.log(JSON.stringify({ passed: checks.length, checks }, null, 2));
})()
  .catch(async (error) => {
    console.error(error);
    process.exitCode = 1;
    if (page && process.env.LUMEN_SCREENSHOT_DIR)
      await page
        .screenshot({
          path: path.join(
            process.env.LUMEN_SCREENSHOT_DIR,
            "lumen-spatial-failure.png",
          ),
        })
        .catch(() => {});
  })
  .finally(async () => {
    if (browser) await browser.close();
    const exited = once(server, "exit");
    server.stdin.end("quit\n");
    await Promise.race([
      exited,
      new Promise((resolve) => setTimeout(resolve, 4000)),
    ]);
    if (server.exitCode === null) server.kill();
  });
