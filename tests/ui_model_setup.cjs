/* Model onboarding with intercepted HTTP: no model downloads or real data mutations. */
const assert=require('node:assert/strict'),path=require('node:path'),fs=require('node:fs'),{spawn}=require('node:child_process');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE_PATH||'playwright');
const root=path.resolve(__dirname,'..'),manifest=JSON.parse(fs.readFileSync(path.join(root,'models-manifest.json')));
const server=spawn(require('./runtime.cjs').python,[path.join(__dirname,'ui_fixture.py')],{cwd:root,windowsHide:true,stdio:['pipe','pipe','pipe']});
let browser;server.stderr.on('data',()=>{});
(async()=>{
  const url=await new Promise(resolve=>{let text='';server.stdout.on('data',data=>{text+=data;const match=text.match(/http:\/\/127\.0\.0\.1:\d+/);if(match)resolve(match[0]);});});
  browser=await chromium.launch({channel:'msedge',headless:true});const page=await browser.newPage({viewport:{width:1440,height:960}}),errors=[];
  page.on('pageerror',error=>errors.push(error.message));let installs=0,cancels=0,payload;
  const inventory={...manifest,models:manifest.models.map(model=>({...model,present:false,partial_bytes:0})),models_dir:'D:/Lumen/runtime/ComfyUI/models',free_bytes:200*1024**3,engine_installed:false,paths:{},job:{stage:'idle',active:false}};
  await page.route('**/api/models',route=>route.fulfill({json:inventory}));
  await page.route('**/api/models/install',route=>{installs++;payload=route.request().postDataJSON();inventory.job={stage:'downloading',active:true,label:'Test transfer',expected_bytes:1000,downloaded_bytes:500};return route.fulfill({json:inventory});});
  await page.route('**/api/models/cancel',route=>{cancels++;inventory.job={stage:'cancelled',active:false};return route.fulfill({json:inventory});});
  await page.goto(url);await page.waitForSelector('#model-setup-dialog[open]');assert.equal(installs,0);assert.equal(await page.locator('.model-setup-row').count(),5);
  await page.getByRole('button',{name:'安装所选模型',exact:true}).click();assert.equal(installs,0);assert.match(await page.locator('.model-setup-status').textContent(),/许可/);
  await page.locator('.model-setup-license input').check();await page.getByRole('button',{name:'安装所选模型',exact:true}).click();await page.waitForFunction(()=>document.querySelector('.model-setup-status').textContent.includes('正在下载'));
  assert.equal(installs,1);assert.equal(payload.accept_license,true);assert.deepEqual(payload.models,manifest.models.map(model=>model.id));assert.equal(await page.locator('progress').last().getAttribute('value'),'0.5');
  await page.getByRole('button',{name:'暂停下载',exact:true}).click();assert.equal(cancels,1);await page.waitForTimeout(100);
  await page.screenshot({path:path.join(root,'diagnostics/portable-model-setup.png')});assert.deepEqual(errors,[]);
  fs.writeFileSync(path.join(root,'diagnostics/portable-model-setup.json'),JSON.stringify({passed:5,automaticDownloads:0,explicitInstallRequests:installs,cancelRequests:cancels,errors},null,2));console.log('PASS 5 model onboarding checks; no actual downloads');
})().catch(error=>{console.error(error);process.exitCode=1;}).finally(async()=>{await browser?.close();server.stdin.end('\n');setTimeout(()=>{if(server.exitCode===null)server.kill();},2000).unref();});
