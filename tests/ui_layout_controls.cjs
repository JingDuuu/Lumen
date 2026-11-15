/* Isolated WebGL acceptance; no production board or generation process. */
const assert=require('node:assert/strict'),path=require('node:path'),fs=require('node:fs');
const {spawn}=require('node:child_process');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE_PATH||'playwright');
const root=path.resolve(__dirname,'..'),out=path.join(root,'diagnostics');
const server=spawn(require('./runtime.cjs').python,[path.join(__dirname,'ui_fixture.py')],{cwd:root,windowsHide:true,stdio:['pipe','pipe','pipe']});
let browser,stderr='';server.stderr.on('data',chunk=>stderr+=chunk);
const results=[],errors=[];
(async()=>{
  const url=await new Promise((resolve,reject)=>{let output='';const timer=setTimeout(()=>reject(Error(stderr||'Fixture timeout')),15000);server.stdout.on('data',chunk=>{output+=chunk;const match=output.match(/http:\/\/127\.0\.0\.1:\d+/);if(match){clearTimeout(timer);resolve(match[0]);}});});
  browser=await chromium.launch({channel:'msedge',headless:true,args:['--enable-unsafe-swiftshader','--use-angle=swiftshader']});
  const page=await browser.newPage({viewport:{width:1440,height:960}});
  page.on('pageerror',error=>{errors.push(error.stack);console.error(error.stack);});
  page.on('console',message=>{if(message.type()==='error')console.error('BROWSER '+message.text());});
  page.on('requestfailed',request=>console.error('REQUEST '+request.url()+' '+request.failure()?.errorText));
  await page.route('**/editor-fixture',route=>route.fulfill({contentType:'text/html',body:`<!doctype html><meta charset=utf-8><link rel=stylesheet href=/static/layout.css><link rel=stylesheet href=/static/layout-controls.css><link rel=stylesheet href=/static/layout-sequence.css><style>body{margin:0;font-family:system-ui}button{cursor:pointer}</style><button id=layout-open>打开</button><dialog id=layout-dialog><div id=layout-editor></div></dialog><script type="importmap">{"imports":{"three":"/static/vendor/three/three.module.js"}}</script><script>window.LumenBoard={getCharacters:()=>[{character_id:'actor-alpha',asset_id:'asset-ref',name:'角色甲',description:'测试参考',image_url:'/input/fixture.png',items:[{id:'ref',file:'fixture.png'}]}],addLayoutReference:async value=>window.exportedReference=value}</script><script type=module src=/static/layout.js></script>`}));
  await page.goto(url+'/editor-fixture');await page.waitForFunction(()=>window.LumenLayout);await page.click('#layout-open');await page.waitForSelector('#layout-canvas');
  const wait=()=>page.waitForTimeout(220),scene=()=>page.evaluate(()=>LumenLayout.getScene());
  const load=async value=>{await page.evaluate(value=>LumenLayout.loadScene(value),value);await wait();};
  const select=async id=>{await page.locator(`.previs-tree-row[data-object-id="${id}"] .previs-tree-label`).click();await wait();};
  const scrub=async(id,dx,button='left',dy=0)=>{const box=await page.locator('#'+id).boundingBox(),x=box.x+box.width/2,y=box.y+box.height/2;await page.mouse.move(x,y);await page.mouse.down({button});if(dy)await page.mouse.move(x,y+dy,{steps:3});await page.mouse.move(x+dx,y+dy,{steps:8});await page.mouse.up({button});await wait();};
  const test=async(name,fn)=>{await fn();results.push(name);console.log('PASS '+name);};
  const base=await scene();
  await test('large numeric controls and direct scrub are one undo',async()=>{
    await select('box-a');const before=(await scene()).objects.find(o=>o.id==='box-a').position;
    const input=page.locator('#detail-box-a-position-0');assert(Number(await input.evaluate(node=>getComputedStyle(node).fontSize.replace('px','')))>=17);
    await scrub('detail-box-a-position-0',48);let after=(await scene()).objects.find(o=>o.id==='box-a').position;assert(Math.abs(after[0]-before[0]-.48)<.025);
    await page.click('#layout-undo');await wait();assert.deepEqual((await scene()).objects.find(o=>o.id==='box-a').position,before);
    assert(await page.locator('#layout-undo').isDisabled());
    await page.click('#layout-redo');await wait();assert.deepEqual((await scene()).objects.find(o=>o.id==='box-a').position,after);
  });
  await test('MMB ladder changes scale without jumps and Escape cancels gesture',async()=>{
    await load(base);await select('box-a');const before=(await scene()).objects.find(o=>o.id==='box-a').position[0];
    await scrub('detail-box-a-position-0',20,'middle',-30);assert(Math.abs((await scene()).objects.find(o=>o.id==='box-a').position[0]-before-2)<.02);
    await page.click('#layout-undo');await wait();assert.equal((await scene()).objects.find(o=>o.id==='box-a').position[0],before);
    await select('box-a');const box=await page.locator('#detail-box-a-position-0').boundingBox();await page.mouse.move(box.x+20,box.y+20);await page.mouse.down({button:'middle'});await page.mouse.move(box.x+55,box.y+50,{steps:4});assert.equal(await page.locator('.previs-value-ladder').count(),1);await page.keyboard.press('Escape');await page.mouse.up({button:'middle'});await wait();assert.equal((await scene()).objects.find(o=>o.id==='box-a').position[0],before);assert.equal(await page.locator('.previs-value-ladder').count(),0);
  });
  await test('animated numeric drag keeps sibling axes and writes one current-time key',async()=>{
    const value=structuredClone(base);value.sequence.tracks=[{id:'position-track',targetId:'box-a',property:'position',interpolation:'linear',keys:[{id:'p0',time:0,value:[0,0,0]},{id:'p2',time:2,value:[2,4,6]}]}];value.viewport.playhead=1;await load(value);await select('box-a');
    await scrub('detail-box-a-position-0',40);const after=await scene(),key=after.sequence.tracks[0].keys.find(k=>k.time===1);assert(key);assert(Math.abs(key.value[0]-1.4)<.025);assert.deepEqual(key.value.slice(1),[2,3]);assert.equal(after.sequence.tracks[0].keys.length,3);
    await page.click('#layout-undo');await wait();assert.equal((await scene()).sequence.tracks[0].keys.length,2);
  });
  await test('camera creation, piloting, flight and exit preserve real camera transforms',async()=>{
    await load(base);await page.click('#layout-new-camera');await wait();let s=await scene(),camera=s.objects.find(o=>o.type==='camera');assert(camera);assert.deepEqual(camera.position,s.viewport.editorCamera.position);
    await page.click('#layout-pilot-camera');await wait();assert.match(await page.locator('#layout-view-mode').innerText(),/驾驶/);const before=camera.position;
    const box=await page.locator('#layout-canvas').boundingBox(),x=box.x+box.width*.7,y=box.y+box.height*.5;await page.mouse.move(x,y);await page.mouse.down({button:'right'});await page.keyboard.down('w');await page.mouse.move(x+25,y+5,{steps:4});await page.waitForTimeout(180);await page.keyboard.up('w');await page.mouse.up({button:'right'});await wait();
    camera=(await scene()).objects.find(o=>o.type==='camera');assert(Math.hypot(...camera.position.map((n,i)=>n-before[i]))>.1);
    await page.click('#layout-exit-camera');await wait();assert.equal(await page.locator('#layout-view-mode').innerText(),'自由视角');const moved=(await scene()).objects.find(o=>o.type==='camera').position;assert.deepEqual(moved,camera.position);
    await page.click('#layout-undo');await wait();assert.deepEqual((await scene()).objects.find(o=>o.type==='camera').position,before);
  });
  await test('rail tool creates camera animation; viewport point drag is one undo',async()=>{
    await load(base);await page.click('#layout-create-rail');await wait();let s=await scene();assert(s.camera.rail.enabled);assert(s.sequence.tracks.some(t=>t.property==='rail.progress'));
    const point=await page.evaluate(async()=>{const T=await import('/static/vendor/three/three.module.js'),s=LumenLayout.getScene(),box=document.querySelector('#layout-canvas').getBoundingClientRect(),c=new T.PerspectiveCamera(50,box.width/box.height);c.filmGauge=36;c.position.fromArray(s.viewport.editorCamera.position);c.quaternion.fromArray(s.viewport.editorCamera.quaternion);c.setFocalLength(s.viewport.editorCamera.focal);c.updateMatrixWorld();const p=new T.Vector3(...s.camera.rail.points[1]).project(c);return{x:box.x+(p.x+1)*box.width/2,y:box.y+(1-p.y)*box.height/2};});
    const before=(await scene()).camera.rail.points;await page.mouse.move(point.x,point.y);await page.mouse.down();await page.mouse.move(point.x+42,point.y-25,{steps:8});await page.mouse.up();await wait();assert.notDeepEqual((await scene()).camera.rail.points[1],before[1]);await page.click('#layout-undo');await wait();assert.deepEqual((await scene()).camera.rail.points,before);
  });
  await test('character library inserts original image and pose proxy with stable IDs',async()=>{
    await load(base);await page.click('#layout-assets-tab');await page.locator('.previs-character-grid [data-character-id="actor-alpha"]').click();await wait();const s=await scene(),related=s.objects.filter(o=>o.character_id==='actor-alpha');assert.equal(related.length,2);assert(related.every(o=>o.asset_id==='asset-ref'));assert(related.some(o=>o.reference.kind==='image'));assert(related.some(o=>o.reference.kind==='proxy'&&Object.keys(o.pose).length>10));
    await load(s);assert.equal((await scene()).objects.filter(o=>o.character_id==='actor-alpha').length,2);
  });
  await test('reference GLB embeds texture and identity; PNG retains editable metadata',async()=>{
    const report=await page.evaluate(async()=>{const {exportSceneGLB}=await import('/static/layout-exchange.js'),{GLTFLoader}=await import('/static/vendor/three/examples/jsm/loaders/GLTFLoader.js');const blob=await exportSceneGLB(LumenLayout.getScene(),{includeAnimation:false});const gltf=await new GLTFLoader().parseAsync(await blob.arrayBuffer(),location.origin+'/');let textures=0;gltf.scene.traverse(node=>{if(node.material?.map)textures++;});return{size:blob.size,textures,characters:gltf.scene.userData.lumenPrevis?.characters};});assert(report.size>10000);assert(report.textures>0);assert.equal(report.characters.length,2);
    await page.click('#layout-save');await page.waitForFunction(()=>window.exportedReference);assert.equal((await page.evaluate(()=>exportedReference.layout.objects.filter(o=>o.character_id==='actor-alpha').length)),2);
  });
  await page.click('#layout-open');await wait();await page.click('#layout-outliner-tab');await select('person-a');await page.locator('#layout-properties').evaluate(node=>node.scrollTop=0);await page.screenshot({path:path.join(out,'previs-controls-wide.png')});await page.setViewportSize({width:1040,height:720});await wait();
  await test('compact fullscreen and XYZ controls have no overlapping hit targets',async()=>{
    const box=await page.locator('#layout-save').boundingBox();assert(box.y>=0&&box.y+box.height<=720);const canvas=await page.locator('#layout-canvas').boundingBox();assert(canvas.width>200&&canvas.height>130);
    await page.click('#layout-outliner-tab');await select('box-a');await page.locator('#layout-properties').evaluate(node=>node.scrollTop=0);
    const fields=await page.locator('.previs-vector').evaluateAll(groups=>groups.slice(0,3).map(group=>[...group.querySelectorAll('.previs-property')].map(row=>{const rect=element=>{const r=element.getBoundingClientRect();return {left:r.left,right:r.right};};return{row:rect(row),label:rect(row.querySelector('label')),input:rect(row.querySelector('input')),key:rect(row.querySelector('button'))};})));
    for(const group of fields)for(const field of group){assert(field.label.right<=field.input.left+1);assert(field.input.right<=field.key.left+1);assert(field.key.right<=field.row.right+1);}
    await page.screenshot({path:path.join(out,'previs-controls-compact.png')});
  });
  assert.deepEqual(errors,[]);fs.writeFileSync(path.join(out,'previs-controls-results.json'),JSON.stringify({checks:results,errors},null,2));
})().catch(error=>{console.error(error);process.exitCode=1;}).finally(async()=>{await browser?.close();server.stdin.end('\n');});
