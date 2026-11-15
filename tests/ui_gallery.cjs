/* Shot gallery acceptance, exclusively against temporary fixture libraries. */
const assert = require("node:assert/strict"),
  path = require("node:path"),
  fs = require("node:fs/promises");
const { spawn } = require("node:child_process"),
  { once } = require("node:events");
const { chromium } = require(
  process.env.PLAYWRIGHT_MODULE_PATH || "playwright",
);
const root = path.resolve(__dirname, ".."),
  server = spawn(
    require("./runtime.cjs").python,
    [path.join(__dirname, "ui_fixture.py")],
    { cwd: root, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] },
  );
let browser,
  page,
  stderr = "",
  expectedNetworkError = false;
server.stderr.on("data", (chunk) => (stderr += chunk));
const checks = [],
  errors = [];
async function check(name, run) {
  await run();
  checks.push(name);
  console.log("PASS " + name);
}
(async () => {
  const url = await new Promise((resolve, reject) => {
    let out = "";
    const timeout = setTimeout(
      () => reject(Error(stderr || "Fixture timeout")),
      15000,
    );
    server.stdout.on("data", (chunk) => {
      out += chunk;
      const match = out.match(/http:\/\/127\.0\.0\.1:\d+/);
      if (match) {
        clearTimeout(timeout);
        resolve(match[0]);
      }
    });
    server.once("exit", (code) =>
      reject(Error("Fixture exit " + code + stderr)),
    );
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
  page.on("console", (msg) => {
    if (msg.type() === "error" && !expectedNetworkError)
      errors.push(msg.text());
  });
  const read = async () =>
    (await context.request.get(url + "/api/agent/board")).json();
  const original = (await read()).board;
  original.items.forEach((item) => {
    if (item.kind === "image") item.h = 280;
  });
  const presets = [];
  for (const [index, name] of ["蓝色大飞鱼", "纸帽女孩"].entries()) {
    const payload = {
      name,
      category: "character",
      description: "隔离测试角色，互不混合身份",
      items: [
        {
          id: "portrait-" + index,
          kind: "image",
          role: "reference",
          reference_role: "character",
          file: "fixture.png",
          notes: name + "的外观参考",
          x: 80 + index * 400,
          y: 160,
          w: 320,
          h: 280,
          zone_id: "shared-people",
        },
        {
          id: "identity-" + index,
          kind: "text",
          role: "char",
          content: name + "保持独立身份与造型。",
          x: 80 + index * 400,
          y: 480,
          w: 320,
          h: 220,
          zone_id: "shared-people",
        },
      ],
      connections: [
        {
          id: "edge-" + index,
          from: "portrait-" + index,
          to: "identity-" + index,
          label: "character_consistency",
        },
      ],
      zones: [
        {
          id: "shared-people",
          name: "人物",
          purpose: "character",
          x: 0,
          y: 0,
          w: 1100,
          h: 900,
          slot: 0,
        },
      ],
      params: original.params,
    };
    const response = await context.request.post(url + "/api/asset-presets", {
      data: payload,
    });
    assert(response.ok(), await response.text());
    const preset = (await response.json()).preset;
    presets.push(preset);
    original.items.push(
      ...payload.items.map((item) => ({
        ...item,
        preset_id: preset.id,
        preset_name: name,
      })),
    );
    original.connections.push(...payload.connections);
  }
  original.zones = [
    {
      id: "shared-people",
      name: "人物",
      purpose: "character",
      x: 0,
      y: 0,
      w: 1100,
      h: 900,
      slot: 0,
      collapsed: false,
      notes: "不应被当作同一身份",
    },
  ];
  const current = await read();
  const seeded = await context.request.put(url + "/api/agent/board", {
    data: { expected_revision: current.revision, board: original },
  });
  assert(seeded.ok(), await seeded.text());
  await page.goto(url);
  await page.waitForFunction(
    () =>
      window.LumenBoard?.getState().loaded &&
      document.querySelectorAll(".shot-asset").length === 4,
  );
  await page.waitForFunction(
    () => document.querySelector("#save-state").textContent === "草稿已保存",
  );
  const board = async () => page.evaluate(() => window.LumenBoard.getState());
  const saved = async () => {
    await page.evaluate(() => window.LumenBoard.save());
    return (await read()).board;
  };
  const card = (index) =>
    page.locator(`.shot-asset[data-asset-id="${presets[index].id}"]`);
  await check(
    "legacy data and positions survive while two characters in one zone stay separate",
    async () => {
      const value = await saved();
      assert.equal(value.items.length, 7);
      assert.deepEqual(value.connections, original.connections);
      assert.deepEqual(value.zones, original.zones);
      for (const item of original.items) {
        const now = value.items.find((row) => row.id === item.id);
        for (const key of ["x", "y", "w", "h", "file", "content", "role"])
          assert.equal(now[key], item[key], key + " " + item.id);
      }
      const people = await page.evaluate(() =>
        window.LumenBoard.getCharacters(),
      );
      assert.equal(people.length, 2);
      assert.notEqual(people[0].character_id, people[1].character_id);
      assert(people.every((person) => person.items.length === 2));
      assert.equal(await page.locator(".canvas-stage").isVisible(), false);
      assert.equal(await page.locator("#confirm-expensive").count(), 0);
    },
  );
  await check(
    "include and remove from a shot affect the entity together and remain undoable",
    async () => {
      await card(0)
        .getByRole("button", { name: "移出镜头", exact: true })
        .click();
      await page.waitForFunction(
        (id) =>
          window.LumenBoard.getState()
            .items.filter((item) => item.preset_id === id)
            .every((item) => item.asset_enabled === false),
        presets[0].id,
      );
      assert(
        (await board()).items
          .filter((item) => item.preset_id === presets[1].id)
          .every(
            (item) => item.enabled !== false && item.asset_enabled !== false,
          ),
      );
      await card(0)
        .getByRole("button", { name: "加入镜头", exact: true })
        .click();
      await page.locator("#undo-board").click();
      await page.waitForFunction(
        (id) =>
          window.LumenBoard.getState()
            .items.filter((item) => item.preset_id === id)
            .every((item) => item.asset_enabled === false),
        presets[0].id,
      );
      await page.locator("#redo-board").click();
    },
  );
  await check(
    "double click removes only this board entity, preserves its preset and original media, undo restores",
    async () => {
      await card(0).locator(".asset-cover").dblclick();
      await page.waitForFunction(
        () =>
          document.querySelectorAll(".shot-asset[data-character-id]").length ===
          1,
      );
      assert.equal((await board()).items.length, 5);
      assert(
        (
          await context.request.get(url + "/api/asset-presets/" + presets[0].id)
        ).ok(),
      );
      assert((await context.request.get(url + "/input/fixture.png")).ok());
      await page.locator("#undo-board").click();
      await card(0).waitFor();
      assert.equal((await board()).connections.length, 2);
    },
  );
  await check(
    "explicit enlargement opens original preview and text double clicks preserve editing",
    async () => {
      await card(0).getByRole("button", { name: "放大", exact: true }).click();
      await page.locator("#image-dialog").waitFor({ state: "visible" });
      await page.keyboard.press("Escape");
      const description = page.getByRole("textbox", {
        name: "画面描述",
        exact: true,
      });
      await description.fill("蓝色大飞鱼与纸帽女孩走进教室，镜头平稳推进。");
      await description.dblclick();
      assert.equal((await board()).items.length, 7);
      assert(await description.isVisible());
      await page.locator("#shot-workspace").focus();
      await saved();
    },
  );
  await check(
    "clipboard, delete and undo shortcuts preserve grouped identity and internal links",
    async () => {
      const before = await board();
      await card(0).locator("h3").click();
      await page.keyboard.press("Control+c");
      await page.keyboard.press("Control+v");
      await page.waitForFunction(
        (count) => window.LumenBoard.getState().items.length === count,
        before.items.length + 2,
      );
      const copied = await board();
      assert.equal(copied.connections.length, before.connections.length + 1);
      assert.equal(
        new Set(copied.items.map((item) => item.id)).size,
        copied.items.length,
      );
      assert.equal(
        copied.items.filter((item) => item.asset_id === presets[0].id).length,
        4,
      );
      await page.locator("#shot-workspace").focus();
      await page.keyboard.press("Control+z");
      assert.deepEqual((await board()).items, before.items);
      await card(0).locator("h3").click();
      await page.keyboard.press("Control+x");
      await page.waitForFunction(
        (count) => window.LumenBoard.getState().items.length === count,
        before.items.length - 2,
      );
      await page.keyboard.press("Control+v");
      await page.waitForFunction(
        (count) => window.LumenBoard.getState().items.length === count,
        before.items.length,
      );
      await page.locator("#shot-workspace").focus();
      await page.keyboard.press("Control+z");
      await page.keyboard.press("Control+z");
      assert.deepEqual((await board()).items, before.items);
      await card(0).locator("h3").click();
      await page.keyboard.press("Delete");
      assert.equal((await board()).items.length, before.items.length - 2);
      await page.keyboard.press("Control+z");
      assert.deepEqual((await board()).items, before.items);
      await page.keyboard.press("Control+s");
      await saved();
    },
  );
  await check(
    "dialogue, music and silent mode persist with the correct independent speaker",
    async () => {
      await page.getByRole("button", { name: "添加声音", exact: true }).click();
      let row = page.locator(".shot-sound-row").last();
      await row
        .getByRole("combobox", { name: "声音类型" })
        .selectOption("dialogue");
      const person = (
        await page.evaluate(() => window.LumenBoard.getCharacters())
      )[0];
      await row
        .getByRole("combobox", { name: "说话角色" })
        .selectOption(person.character_id);
      await row
        .getByRole("textbox", { name: "声音内容" })
        .fill("我们终于到教室了。");
      await page.locator("#shot-workspace").focus();
      await page.getByRole("button", { name: "添加声音", exact: true }).click();
      row = page.locator(".shot-sound-row").last();
      await row
        .getByRole("combobox", { name: "声音类型" })
        .selectOption("music");
      await row
        .getByRole("textbox", { name: "声音内容" })
        .fill("轻柔钢琴，缓慢节奏，温暖而有期待。");
      await page.locator("#shot-workspace").focus();
      await page.locator("#shot-audio-mode").selectOption("silent");
      let value = await saved();
      assert.equal(value.params.audio_mode, "silent");
      assert.equal(
        value.items.find((item) => item.audio_type === "dialogue").speaker_id,
        person.character_id,
      );
      await page.reload();
      await page.waitForFunction(() => window.LumenBoard?.getState().loaded);
      assert.equal(
        await page.locator("#shot-audio-mode").inputValue(),
        "silent",
      );
      await page.locator("#shot-audio-mode").selectOption("generated");
      await page.waitForFunction(
        () => document.querySelectorAll(".shot-sound-row").length === 2,
      );
    },
  );
  await check(
    "library adds or subtracts a character without duplicating or deleting the permanent preset",
    async () => {
      await page.locator("#open-reference-presets").click();
      const library = page.locator("#reference-preset-library"),
        entry = library.locator(`[data-preset-id="${presets[0].id}"]`);
      await entry.waitFor();
      await entry
        .getByRole("button", { name: "移出镜头", exact: true })
        .click();
      await entry
        .getByRole("button", { name: "加入镜头", exact: true })
        .click();
      assert.equal(
        (await board()).items.filter((item) => item.preset_id === presets[0].id)
          .length,
        2,
      );
      await entry.locator(".preset-preview").dblclick();
      assert.equal(
        (await board()).items.filter((item) => item.preset_id === presets[0].id)
          .length,
        0,
      );
      assert(
        (
          await context.request.get(url + "/api/asset-presets/" + presets[0].id)
        ).ok(),
      );
      await library.getByRole("button", { name: "关闭参考预设库" }).click();
      await page.locator("#undo-board").click();
      await card(0).waitFor();
    },
  );
  await check("entity drag ordering and undo preserve references", async () => {
    const before = (await board()).items.map((item) => item.id);
    await card(1).locator(".asset-drag-handle").dragTo(card(0));
    await page.waitForTimeout(100);
    const after = (await board()).items.map((item) => item.id);
    assert.notDeepEqual(after, before);
    await page.locator("#undo-board").click();
    assert.deepEqual(
      (await board()).items.map((item) => item.id),
      before,
    );
  });
  await check(
    "natural prompt preview includes both character references and associated dialogue",
    async () => {
      await page.locator("#preview-inputs").click();
      await page.waitForFunction(() =>
        document
          .querySelector(".compiled-prompt")
          ?.textContent.includes("教室"),
      );
      const text = await page.locator(".compiled-prompt").textContent();
      assert(text.includes("蓝色大飞鱼"));
      assert(text.includes("纸帽女孩"));
      assert(text.includes("我们终于到教室了"));
      assert(!text.includes("[文字"));
      assert(await page.locator(".input-manifest").isVisible());
      await page.keyboard.press("Escape");
    },
  );
  await check(
    "group activation preserves disabled provenance and alternative references, including old all-disabled groups",
    async () => {
      const identity = (
        await page.evaluate(() => window.LumenBoard.getCharacters())
      )[0];
      const extraIds = await page.evaluate(async (identity) => {
        const provenance = window.LumenBoard.addText(
          "extra",
          "资料与来源：测试署名文字不应进入生成",
        );
        window.LumenBoard.updateItems(
          [provenance.id],
          {
            asset_id: identity.asset_id,
            preset_id: identity.asset_id,
            character_id: identity.character_id,
            enabled: false,
          },
          false,
        );
        const blob = await (await fetch("/input/fixture.png")).blob();
        const added = await window.LumenBoard.uploadFiles([
          new File([blob], "alternative.png", { type: "image/png" }),
        ]);
        window.LumenBoard.updateItems(
          [added[0].id],
          {
            asset_id: identity.asset_id,
            preset_id: identity.asset_id,
            character_id: identity.character_id,
            reference_role: "character",
            enabled: false,
          },
          false,
        );
        return [provenance.id, added[0].id];
      }, identity);
      const mask = (await board()).items
        .filter((item) => item.asset_id === identity.asset_id)
        .map((item) => [item.id, item.enabled !== false]);
      assert.equal(
        await card(0).locator(".shot-asset-description").innerText(),
        identity.description,
      );
      await card(0)
        .getByRole("button", { name: "移出镜头", exact: true })
        .click();
      let value = await board();
      assert(
        value.items
          .filter((item) => item.asset_id === identity.asset_id)
          .every((item) => item.asset_enabled === false),
      );
      const disabledEstimate = await context.request.post(
        url + "/api/estimate",
        {
          data: { ...value, params: { ...value.params, audio_mode: "silent" } },
        },
      );
      assert(disabledEstimate.ok(), await disabledEstimate.text());
      const disabledManifest = (await disabledEstimate.json()).input_manifest;
      assert(
        disabledManifest
          .filter((entry) => mask.some(([id]) => id === entry.item_id))
          .every((entry) => entry.included === false),
      );
      await card(0)
        .getByRole("button", { name: "加入镜头", exact: true })
        .click();
      value = await board();
      assert.deepEqual(
        value.items
          .filter((item) => item.asset_id === identity.asset_id)
          .map((item) => [item.id, item.enabled !== false]),
        mask,
      );
      const estimate = await context.request.post(url + "/api/estimate", {
        data: value,
      });
      assert(estimate.ok(), await estimate.text());
      const compiled = await estimate.json();
      assert(!compiled.compiled_prompt.includes("测试署名文字"));
      assert(
        compiled.input_manifest
          .filter((entry) => extraIds.includes(entry.item_id))
          .every((entry) => entry.included === false),
      );
      const groupIds = mask.map(([id]) => id);
      await page.evaluate(
        (ids) => window.LumenBoard.updateItems(ids, { enabled: false }),
        groupIds,
      );
      await card(0)
        .getByRole("button", { name: "选择生成参考", exact: true })
        .click();
      assert.equal(
        await page
          .locator("#gallery-editor input[type=checkbox]:checked")
          .count(),
        0,
      );
      const main = identity.items.find((item) => item.kind === "image").id;
      await page
        .locator(
          `#gallery-editor [data-item-id="${main}"] input[type=checkbox]`,
        )
        .check();
      assert.equal(
        (await board()).items.filter(
          (item) => groupIds.includes(item.id) && item.enabled !== false,
        ).length,
        1,
      );
      await page
        .locator("#gallery-editor")
        .getByRole("button", { name: "完成", exact: true })
        .click();
      await page.evaluate(
        ({ mask, extraIds }) => {
          for (const [id, enabled] of mask)
            window.LumenBoard.updateItems([id], { enabled }, false);
          window.LumenBoard.removeItems(extraIds);
        },
        { mask, extraIds },
      );
    },
  );
  await check(
    "one click validates and submits once; invalid inputs and unavailable models never submit",
    async () => {
      let mode = "valid",
        submitted = 0;
      const calls = [];
      const estimate = (route) => {
        calls.push("estimate");
        return mode === "invalid"
          ? route.fulfill({
              status: 400,
              json: { ok: false, error: "隔离测试：无效的参考组合" },
            })
          : route.fulfill({
              status: 200,
              json: {
                ok: true,
                model_mode: "ref2va",
                model_available: mode !== "missing",
                frames: 56,
                actual_duration: 2.333,
                requires_confirmation: true,
                warnings: ["隔离测试耗时提示"],
                estimate_label: "测试估算",
              },
            });
      };
      const submit = (route) => {
        submitted++;
        calls.push("generate");
        assert.equal(
          route.request().postDataJSON().confirm_expensive,
          undefined,
        );
        return route.fulfill({
          status: 200,
          json: { ok: true, id: "fixture-only" },
        });
      };
      await page.route("**/api/estimate", estimate);
      await page.route("**/api/generate", submit);
      await page
        .getByRole("textbox", { name: "画面描述", exact: true })
        .fill("蓝色大飞鱼与纸帽女孩走进教室，一次点击生成。");
      await page.locator("#shot-workspace").focus();
      const posted = page.waitForResponse((response) =>
        response.url().endsWith("/api/generate"),
      );
      await page
        .getByRole("button", { name: "开始生成镜头", exact: true })
        .click();
      await posted;
      await page.waitForFunction(
        () => !document.querySelector("#generate").disabled,
      );
      assert.deepEqual(calls, ["estimate", "generate"]);
      assert.equal(submitted, 1);
      expectedNetworkError = true;
      mode = "invalid";
      await page
        .getByRole("textbox", { name: "画面描述", exact: true })
        .fill("隔离测试无效配置");
      await page.locator("#shot-workspace").focus();
      const invalid = page.waitForResponse(
        (response) =>
          response.url().endsWith("/api/estimate") && response.status() === 400,
      );
      await page.locator("#generate").click();
      await invalid;
      await page.waitForFunction(
        () => !document.querySelector("#generate").disabled,
      );
      assert.equal(submitted, 1);
      mode = "missing";
      await page
        .getByRole("textbox", { name: "画面描述", exact: true })
        .fill("蓝色大飞鱼与纸帽女孩走进教室，镜头平稳推进。");
      await page.locator("#shot-workspace").focus();
      const missing = page.waitForResponse((response) =>
        response.url().endsWith("/api/estimate"),
      );
      await page.locator("#generate").click();
      await missing;
      await page.waitForFunction(
        () => !document.querySelector("#generate").disabled,
      );
      assert.equal(submitted, 1);
      await page.unroute("**/api/estimate", estimate);
      await page.unroute("**/api/generate", submit);
      expectedNetworkError = false;
    },
  );
  await check(
    "active tasks stay visible above the disabled CTA, cancellation is shared, and completion restores generation",
    async () => {
      let task = {
          id: "fixture-active-only",
          status: "running",
          stage: "sampling",
          stage_label: "正在采样",
          progress: { step: 3, total: 8, percent: 37.5 },
          elapsed_seconds: 12,
        },
        cancels = 0,
        submissions = 0;
      const tasksRoute = (route) => route.fulfill({ json: [task] });
      const cancelRoute = (route) => {
        cancels++;
        task = { ...task, status: "cancelling" };
        return route.fulfill({ json: { ok: true, task } });
      };
      const generateRoute = (route) => {
        submissions++;
        return route.fulfill({ json: { ok: true, record_id: "unexpected" } });
      };
      await page.route("**/api/tasks", tasksRoute);
      await page.route("**/api/tasks/fixture-active-only/cancel", cancelRoute);
      await page.route("**/api/generate", generateRoute);
      await page.evaluate(() => refreshTasks());
      const dock = page.locator("#generation-progress");
      await dock.waitFor({ state: "visible" });
      assert((await dock.textContent()).includes("采样 3 / 8 步"));
      assert(await page.locator("#generate").isDisabled());
      await page.evaluate(() => generate());
      assert.equal(submissions, 0);
      task = { ...task, progress: { step: 5, total: 8, percent: 62.5 } };
      await page.evaluate(() => refreshTasks());
      await page.waitForFunction(() =>
        document
          .querySelector("#generation-progress")
          .textContent.includes("采样 5 / 8 步"),
      );
      await page.setViewportSize({ width: 1040, height: 720 });
      await page
        .locator(".inspector-content")
        .evaluate((element) => (element.scrollTop = element.scrollHeight));
      const box = await dock.boundingBox(),
        cta = await page.locator("#generate").boundingBox();
      assert(
        box.y > 0 && box.y + box.height <= cta.y && cta.y + cta.height <= 720,
      );
      await page.waitForFunction(
        () => !document.querySelector("#toast").classList.contains("show"),
      );
      await page
        .locator(".inspector-content")
        .evaluate((element) => (element.scrollTop = 0));
      await page
        .locator("#shot-workspace")
        .evaluate((element) => (element.scrollTop = 0));
      await page.waitForTimeout(400);
      await page.screenshot({
        path: path.join(root, "diagnostics", "gallery-active-progress.png"),
      });
      await dock.getByRole("button", { name: "查看任务", exact: true }).click();
      assert(await page.locator("#task-list").isVisible());
      await page.evaluate(() => setPage("board"));
      await dock.getByRole("button", { name: "取消", exact: true }).click();
      await page.waitForFunction(() =>
        document
          .querySelector("#generation-progress")
          .textContent.includes("等待引擎停止"),
      );
      assert.equal(cancels, 1);
      assert(
        await dock
          .getByRole("button", { name: "正在取消…", exact: true })
          .isDisabled(),
      );
      task = {
        ...task,
        status: "done",
        stage: "done",
        stage_label: "已完成",
        progress: { step: 8, total: 8, percent: 100 },
      };
      await page.evaluate(() => refreshTasks());
      await dock.waitFor({ state: "hidden" });
      assert(await page.locator("#generate").isEnabled());
      assert.equal(
        await page.locator("#generate").textContent(),
        "开始生成镜头",
      );
      await page.unroute("**/api/tasks", tasksRoute);
      await page.unroute(
        "**/api/tasks/fixture-active-only/cancel",
        cancelRoute,
      );
      await page.unroute("**/api/generate", generateRoute);
      await page.evaluate(() => refreshTasks());
      await page.setViewportSize({ width: 1440, height: 960 });
    },
  );
  await check(
    "zone notes and descriptions invalidate the compiled prompt signature",
    async () => {
      const signatures = await page.evaluate(() => {
        const zones = structuredClone(state.zones);
        const result = [generationSignature()];
        state.zones[0].notes = "隔离测试：场景补充说明";
        result.push(generationSignature());
        state.zones[0].description = "隔离测试：温暖午后的教室";
        result.push(generationSignature());
        state.zones = zones;
        return result;
      });
      assert.equal(new Set(signatures).size, 3);
    },
  );
  await check(
    "character identity reaches the real 3D reference and pose proxy",
    async () => {
      const identity = (
        await page.evaluate(() => window.LumenBoard.getCharacters())
      )[0];
      await card(0)
        .getByRole("button", { name: "放入 3D", exact: true })
        .click();
      await page.locator("#layout-dialog").waitFor({ state: "visible" });
      await page.waitForFunction(
        (id) =>
          window.LumenLayout.getScene().objects.filter(
            (item) => item.character_id === id,
          ).length >= 2,
        identity.character_id,
      );
      const objects = await page.evaluate(
        (id) =>
          window.LumenLayout.getScene().objects.filter(
            (item) => item.character_id === id,
          ),
        identity.character_id,
      );
      assert(objects.every((item) => item.asset_id === identity.asset_id));
      assert(objects.some((item) => item.reference?.kind === "image"));
      assert(objects.some((item) => item.reference?.kind === "proxy"));
      await page.locator("#layout-close").click();
    },
  );
  await check(
    "large readable gallery and compact desktop screenshots have no overflow",
    async () => {
      const collapse = page.locator("#sound-expand");
      if (
        (await collapse.count()) &&
        (await collapse.getAttribute("aria-expanded")) === "true"
      )
        await collapse.click();
      await page
        .locator("#shot-workspace")
        .evaluate((element) => (element.scrollTop = 0));
      await page
        .locator(".inspector-content")
        .evaluate((element) => (element.scrollTop = 0));
      await saved();
      await page.waitForFunction(
        () => !document.querySelector("#toast").classList.contains("show"),
      );
      await page.waitForTimeout(250);
      await fs.mkdir(path.join(root, "diagnostics"), { recursive: true });
      await page.screenshot({
        path: path.join(root, "diagnostics", "gallery-wide.png"),
      });
      assert.equal(
        await page.evaluate(() => document.body.scrollWidth > innerWidth),
        false,
      );
      assert(await page.locator("#generate").isVisible());
      await page.setViewportSize({ width: 1040, height: 720 });
      await page.screenshot({
        path: path.join(root, "diagnostics", "gallery-compact.png"),
      });
      assert.equal(
        await page.evaluate(() => document.body.scrollWidth > innerWidth),
        false,
      );
      const box = await page.locator("#generate").boundingBox();
      assert(box.y + box.height <= 720);
      await page.setViewportSize({ width: 1440, height: 960 });
    },
  );
  await check(
    "offline edits recover and a real revision conflict cannot overwrite another editor",
    async () => {
      expectedNetworkError = true;
      const offline = (route) =>
        route.request().method() === "PUT"
          ? route.fulfill({
              status: 503,
              json: { ok: false, error: "Isolated offline acceptance" },
            })
          : route.continue();
      await page.route("**/api/agent/board", offline);
      await page
        .getByRole("textbox", { name: "画面描述", exact: true })
        .fill("离线画面描述仍要完整保留");
      await page.waitForFunction(() =>
        document.querySelector("#save-state").textContent.includes("待同步"),
      );
      await page.reload();
      await page.waitForFunction(
        () =>
          document.querySelector("#shot-description")?.value ===
          "离线画面描述仍要完整保留",
      );
      await page.unroute("**/api/agent/board", offline);
      await page.locator("#shot-workspace").focus();
      await page.keyboard.press("Control+s");
      await saved();
      assert.equal(
        (await read()).board.items.find((item) => item.id === "scene-a")
          .content,
        "离线画面描述仍要完整保留",
      );
      const baseline = await read();
      const freeze = (route) =>
        route.request().method() === "GET"
          ? route.fulfill({ status: 200, json: baseline })
          : route.continue();
      await page.route("**/api/agent/board", freeze);
      const remoteBoard = structuredClone(baseline.board);
      remoteBoard.items.find((item) => item.id === "scene-a").content =
        "另一处已保存的画面";
      const response = await context.request.put(url + "/api/agent/board", {
        data: { expected_revision: baseline.revision, board: remoteBoard },
      });
      assert(response.ok());
      const remote = await response.json();
      const conflict = page.waitForResponse(
        (value) =>
          value.url().endsWith("/api/agent/board") && value.status() === 409,
      );
      await page
        .getByRole("textbox", { name: "画面描述", exact: true })
        .fill("本地冲突草稿不应覆盖另一处");
      await page.locator("#shot-workspace").focus();
      await page.keyboard.press("Control+s");
      await conflict;
      await page.waitForFunction(
        () => !document.querySelector("#board-conflict").hidden,
      );
      assert.equal((await read()).revision, remote.revision);
      await page.unroute("**/api/agent/board", freeze);
      await page.reload();
      await page.waitForFunction(
        () =>
          document.querySelector("#shot-description")?.value ===
          "本地冲突草稿不应覆盖另一处",
      );
      assert(await page.locator("#board-conflict").isVisible());
      await page.locator("#board-conflict").click();
      await page
        .getByRole("button", { name: "载入最新画板（当前版本仍可撤销）" })
        .click();
      await page.waitForFunction(
        () =>
          document.querySelector("#shot-description")?.value ===
          "另一处已保存的画面",
      );
      expectedNetworkError = false;
    },
  );
  await check("no browser runtime errors", async () =>
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
