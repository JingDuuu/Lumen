/* Live board synchronization and agent setup, using only synthetic fixture data. */
const assert = require('node:assert/strict'), path = require('node:path'), fs = require('node:fs/promises');
const {spawn} = require('node:child_process');
const {chromium} = require(process.env.PLAYWRIGHT_MODULE_PATH || 'playwright');
const root = path.resolve(__dirname, '..');
const server = spawn(require('./runtime.cjs').python, [path.join(__dirname, 'ui_fixture.py')], {cwd: root, windowsHide: true, stdio:['pipe','pipe','pipe']});
let browser, page, stderr = '', ignoreErrors = false;
server.stderr.on('data', data => stderr += data);
const checks = [], errors = [];
async function check(name, run) {await run();checks.push(name);console.log('PASS '+name);}
(async () => {
  const url = await new Promise((resolve,reject) => {
    let text = ''; const timer = setTimeout(()=>reject(Error(stderr || 'fixture timeout')),15000);
    server.stdout.on('data',data=>{text+=data;const match=text.match(/http:\/\/127\.0\.0\.1:\d+/);if(match){clearTimeout(timer);resolve(match[0]);}});
  });
  browser = await chromium.launch({channel:'msedge',headless:true});
  const context = await browser.newContext({viewport:{width:1440,height:960}});
  await context.addInitScript(()=>localStorage.setItem('lumen-model-onboarding-seen','1'));
  page = await context.newPage();
  page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error'&&!ignoreErrors)errors.push(m.text());});
  const bootstrap = {ok:true,prompt:'你现在连接的是本机 Lumen。\n先发现能力，再按用户要求生成。',mcp_config:{mcpServers:{lumen:{command:'fixture-python',args:['fixture-mcp.py']}}},api_url:url,output_directory:'C:\\Fixture\\output',connection:{service:'ready',engine_ready:false,models_ready:true},boundary:'Agent 需要本机工具或本机 MCP；纯云端聊天不能仅靠提示词访问电脑。'};
  let bootstrapCalls=0, tasks=[];
  await page.route('**/api/agent/bootstrap',route=>{bootstrapCalls++;return route.fulfill({json:bootstrap});});
  await page.route('**/api/tasks',route=>route.fulfill({json:tasks}));
  await page.route('**/output/video/fixture.mp4',route=>route.fulfill({status:200,body:'',contentType:'video/mp4'}));
  await page.goto(url);
  await page.waitForFunction(()=>window.LumenBoard?.getState().loaded && document.querySelector('#board-overview'));
  await page.evaluate(()=>window.LumenBoard.save());
  const current = ()=>context.request.get(url+'/api/agent/board').then(r=>r.json());
  const state = async()=> (await current()).board;
  let remote=await current();
  const board=structuredClone(remote.board);
  board.items.push(...['蓝飞鱼','纸帽女孩'].flatMap((name,index)=>[
    {id:'actor-image-'+index,kind:'image',role:'reference',reference_role:'character',file:'fixture.png',character_id:'character-'+index,asset_id:'asset-'+index,character_name:name,enabled:true,asset_enabled:true},
    {id:'actor-note-'+index,kind:'text',role:'char',content:name+'的外观说明',character_id:'character-'+index,asset_id:'asset-'+index,enabled:true,asset_enabled:true},
    {id:'source-'+index,kind:'text',role:'extra',content:'资料来源，不参与生成',character_id:'character-'+index,asset_id:'asset-'+index,enabled:false,asset_enabled:true},
  ]));
  await check('external agent board changes appear automatically without a reload',async()=>{
    const save=await context.request.put(url+'/api/agent/board',{data:{expected_revision:remote.revision,request_id:'agent-board-fixture',board}});assert.equal(save.status(),200);
    await page.waitForFunction(()=>document.querySelectorAll('.cast-tile').length===2,null,{timeout:12000});
    assert.equal(await page.locator('.board-cast-heading').innerText(),'这一镜的角色\n2 / 2 位参与');
    assert((await page.locator('#board-overview').innerText()).includes('2 个角色'));
  });
  await check('character quick controls preserve provenance exclusions and undo',async()=>{
    await page.getByRole('button',{name:'停用 蓝飞鱼',exact:true}).click();
    await page.evaluate(()=>window.LumenBoard.save());
    let data=await state();const members=data.items.filter(i=>i.character_id==='character-0');
    assert(members.every(i=>i.asset_enabled===false));assert.equal(members.find(i=>i.id==='source-0').enabled,false);
    await page.getByRole('button',{name:'启用 蓝飞鱼',exact:true}).click();await page.evaluate(()=>window.LumenBoard.save());
    data=await state();assert.equal(data.items.find(i=>i.id==='source-0').enabled,false);
    await page.locator('#shot-workspace').focus();await page.keyboard.press('Control+z');
    await page.waitForFunction(()=>!window.LumenBoard.getCharacters().find(c=>c.character_id==='character-0').enabled);
    await page.keyboard.press('Control+Shift+z');await page.waitForFunction(()=>window.LumenBoard.getCharacters().find(c=>c.character_id==='character-0').enabled);
    await page.locator('.cast-tile').first().locator('.cast-edit').click();await page.locator('#gallery-editor').waitFor({state:'visible'});
    assert((await page.locator('#gallery-editor').innerText()).includes('编辑 蓝飞鱼'));await page.getByRole('button',{name:'完成',exact:true}).click();
  });
  await check('add character opens the reusable library with character filtering',async()=>{
    await page.locator('#board-add-character').click();assert.equal(await page.getByLabel('预设类别筛选').inputValue(),'character');
    await page.getByRole('button',{name:'关闭参考预设库',exact:true}).click();
  });
  await check('agent setup copies the actual prompt and MCP config without claiming an agent is online',async()=>{
    assert.equal(bootstrapCalls,0);
    await page.evaluate(()=>{navigator.clipboard.writeText=async text=>{window.fixtureCopied=text;};});
    await page.locator('#agent-connect-open').click();await page.locator('#agent-bootstrap-prompt').waitFor({state:'visible'});
    assert.equal(await page.locator('#agent-bootstrap-prompt').inputValue(),bootstrap.prompt);
    await page.getByRole('button',{name:'复制提示词',exact:true}).click();assert.equal(await page.evaluate(()=>window.fixtureCopied),bootstrap.prompt);
    assert((await page.locator('.agent-connection-status').innerText()).includes('H3 引擎 · 待就绪'));
    assert(!(await page.locator('#agent-connect-dialog').innerText()).includes('Agent 已连接'));
    await page.locator('.agent-config-details summary').click();await page.getByRole('button',{name:'复制配置',exact:true}).click();
    assert.deepEqual(JSON.parse(await page.evaluate(()=>window.fixtureCopied)),bootstrap.mcp_config);
    assert((await page.locator('.agent-output-folder').innerText()).includes(bootstrap.output_directory));
    await page.getByRole('button',{name:'关闭 Agent 连接',exact:true}).click();
  });
  await check('agent tasks and completed local results update the overview and open in Lumen',async()=>{
    tasks=[{id:'agent-task',title:'海边的双人镜头',status:'running',source:{kind:'agent',client_name:'Fixture Agent'},stage_label:'正在采样',progress:{step:3,total:8,percent:38},outputs:[]}];
    await page.waitForFunction(()=>document.querySelectorAll('.board-stage')[1]?.textContent.includes('采样 3 / 8 步'),null,{timeout:12000});
    await page.locator('.board-stage').nth(1).click();assert((await page.locator('#task-list').innerText()).includes('来自 Fixture Agent'));
    await page.locator('[data-page=board]').click();tasks=[{...tasks[0],status:'done',stage_label:'生成完成',outputs:[{sub:'video',name:'fixture.mp4'}]}];
    await page.waitForFunction(()=>document.querySelectorAll('.board-stage')[2]?.textContent.includes('海边的双人镜头'),null,{timeout:12000});
    await page.locator('.board-stage').nth(2).click();await page.locator('#asset-dialog').waitFor({state:'visible'});assert.equal(await page.locator('#asset-title').innerText(),'海边的双人镜头');
    await page.keyboard.press('Escape');
  });
  await check('wide and compact board layouts keep direct character and agent controls usable',async()=>{
    await fs.mkdir(path.join(root,'diagnostics'),{recursive:true});
    await page.locator('#shot-workspace').evaluate(el=>el.scrollTop=0);await page.mouse.move(800,75);await page.waitForFunction(()=>!document.querySelector('#toast').classList.contains('show'),null,{timeout:7000});await page.waitForTimeout(250);await page.screenshot({path:path.join(root,'diagnostics','agent-board-wide.png')});
    await page.setViewportSize({width:1040,height:720});assert.equal(await page.evaluate(()=>document.body.scrollWidth>innerWidth),false);
    const add=await page.locator('#board-add-character').boundingBox(),connect=await page.locator('#agent-connect-open').boundingBox();assert(add.width>=80&&add.height>=80);assert(connect.x+connect.width<=1040);
    await page.screenshot({path:path.join(root,'diagnostics','agent-board-compact.png')});
    await page.locator('#agent-connect-open').click();await page.locator('#agent-bootstrap-prompt').waitFor({state:'visible'});
    await page.waitForTimeout(250);await page.screenshot({path:path.join(root,'diagnostics','agent-connect-panel.png')});
  });
  assert.deepEqual(errors,[]);console.log('PASS no browser errors');
  await fs.writeFile(path.join(root,'diagnostics','agent-board-results.json'),JSON.stringify({checks,errors},null,2));
})().catch(async error=>{console.error(error);if(page)await page.screenshot({path:path.join(root,'diagnostics','agent-board-failure.png')}).catch(()=>{});process.exitCode=1;}).finally(async()=>{await browser?.close();server.stdin.end('quit\n');setTimeout(()=>{if(server.exitCode===null)server.kill();},2000).unref();});
