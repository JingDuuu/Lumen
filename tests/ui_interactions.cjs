/* Real browser interaction checks against an isolated local Flask fixture.
 * Uses Playwright from PLAYWRIGHT_MODULE_PATH (or the normal Node module path).
 * Does not touch the user's board, library, engine, or model files.
 */
const assert = require('node:assert/strict');
const path = require('node:path');
const {spawn} = require('node:child_process');
const {once} = require('node:events');
const {chromium} = require(process.env.PLAYWRIGHT_MODULE_PATH || 'playwright');

const root = path.resolve(__dirname, '..');
const python = require('./runtime.cjs').python;
const server = spawn(python, [path.join(__dirname, 'ui_fixture.py')], {
  cwd: root, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
});
let browser;
let stderr = '';
server.stderr.on('data', chunk => stderr += chunk);
const checks = [];

async function check(name, run) {
  await run();
  checks.push(name);
  console.log('PASS ' + name);
}

(async () => {
  const url = await new Promise((resolve, reject) => {
    let output = '';
    const timeout = setTimeout(() => reject(new Error('Fixture startup timeout: ' + stderr)), 15000);
    server.once('exit', code => { clearTimeout(timeout); reject(new Error('Fixture exited ' + code + ': ' + stderr)); });
    server.stdout.on('data', data => {
      output += data;
      const match = output.match(/http:\/\/127\.0\.0\.1:\d+/);
      if (match) { clearTimeout(timeout); resolve(match[0]); }
    });
  });
  browser = await chromium.launch({channel: 'msedge', headless: true});
  const context = await browser.newContext({viewport: {width: 1440, height: 960}});
  const page = await context.newPage();
  const errors = [];
  let expectedOffline = false;
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error' && !expectedOffline) errors.push(message.text()); });
  await page.goto(url);
  const cards = page.locator('.board-card');
  await page.waitForFunction(() => document.querySelectorAll('.board-card').length === 3);
  const board = async () => (await context.request.get(url + '/api/boards/default')).json();
  const save = async () => {
    const written = page.waitForResponse(response => response.url().endsWith('/api/agent/board') && response.request().method() === 'PUT');
    await page.keyboard.press('Control+s');
    const response = await written;
    assert.equal(response.status(), 200, await response.text());
    await page.waitForFunction(() => document.querySelector('#save-state').textContent === '草稿已保存');
    return board();
  };
  const focusCard = async id => {
    await page.locator('#fit-board').click();
    await page.locator(`.board-card[data-id="${id}"] .card-head`).click();
  };

  await check('large readable inspector and icon navigation', async () => {
    const measurements = await page.evaluate(() => ({
      font: parseFloat(getComputedStyle(document.querySelector('#resolution')).fontSize),
      body: document.body.scrollWidth,
      viewport: innerWidth,
      icons: document.querySelectorAll('.nav-item[data-page] svg').length,
    }));
    assert(measurements.font >= 16, JSON.stringify(measurements));
    assert(measurements.body <= measurements.viewport, JSON.stringify(measurements));
    assert.equal(measurements.icons, 3);
  });
  if (process.env.LUMEN_VISUAL_ONLY === '1') {
    const folder = process.env.LUMEN_SCREENSHOT_DIR || root;
    await page.screenshot({path: path.join(folder, 'lumen-v3.1-wide.png'), animations: 'disabled'});
    await page.setViewportSize({width: 1040, height: 720});
    await page.screenshot({path: path.join(folder, 'lumen-v3.1-compact.png'), animations: 'disabled'});
    return;
  }

  await check('duplicate, undo, redo and cut/paste are reversible', async () => {
    await focusCard('scene-a');
    await page.keyboard.press('Control+d');
    assert.equal(await cards.count(), 4);
    await page.keyboard.press('Control+z');
    assert.equal(await cards.count(), 3);
    await page.keyboard.press('Control+Shift+z');
    assert.equal(await cards.count(), 4);
    await cards.last().locator('.card-head').click();
    await page.keyboard.press('Control+x');
    assert.equal(await cards.count(), 3);
    await page.keyboard.press('Control+v');
    assert.equal(await cards.count(), 4);
    await page.keyboard.press('Delete');
    assert.equal(await cards.count(), 3);
    await page.keyboard.press('Control+z');
    assert.equal(await cards.count(), 4);
    await page.keyboard.press('Control+Shift+z');
    assert.equal(await cards.count(), 3);
  });

  await check('middle-frame tagging is saved and survives reload', async () => {
    await focusCard('image-c');
    await page.locator('#selected-role').selectOption('middle_frame_2');
    const saved = await save();
    assert.equal(saved.items.find(item => item.id === 'image-c').role, 'middle_frame_2');
    await page.reload();
    await page.waitForFunction(() => document.querySelectorAll('.board-card').length === 3);
    assert.match(await page.locator('.board-card[data-id="image-c"]').innerText(), /中间帧/);
  });

  await check('duplicating a first frame keeps the board valid', async () => {
    await focusCard('image-c');
    await page.locator('#selected-role').selectOption('first_frame');
    await focusCard('image-c');
    await page.keyboard.press('Control+d');
    const saved = await save();
    assert.equal(saved.items.filter(item => item.role === 'first_frame').length, 1);
    assert.equal(saved.items.filter(item => item.kind === 'image' && item.role === 'reference').length, 1);
    await page.keyboard.press('Delete');
    assert.equal(await cards.count(), 3);
    await focusCard('image-c');
    await page.locator('#selected-role').selectOption('middle_frame_2');
  });

  await check('drag a real connection, edit relation and copy connected cards together', async () => {
    await page.locator('#fit-board').click();
    const from = await page.locator('[data-id="scene-a"] .card-port.out').boundingBox();
    const to = await page.locator('[data-id="camera-b"] .card-port.in').boundingBox();
    await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
    await page.mouse.down();
    await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, {steps: 15});
    await page.mouse.up();
    assert.equal(await page.locator('#connections-layer .connection').count(), 1);
    await page.locator('.connection-label').click();
    await page.locator('#connection-label').selectOption('association');
    await focusCard('scene-a');
    await page.locator('[data-id="camera-b"] .card-head').click({modifiers: ['Shift']});
    assert.equal(await page.locator('.board-card.selected').count(), 2);
    await page.keyboard.press('Control+c');
    await page.keyboard.press('Control+v');
    assert.equal(await cards.count(), 5);
    assert.equal(await page.locator('#connections-layer .connection').count(), 2);
    const saved = await save();
    assert.equal(saved.connections.length, 2);
    assert(saved.connections.every(edge => edge.label === 'association'));
    const ids = new Set(saved.items.map(item => item.id));
    assert(saved.connections.every(edge => ids.has(edge.from) && ids.has(edge.to)));
    await page.keyboard.press('Delete');
    assert.equal(await cards.count(), 3);
    assert.equal(await page.locator('#connections-layer .connection').count(), 1);
    await page.keyboard.press('Control+z');
    assert.equal(await cards.count(), 5);
    assert.equal(await page.locator('#connections-layer .connection').count(), 2);
    await page.keyboard.press('Control+Shift+z');
    assert.equal(await cards.count(), 3);
  });

  await check('group dragging moves both cards and undo restores positions', async () => {
    const before = await save();
    await focusCard('scene-a');
    await page.locator('[data-id="camera-b"] .card-head').click({modifiers: ['Shift']});
    const head = await page.locator('[data-id="scene-a"] .card-head').boundingBox();
    await page.mouse.move(head.x + head.width / 2, head.y + head.height / 2);
    await page.mouse.down();
    await page.mouse.move(head.x + head.width / 2 + 44, head.y + head.height / 2 + 28, {steps: 10});
    await page.mouse.up();
    const after = await save();
    const a = before.items.find(item => item.id === 'scene-a');
    const b = before.items.find(item => item.id === 'camera-b');
    const movedA = after.items.find(item => item.id === a.id);
    const movedB = after.items.find(item => item.id === b.id);
    assert(movedA.x > a.x);
    assert.equal(movedA.x - a.x, movedB.x - b.x);
    assert.equal(movedA.y - a.y, movedB.y - b.y);
    await page.keyboard.press('Control+z');
    const restored = await save();
    assert.equal(restored.items.find(item => item.id === a.id).x, a.x);
    assert.equal(restored.items.find(item => item.id === b.id).y, b.y);
  });

  await check('context menu deletes reversibly and Escape dismisses it', async () => {
    await page.keyboard.press('Escape');
    await page.locator('[data-id="camera-b"] .card-head').click({button: 'right'});
    assert(await page.locator('#context-menu').isVisible());
    await page.getByRole('menuitem', {name: /删除/}).click();
    assert.equal(await cards.count(), 2);
    assert.equal(await page.locator('#connections-layer .connection').count(), 0);
    await page.keyboard.press('Control+z');
    assert.equal(await cards.count(), 3);
    assert.equal(await page.locator('#connections-layer .connection').count(), 1);
    await page.locator('[data-id="camera-b"] .card-head').click({button: 'right'});
    await page.keyboard.press('Escape');
    assert(!(await page.locator('#context-menu').isVisible()));
  });

  await check('text shortcuts stay native and save includes current text', async () => {
    const input = page.locator('[data-id="scene-a"] textarea');
    await input.fill('文字输入框保留自己的编辑习惯');
    await page.keyboard.press('Control+a');
    await page.keyboard.type('Native text editing');
    assert.equal(await cards.count(), 3);
    const saved = await save();
    assert.equal(saved.items.find(item => item.id === 'scene-a').content, 'Native text editing');
    await page.keyboard.press('Escape');
  });

  await check('preflight reports real frame alignment and middle-frame guidance', async () => {
    await page.locator('#generate').click();
    await page.waitForFunction(() => document.querySelector('#estimate-badge').textContent === '检查完成');
    const detail = await page.locator('#estimate-detail').innerText();
    assert.match(detail, /56 帧/);
    assert.match(detail, /中间帧/);
    assert.equal(await page.locator('#generate').innerText(), '开始生成镜头');
  });

  await check('navigation, shortcuts and smaller desktop layout remain usable', async () => {
    await page.locator('[data-page="library"]').click();
    assert(await page.locator('#page-library').isVisible());
    await page.locator('[data-page="tasks"]').click();
    assert(await page.locator('#page-tasks').isVisible());
    await page.locator('[data-page="board"]').click();
    await page.locator('#shortcuts-btn').click();
    assert(await page.locator('dialog[open]').isVisible());
    await page.keyboard.press('Escape');
    await page.setViewportSize({width: 1040, height: 720});
    assert(await page.locator('#resolution').isVisible());
    const overflow = await page.evaluate(() => document.body.scrollWidth > innerWidth);
    assert.equal(overflow, false);
    await page.locator('#generate').scrollIntoViewIfNeeded();
    const action = await page.locator('#generate').boundingBox();
    assert(action.y >= 0 && action.y + action.height <= 720, JSON.stringify(action));
    await page.setViewportSize({width: 1440, height: 960});
    await page.locator('.inspector').evaluate(element => { element.scrollTop = 0; });
    await focusCard('scene-a');
    await page.keyboard.press('Home');
    if (process.env.LUMEN_SCREENSHOT_DIR) {
      await page.screenshot({path: path.join(process.env.LUMEN_SCREENSHOT_DIR, 'lumen-v2.1-board.png')});
    }
  });

  await check('unsynced local draft recovers after reload', async () => {
    expectedOffline = true;
    const offline = async route => route.request().method() === 'PUT'
      ? route.fulfill({status: 503, json: {ok: false, error: 'Isolated offline acceptance'}})
      : route.continue();
    await page.route('**/api/agent/board', offline);
    await page.locator('[data-id="scene-a"] textarea').fill('尚未同步也要保留的草稿');
    await page.waitForFunction(() => document.querySelector('#save-state').textContent.includes('待同步'));
    await page.reload();
    await page.waitForFunction(() => document.querySelector('[data-id="scene-a"] textarea')?.value === '尚未同步也要保留的草稿');
    await page.unroute('**/api/agent/board', offline);
    await page.locator('#canvas').focus();
    const saved = await save();
    assert.equal(saved.items.find(item => item.id === 'scene-a').content, '尚未同步也要保留的草稿');
    expectedOffline = false;
  });

  await check('delete during dragging does not leave a broken interaction', async () => {
    await page.keyboard.press('Escape');
    const head = await page.locator('[data-id="camera-b"] .card-head').boundingBox();
    await page.mouse.move(head.x + head.width / 2, head.y + head.height / 2);
    await page.mouse.down();
    await page.mouse.move(head.x + head.width / 2 + 20, head.y + head.height / 2 + 15, {steps: 5});
    await page.keyboard.press('Delete');
    await page.mouse.move(head.x + head.width / 2 + 35, head.y + head.height / 2 + 25, {steps: 5});
    await page.mouse.up();
    assert.equal(await cards.count(), 2);
    await page.keyboard.press('Control+z');
    assert.equal(await cards.count(), 3);
  });

  await check('card limit blocks duplicate without losing a saved board', async () => {
    await save();
    const payload = await board();
    payload.items = Array.from({length: 100}, (_, index) => ({
      id: 'limit-' + index, kind: 'text', role: 'scene', content: '卡片 ' + index,
      x: 30 + index % 10 * 330, y: 30 + Math.floor(index / 10) * 230, w: 300, h: 200,
    }));
    payload.connections = [];
    payload.viewport = {zoom: 1, panX: 0, panY: 0};
    const response = await context.request.put(url + '/api/boards/default', {data: payload});
    assert.equal(response.status(), 200);
    await page.reload();
    await page.waitForFunction(() => document.querySelectorAll('.board-card').length === 100);
    await focusCard('limit-0');
    await page.keyboard.press('Control+d');
    assert.equal(await cards.count(), 100);
    assert.match(await page.locator('#toast').innerText(), /100/);
    assert.equal((await board()).items.length, 100);
  });

  await check('no browser runtime errors', async () => assert.deepEqual(errors, []));
  console.log(JSON.stringify({passed: checks.length, checks}, null, 2));
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  if (browser) await browser.close();
  const exited = once(server, 'exit');
  server.stdin.end('quit\n');
  await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 4000))]);
  if (server.exitCode === null) server.kill();
});
