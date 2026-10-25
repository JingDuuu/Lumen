/* Fullscreen Previs acceptance in real WebGL. Fixture owns temporary user data. */
const assert=require('node:assert/strict');
const path=require('node:path');
const fs=require('node:fs');
const {spawn}=require('node:child_process');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE_PATH||'playwright');
const root=path.resolve(__dirname,'..'),out=path.join(root,'diagnostics');
const server=spawn(require('./runtime.cjs').python,[path.join(__dirname,'ui_fixture.py')],{cwd:root,windowsHide:true,stdio:['pipe','pipe','pipe']});
let browser,page,stderr='';server.stderr.on('data',d=>stderr+=d);
const checks=[],errors=[];
const distance=(a,b)=>Math.hypot(...a.map((v,i)=>v-b[i]));
(async()=>{
  const url=await new Promise((resolve,reject)=>{let output='';const timer=setTimeout(()=>reject(Error(stderr||'Fixture timeout')),15000);server.stdout.on('data',d=>{output+=d;const match=output.match(/http:\/\/127\.0\.0\.1:\d+/);if(match){clearTimeout(timer);resolve(match[0]);}});});
  browser=await chromium.launch({channel:'msedge',headless:true,args:['--enable-unsafe-swiftshader','--use-angle=swiftshader']});
  const context=await browser.newContext({viewport:{width:1440,height:960}});page=await context.newPage();
  page.on('pageerror',error=>{errors.push(error.message);console.error('PAGE',error.message);});
  page.on('console',message=>{if(message.type()==='error')errors.push(message.text());});
  const check=async(name,run)=>{await run();checks.push(name);console.log('PASS '+name);};
  const scene=()=>page.evaluate(()=>window.LumenLayout.getScene());
  const evaluated=()=>page.evaluate(()=>window.LumenLayout.getEvaluatedScene());
  const settle=()=>page.waitForTimeout(150);
  const select=async(id,modifiers)=>{await page.locator(`.previs-tree-row[data-object-id="${id}"] .previs-tree-label`).click({modifiers});await settle();};
  const field=async(id,value)=>{await page.locator('#'+id).fill(String(value));await page.locator('#'+id).press('Tab');await settle();};
  const seek=async(value)=>{await page.locator('#layout-time').evaluate((node,time)=>{node.value=time;node.dispatchEvent(new Event('input',{bubbles:true}));},value);await settle();};
  const openSection=async(label)=>{const summary=page.locator('.previs-details summary').filter({hasText:new RegExp('^'+label+'$')}).first();if(!await summary.evaluate(node=>node.parentElement.open))await summary.click();};
  const load=async(value)=>{await page.evaluate(value=>window.LumenLayout.loadScene(value),value);await settle();};
  const keyField=async(id,property)=>{await page.locator(`.previs-property[data-target-id="${id}"][data-property="${property}"] .previs-key-button`).click();await settle();};
  const saveBoard=async()=>{await page.locator('#canvas').focus();const response=page.waitForResponse(r=>r.url().endsWith('/api/agent/board')&&r.request().method()==='PUT');await page.keyboard.press('Control+s');assert.equal((await response).status(),200);return(await context.request.get(url+'/api/boards/default')).json();};
  const captureUpload=async(action,video=false)=>{const pending=page.waitForResponse(r=>r.url().endsWith(video?'/api/previs/render-video':'/api/upload')&&r.request().method()==='POST',{timeout:90000});await action();const response=await pending;assert.equal(response.status(),200,await response.text());return response.json();};
  await page.goto(url);await page.waitForFunction(()=>window.LumenLayout&&window.LumenBoard);await page.locator('#layout-open').click();await page.waitForSelector('#layout-canvas');await settle();
  const original=await scene();
  await check('real fullscreen WebGL, normalized rig defaults and readable empty timeline',async()=>{
    assert.equal(original.version,3);assert.equal(original.objects.length,2);assert(Object.keys(original.objects[0].pose).length>10);assert(original.objects[0].face.eyeOpen!==undefined);
    assert(await page.locator('#layout-canvas').evaluate(canvas=>!!canvas.getContext('webgl2')));assert((await page.locator('#layout-canvas').evaluate(canvas=>canvas.toDataURL().length))>10000);
    const modal=await page.locator('#layout-dialog').boundingBox();assert.equal(modal.width,1440);assert.equal(modal.height,960);assert(await page.locator('#layout-timeline').evaluate(node=>node.classList.contains('collapsed')));
    assert(await page.locator('#layout-pose').isVisible());await page.screenshot({path:path.join(out,'previs4-wide.png'),animations:'disabled'});
  });
  await check('free UE flight and Alt orbit preserve shot camera until quick K',async()=>{
    const before=await scene(),box=await page.locator('#layout-canvas').boundingBox(),x=box.x+box.width*.7,y=box.y+box.height*.3;
    await page.mouse.move(x,y);await page.mouse.down({button:'right'});await page.keyboard.down('w');await page.mouse.move(x+40,y+10,{steps:5});await page.waitForTimeout(220);await page.keyboard.up('w');await page.mouse.up({button:'right'});
    let after=await scene();assert(distance(before.viewport.editorCamera.position,after.viewport.editorCamera.position)>.1);assert.deepEqual(after.camera,before.camera);
    await page.keyboard.down('Alt');await page.mouse.move(x,y);await page.mouse.down();await page.mouse.move(x+40,y,{steps:6});await page.mouse.up();await page.keyboard.up('Alt');
    const flown=(await scene()).viewport.editorCamera;await page.locator('#layout-canvas').focus();await page.keyboard.press('k');await settle();after=await scene();assert(distance(after.camera.position,flown.position)<1e-5);assert(after.sequence.tracks.length>15);assert(!await page.locator('#layout-timeline').evaluate(node=>node.classList.contains('collapsed')));
  });
  await check('Outliner multi-select, world-preserving grouping, lock, visibility, undo and redo',async()=>{
    await load(original);await select('person-a');await select('box-a',['Control']);await page.locator('#layout-group').click();await settle();let current=await scene(),group=current.objects.find(o=>o.type==='group');assert(group);assert(current.objects.filter(o=>o.parentId===group.id).length===2);
    await select('box-a');await field('detail-box-a-position-0',2.3);assert.equal((await scene()).objects.find(o=>o.id==='box-a').position[0],2.3);await page.locator('#layout-undo').click();await settle();assert.notEqual((await scene()).objects.find(o=>o.id==='box-a').position[0],2.3);await page.locator('#layout-redo').click();await settle();assert.equal((await scene()).objects.find(o=>o.id==='box-a').position[0],2.3);
    const row=page.locator('.previs-tree-row[data-object-id="box-a"]');await row.getByRole('button',{name:'锁定对象',exact:true}).click();await settle();await row.getByRole('button',{name:'隐藏对象',exact:true}).click();await settle();assert.equal((await scene()).objects.find(o=>o.id==='box-a').visible,false);await row.getByRole('button',{name:'显示对象',exact:true}).click();await row.getByRole('button',{name:'解锁对象',exact:true}).click();await settle();
    const before=await page.evaluate(async()=>{const M=await import('/static/layout-scene.js');return M.worldMatrix(window.LumenLayout.getScene(),'box-a').elements;});await page.locator('#layout-parent').selectOption('');await settle();const after=await page.evaluate(async()=>{const M=await import('/static/layout-scene.js');return M.worldMatrix(window.LumenLayout.getScene(),'box-a').elements;});assert(distance(before,after)<1e-7);
  });
  await check('direct first-mousedown IK, independent hands, face and material controls',async()=>{
    await load(original);await select('person-a');await page.locator('#layout-focus').click();await settle();
    const point=await page.evaluate(async()=>{const T=await import('/static/vendor/three/three.module.js'),A=await import('/static/layout-assets.js'),s=window.LumenLayout.getScene(),r=s.objects[0],root=A.createAsset(r.type,r);root.position.fromArray(r.position);root.rotation.set(...r.rotation.map(T.MathUtils.degToRad));root.scale.fromArray(r.scale);root.updateMatrixWorld(true);const p=A.getIKTargets(root).find(t=>t.id==='leftHand').object.getWorldPosition(new T.Vector3());const box=document.querySelector('#layout-canvas').getBoundingClientRect(),c=new T.PerspectiveCamera(50,box.width/box.height,.05,1000);c.filmGauge=36;c.position.fromArray(s.viewport.editorCamera.position);c.quaternion.fromArray(s.viewport.editorCamera.quaternion);c.setFocalLength(s.viewport.editorCamera.focal);c.updateMatrixWorld();p.project(c);A.disposeAsset(root);return{x:box.x+(p.x+1)*box.width/2,y:box.y+(1-p.y)*box.height/2};});
    const before=(await scene()).objects[0].pose;await page.mouse.move(point.x,point.y);await page.mouse.down();await page.mouse.move(point.x+45,point.y-28,{steps:9});await page.mouse.up();await settle();assert.notDeepEqual((await scene()).objects[0].pose,before);
    const options=await page.locator('#detail-person-a-hands-left option').evaluateAll(nodes=>nodes.map(n=>n.value));await page.locator('#detail-person-a-hands-left').selectOption(options.at(-1));await settle();assert.equal((await scene()).objects[0].hands.left,options.at(-1));
    await openSection('脸部与表情');await field('detail-person-a-face-mouthSmile',.7);assert.equal((await scene()).objects[0].face.mouthSmile,.7);await keyField('person-a','face.mouthSmile');
    await openSection('基础材质');await field('detail-person-a-material-roughness',.25);assert.equal((await scene()).objects[0].material.roughness,.25);
  });
  await check('multi-track interpolation preserves animated sibling axes when editing one property',async()=>{
    const value=JSON.parse(JSON.stringify(original));value.sequence.duration=2;
    value.sequence.tracks=[{id:'track-pos',targetId:'box-a',property:'position',interpolation:'linear',keys:[{id:'p0',time:0,value:[1,0,0]},{id:'p2',time:2,value:[3,2,2]}]}];await load(value);await seek(1);await select('box-a');await field('detail-box-a-position-0',8);
    let state=await evaluated();assert.deepEqual(state.objects.find(o=>o.id==='box-a').position,[8,1,1]);const positionTrack=(await scene()).sequence.tracks.find(t=>t.id==='track-pos');assert.deepEqual(positionTrack.keys.find(k=>k.time===1).value,[8,1,1]);
    await select('person-a');await openSection('脸部与表情');await field('detail-person-a-face-mouthSmile',0);await seek(0);await keyField('person-a','face.mouthSmile');await seek(2);await field('detail-person-a-face-mouthSmile',1);await seek(1);assert(Math.abs((await evaluated()).objects.find(o=>o.id==='person-a').face.mouthSmile-.5)<.001);
    await page.locator('#layout-canvas').focus();await page.keyboard.press('Space');await page.waitForTimeout(180);await page.keyboard.press('Space');assert.match(await page.locator('#layout-play').innerText(),/播放/);
  });
  await check('key selection, numeric time movement, interpolation and deletion are undoable',async()=>{
    const button=page.locator('.previs-track-row[data-track-id="track-pos"] [data-key-id="p0"]');await button.click();await field('layout-key-time',.25);assert.equal((await scene()).sequence.tracks.find(t=>t.id==='track-pos').keys.find(k=>k.id==='p0').time,.25);
    await page.locator('#layout-key-interpolation').selectOption('step');await settle();assert.equal((await scene()).sequence.tracks.find(t=>t.id==='track-pos').keys.find(k=>k.id==='p0').interpolation,'step');await page.locator('#layout-key-delete').click();await settle();assert(!(await scene()).sequence.tracks.find(t=>t.id==='track-pos').keys.some(k=>k.id==='p0'));await page.locator('#layout-undo').click();await settle();assert((await scene()).sequence.tracks.find(t=>t.id==='track-pos').keys.some(k=>k.id==='p0'));
  });
  await check('real editable lights/camera, compact layout and visible footer',async()=>{
    await page.locator('#layout-assets-tab').click();await page.locator('#layout-asset-category').selectOption('lighting');await page.getByRole('button',{name:'点光源',exact:true}).click();await settle();const light=(await scene()).objects.find(o=>o.type==='point_light');assert(light);await field('detail-'+light.id+'-light-intensity',12);await keyField(light.id,'light.intensity');assert((await scene()).sequence.tracks.some(t=>t.targetId===light.id&&t.property==='light.intensity'));
    await page.getByRole('button',{name:'相机',exact:true}).click();await settle();assert((await scene()).objects.some(o=>o.type==='camera'));
    await page.setViewportSize({width:1040,height:720});await settle();const footer=await page.locator('#layout-save').boundingBox();assert(footer.y>=0&&footer.y+footer.height<=720);assert.equal(await page.evaluate(()=>document.body.scrollWidth),1040);await page.screenshot({path:path.join(out,'previs4-compact.png'),animations:'disabled'});await page.setViewportSize({width:1440,height:960});
  });
  await check('imported animation selects one clip, speed and offset, preserving object transform',async()=>{
    await load(original);
    const bytes=await page.evaluate(async()=>{
      const T=await import('/static/vendor/three/three.module.js'),{GLTFExporter}=await import('/static/vendor/three/examples/jsm/exporters/GLTFExporter.js');
      const source=new T.Scene(),mesh=new T.Mesh(new T.BoxGeometry(.4,.4,.4),new T.MeshStandardMaterial());mesh.name='ImportedMovingBox';source.add(mesh);
      const clips=[new T.AnimationClip('向右',2,[new T.VectorKeyframeTrack('ImportedMovingBox.position',[0,2],[0,0,0,2,0,0])]),new T.AnimationClip('向上',2,[new T.VectorKeyframeTrack('ImportedMovingBox.position',[0,2],[0,0,0,0,2,0])])];
      const result=await new GLTFExporter().parseAsync(source,{binary:true,animations:clips});
      const update=T.Object3D.prototype.updateMatrixWorld;T.Object3D.prototype.updateMatrixWorld=function(...args){if(this.isScene&&this.getObjectByName('person-a'))window.__lastPrevisWorld=this;return update.apply(this,args);};
      return Array.from(new Uint8Array(result));
    });
    await page.route('**/static/test-multiclip.glb',route=>route.fulfill({contentType:'model/gltf-binary',body:Buffer.from(bytes)}));
    await page.evaluate(async()=>LumenLayout.importAsset({url:'/static/test-multiclip.glb',name:'双片段测试',sourceFormat:'glb'}));await settle();const id=(await scene()).objects.find(o=>o.type==='imported').id;
    assert.equal(await page.locator(`#detail-${id}-animation-clip option`).count(),2);await page.locator(`#detail-${id}-animation-clip`).selectOption('1');await settle();await field(`detail-${id}-animation-speed`,.5);await field(`detail-${id}-animation-offset`,.25);await field(`detail-${id}-position-0`,3);await seek(1);
    const transforms=await page.evaluate(id=>{const root=__lastPrevisWorld.getObjectByName(id),mesh=root.getObjectByName('ImportedMovingBox');return{root:root.position.toArray(),mesh:mesh.position.toArray()};},id);assert.equal(transforms.root[0],3);assert(Math.abs(transforms.mesh[1]-.75)<.01);assert(Math.abs(transforms.mesh[0])<.01);
    const saved=await scene();await load(saved);await seek(1);assert.equal((await scene()).objects.find(o=>o.id===id).animation.clip,'1');
  });
  await check('camera rails have editable XYZ points and evaluate camera motion',async()=>{
    await load(original);await openSection('拍摄机位');await openSection('相机轨道');await page.locator('#detail-camera-rail-enabled').check();await settle();await field('detail-camera-rail-points-0-0',-4);await field('detail-camera-rail-progress',0);const before=(await evaluated()).camera.position;await field('detail-camera-rail-progress',1);const after=(await evaluated()).camera.position;assert(distance(before,after)>1);await keyField('camera','rail.progress');assert((await scene()).sequence.tracks.some(track=>track.property==='rail.progress'));
  });
  await check('actual PNG export preserves v3 tracks and editable scene',async()=>{
    await load({...original,sequence:{duration:2,fps:24,tracks:[{id:'export-box',targetId:'box-a',property:'position',interpolation:'linear',keys:[{id:'e0',time:0,value:[1.1,0,-.5]},{id:'e2',time:2,value:[-1.8,.8,.5]}]},{id:'export-face',targetId:'person-a',property:'face.mouthSmile',interpolation:'linear',keys:[{id:'f0',time:0,value:0},{id:'f2',time:2,value:1}]}]}});await seek(.7);
    const frame=await page.locator('#layout-canvas').boundingBox();assert(Math.abs(frame.width/frame.height-16/9)<.01);
    const before=await scene(),upload=await captureUpload(()=>page.locator('#layout-save').click());await page.waitForFunction(()=>!document.querySelector('#layout-dialog').open);const board=await saveBoard(),card=board.items.find(item=>item.kind==='image'&&item.layout?.version===3);assert(card);assert.deepEqual(card.layout.objects,before.objects);assert.deepEqual(card.layout.sequence,before.sequence);const bytes=await(await context.request.get(url+'/input/'+upload.name)).body();assert(bytes.length>15000);fs.writeFileSync(path.join(out,'previs4-export.png'),bytes);fs.writeFileSync(path.join(out,'previs4-export-scene.json'),JSON.stringify(card.layout,null,2));await page.locator('#layout-open').click();await settle();
  });
  await check('deterministic 24fps video evaluates full scene and restores time; cancellation releases UI',async()=>{
    const before=await scene(),upload=await captureUpload(()=>page.locator('#layout-export-video').click(),true);assert.equal(upload.frames,48);assert.equal(upload.duration,2);await page.waitForFunction(()=>!document.querySelector('#layout-dialog').open);const board=await saveBoard(),card=board.items.find(item=>item.kind==='video'&&item.layout?.version===3);assert(card);assert.deepEqual(card.layout.camera,before.camera);assert.deepEqual(card.layout.sequence,before.sequence);const bytes=await(await context.request.get(url+'/input/'+upload.name)).body();assert(bytes.length>1000);fs.writeFileSync(path.join(out,'previs4-export.mp4'),bytes);await page.locator('#layout-open').click();await settle();await page.locator('#layout-export-video').click();await page.waitForTimeout(250);await page.locator('#layout-cancel-export').click();await page.waitForFunction(()=>!document.querySelector('#layout-save').disabled);assert.match(await page.locator('#layout-status').innerText(),/取消/);
  });
  await check('v1 migration and local draft reopen retain editable data',async()=>{
    await load({version:1,camera:{yaw:30,height:2,distance:7,focal:40,targetY:1},objects:[{id:'legacy',type:'person',label:'旧人物',x:1,z:-2,scale:1.2}]});assert.equal((await scene()).version,3);assert.equal((await scene()).objects[0].type,'adult_male');assert.deepEqual((await scene()).objects[0].position,[1,0,-2]);await page.locator('#layout-canvas').focus();await page.keyboard.press('Escape');await page.waitForFunction(()=>!document.querySelector('#layout-dialog').open);assert.equal(await page.evaluate(()=>JSON.parse(localStorage.getItem('lumen-previs-scene-v3')).version),3);
  });
  assert.deepEqual(errors,[]);fs.writeFileSync(path.join(out,'previs4-acceptance.json'),JSON.stringify({checks,errors},null,2));console.log(`PASS ${checks.length} real WebGL acceptance groups`);
})().catch(async error=>{console.error(error);if(page)await page.screenshot({path:path.join(out,'previs4-failure.png')}).catch(()=>{});fs.writeFileSync(path.join(out,'previs4-acceptance.json'),JSON.stringify({checks,errors,failure:String(error)},null,2));process.exitCode=1;}).finally(async()=>{await browser?.close();server.stdin.end('quit\n');setTimeout(()=>{if(server.exitCode===null)server.kill();},2000).unref();});
