/* Real browser timeline/curve interaction and GLB sampling. Temporary fixture only. */
const assert=require('node:assert/strict'),path=require('node:path'),fs=require('node:fs'),{spawn}=require('node:child_process');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE_PATH||'playwright');
const root=path.resolve(__dirname,'..'),out=path.join(root,'diagnostics');
const server=spawn(require('./runtime.cjs').python,[path.join(__dirname,'ui_fixture.py')],{cwd:root,windowsHide:true,stdio:['pipe','pipe','pipe']});
let browser,page,stderr='';server.stderr.on('data',d=>stderr+=d);const evidence={checks:[],errors:[]};
const value={version:3,name:'Curve acceptance',objects:[{id:'box',type:'box',label:'Blocking cube',position:[0,0,0],rotation:[0,0,0],scale:[1,1,1]}],sequence:{duration:5,fps:24,tracks:[
  {id:'position-track',targetId:'box',property:'position',interpolation:'linear',keys:[{id:'p0',time:0,value:[0,0,0]},{id:'p1',time:1,value:[1,2,0]},{id:'p2',time:2,value:[3,0,0]},{id:'p3',time:3,value:[4,1,0]}]},
  {id:'focal-track',targetId:'camera',property:'focal',interpolation:'linear',keys:[{id:'f0',time:0,value:35},{id:'f1',time:1,value:50},{id:'f2',time:3,value:80}]}
]}};
(async()=>{
  const url=await new Promise((resolve,reject)=>{let text='';const timer=setTimeout(()=>reject(Error(stderr||'fixture timeout')),15000);server.stdout.on('data',d=>{text+=d;const match=text.match(/http:\/\/127\.0\.0\.1:\d+/);if(match){clearTimeout(timer);resolve(match[0]);}});});
  browser=await chromium.launch({channel:'msedge',headless:true,args:['--enable-unsafe-swiftshader','--use-angle=swiftshader']});page=await browser.newPage({viewport:{width:1600,height:1080}});page.on('pageerror',e=>evidence.errors.push(e.message));
  const check=async(name,run)=>{await run();evidence.checks.push(name);console.log('PASS',name);};
  const settle=()=>page.waitForTimeout(180),scene=()=>page.evaluate(()=>window.LumenLayout.getScene());
  const seek=async t=>{await page.locator('#layout-time').evaluate((el,t)=>{el.value=t;el.dispatchEvent(new Event('input',{bubbles:true}));},t);await settle();};
  const key=id=>page.locator(`.previs-track-row[data-track-id="position-track"] [data-key-id="${id}"]`);
  const box=async locator=>{const b=await locator.boundingBox();assert(b);return b;};
  const drag=async(b,dx,dy,options={})=>{await page.mouse.move(b.x+b.width/2,b.y+b.height/2);await page.mouse.down(options);await page.mouse.move(b.x+b.width/2+dx,b.y+b.height/2+dy,{steps:12});await page.mouse.up(options);await settle();};
  await page.goto(url);await page.waitForFunction(()=>!!window.LumenLayout);await page.locator('#layout-open').click();await page.waitForSelector('#layout-canvas');await page.evaluate(s=>window.LumenLayout.loadScene(s),value);await settle();
  await check('large readable tracks and numeric ruler',async()=>{assert((await box(page.locator('.previs-track-row').first())).height>=40);assert((await box(key('p1'))).width>=18);assert((await page.locator('.sequence-ruler-tick').count())>=3);});
  await check('Alt wheel zoom preserves time under cursor; middle drag pans',async()=>{
    const r=await box(page.locator('#layout-time-ruler'));let ratio=.63;const before=await page.locator('#layout-timeline').evaluate(el=>({start:+el.dataset.viewStart,end:+el.dataset.viewEnd}));await page.evaluate(()=>document.addEventListener('wheel',e=>window.__wheelX=e.clientX,{once:true,capture:true}));
    await page.mouse.move(r.x+r.width*ratio,r.y+r.height/2);await page.keyboard.down('Alt');await page.mouse.wheel(0,-350);await page.keyboard.up('Alt');await settle();
    ratio=((await page.evaluate(()=>window.__wheelX))-r.x)/r.width;const anchor=before.start+(before.end-before.start)*ratio;const after=await page.locator('#layout-timeline').evaluate(el=>({start:+el.dataset.viewStart,end:+el.dataset.viewEnd}));assert(after.end-after.start<before.end-before.start);assert(Math.abs(after.start+(after.end-after.start)*ratio-anchor)<1e-5);
    await drag(r,100,0,{button:'middle'});const panned=await page.locator('#layout-timeline').evaluate(el=>+el.dataset.viewStart);assert(panned<after.start);await page.locator('#layout-timeline').focus();await page.keyboard.press('Home');await settle();evidence.zoomAnchorError=Math.abs(after.start+(after.end-after.start)*ratio-anchor);
  });
  await check('Shift multiselect drags keys as one snapped group and undoes once',async()=>{
    await key('p0').click();await key('p1').click({modifiers:['Shift']});const ruler=await box(page.locator('#layout-time-ruler'));await drag(await box(key('p1')),ruler.width/5.25*.5,0);let s=await scene();const times=s.sequence.tracks[0].keys.map(k=>k.time);assert(Math.abs(times[0]-.5)<1e-6);assert(Math.abs(times[1]-1.5)<1e-6);assert.equal(times[2],2);
    await page.locator('#layout-timeline').focus();await page.keyboard.press('Control+z');await settle();assert.deepEqual((await scene()).sequence.tracks[0].keys.map(k=>k.time),[0,1,2,3]);
  });
  await check('marquee selects multiple keys; clipboard paste keeps relative offsets',async()=>{
    const a=await box(key('p0')),b=await box(key('p1')),strip=await box(page.locator('.previs-track-row[data-track-id="position-track"] .previs-key-strip'));
    await page.mouse.move(Math.max(strip.x+2,a.x-12),strip.y+3);await page.mouse.down();await page.mouse.move(b.x+b.width+12,strip.y+strip.height-2,{steps:10});await page.mouse.up();await settle();assert.equal(await page.locator('.previs-key-diamond.selected').count(),2);
    await page.locator('#layout-timeline').focus();await page.keyboard.press('Control+c');await seek(3.5);await page.locator('#layout-timeline').focus();await page.keyboard.press('Control+v');await settle();const times=(await scene()).sequence.tracks[0].keys.map(k=>k.time);assert(times.includes(3.5)&&times.includes(4.5));await page.keyboard.press('Control+z');await settle();await page.screenshot({path:path.join(out,'sequencer-tracks.png')});
  });
  await check('frame and key navigation stay scoped to timeline',async()=>{await seek(0);await page.locator('#layout-timeline').focus();await page.keyboard.press('ArrowRight');await settle();assert.match(await page.locator('#layout-time-value').textContent(),/^1f/);await page.keyboard.press('ArrowDown');await settle();assert.match(await page.locator('#layout-time-value').textContent(),/^24f/);});
  await page.locator('#layout-curve-toggle').click();await settle();await page.locator('#layout-curve-track').selectOption('position-track');await settle();
  await check('curve mode exposes genuine XYZ components and authors automatic tangents',async()=>{
    assert.equal(await page.locator('.sequence-curve-line').count(),3);await page.locator('.sequence-curve-key[data-key-id="p1"][data-channel="0"]').click();await page.locator('#layout-key-interpolation').selectOption('auto');await settle();const s=await scene();assert.equal(s.sequence.tracks[0].keys[1].curves['0'].mode,'auto');assert.equal(await page.locator('.sequence-tangent-handle').count(),2);
  });
  await check('dragging weighted tangent changes actual sampled motion and supports undo/redo',async()=>{
    const sample=()=>page.evaluate(async()=>{const {evaluateScene}=await import('/static/layout-scene.js');return evaluateScene(window.LumenLayout.getScene(),1.5).objects[0].position[0];});const before=await sample();const handle=page.locator('.sequence-tangent-handle[data-handle="out"][data-key-id="p1"]');await drag(await box(handle),20,-36);const after=await sample();assert(Math.abs(after-before)>.1);let s=await scene();assert.equal(s.sequence.tracks[0].keys[1].curves['0'].mode,'user');evidence.tangentSample={before,after};
    await page.locator('#layout-timeline').focus();await page.keyboard.press('Control+z');await settle();assert(Math.abs(await sample()-before)<1e-7);await page.keyboard.press('Control+Shift+z');await settle();assert(Math.abs(await sample()-after)<1e-7);
  });
  await check('curve key drag edits time and one component without overwriting siblings',async()=>{
    const before=(await scene()).sequence.tracks[0].keys.find(k=>k.id==='p1');await drag(await box(page.locator('.sequence-curve-key[data-key-id="p1"][data-channel="0"]')),25,-12);const after=(await scene()).sequence.tracks[0].keys.find(k=>k.id==='p1');assert(after.time!==before.time);assert(after.value[0]!==before.value[0]);assert.deepEqual(after.value.slice(1),before.value.slice(1));evidence.curveKey={before,after};await page.locator('#layout-timeline').focus();await page.keyboard.press('Control+z');await settle();await page.screenshot({path:path.join(out,'sequencer-curves.png')});
  });
  await check('playback evaluator and exported GLB animation include the edited curve',async()=>{
    await seek(1.5);const current=await page.evaluate(()=>window.LumenLayout.getEvaluatedScene().objects[0].position[0]);assert(Math.abs(current-evidence.tangentSample.after)<1e-7);
    evidence.export=await page.evaluate(async()=>{const {exportSceneGLB}=await import('/static/layout-exchange.js'),{GLTFLoader}=await import('/static/vendor/three/examples/jsm/loaders/GLTFLoader.js');const s=window.LumenLayout.getScene(),result=await exportSceneGLB(s,{fps:24}),bytes=await result.arrayBuffer();const gltf=await new GLTFLoader().parseAsync(bytes,'');const track=gltf.animations[0].tracks.find(t=>/^Lumen_0(?:_0)?\.position$/.test(t.name));if(!track)throw Error('No exported position track: '+gltf.animations[0].tracks.map(t=>t.name));return{bytes:bytes.byteLength,value:Array.from(track.createInterpolant().evaluate(1.5)),trackName:track.name};});assert(Math.abs(evidence.export.value[0]-current)<1e-4);assert(evidence.export.bytes>1000);
  });
  assert.deepEqual(evidence.errors,[]);evidence.passed=true;fs.writeFileSync(path.join(out,'sequencer-acceptance.json'),JSON.stringify(evidence,null,2));console.log(JSON.stringify(evidence));
})().catch(async e=>{console.error(e);if(page)await page.screenshot({path:path.join(out,'sequencer-failure.png')}).catch(()=>{});process.exitCode=1;}).finally(async()=>{if(browser)await browser.close();server.stdin.end('quit\n');setTimeout(()=>server.kill(),3000).unref();});
