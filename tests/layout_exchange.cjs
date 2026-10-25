/* Real browser GLB exporter + loader, with animated parent/rig/face/camera. */
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),{spawn}=require('node:child_process');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE_PATH||'playwright');
const root=path.resolve(__dirname,'..'),server=spawn(require('./runtime.cjs').python,[path.join(__dirname,'ui_fixture.py')],{cwd:root,windowsHide:true,stdio:['pipe','pipe','pipe']});
let browser,stderr='';server.stderr.on('data',d=>stderr+=d);
(async()=>{
  const url=await new Promise((resolve,reject)=>{let value='';const timer=setTimeout(()=>reject(Error(stderr||'fixture timeout')),20000);server.stdout.on('data',d=>{value+=d;const m=value.match(/http:\/\/127\.0\.0\.1:\d+/);if(m){clearTimeout(timer);resolve(m[0]);}});});
  browser=await chromium.launch({channel:'msedge',headless:true});const page=await browser.newPage();
  await page.route(url+'/',route=>route.fulfill({contentType:'text/html',body:'<script type="importmap">{"imports":{"three":"/static/vendor/three/three.module.js"}}</script><body>GLB verification</body>'}));
  await page.goto(url);
  const result=await page.evaluate(async()=>{
    const S=await import('/static/layout-scene.js'),E=await import('/static/layout-exchange.js'),T=await import('/static/vendor/three/three.module.js'),{GLTFLoader}=await import('/static/vendor/three/examples/jsm/loaders/GLTFLoader.js');
    const scene=S.normalizeScene({version:3,objects:[
      {id:'actor',type:'adult_male',position:[0,0,0],pose:{},face:{mouthSmile:0}},
      {id:'prop',type:'box',position:[2,0,0]},
      {id:'parent',type:'group',position:[4,0,0]},
    ],sequence:{duration:1,fps:12,tracks:[]}});
    S.setKey(scene,'actor','pose.leftElbow',0,[0,0,0]);S.setKey(scene,'actor','pose.leftElbow',1,[85,0,0]);
    S.setKey(scene,'actor','face.mouthSmile',0,0);S.setKey(scene,'actor','face.mouthSmile',1,1);
    S.setKey(scene,'parent','position',0,[4,0,0]);S.setKey(scene,'parent','position',1,[5,0,0]);
    S.attachAt(scene,'prop','parent',.5);
    S.setKey(scene,'camera','focal',0,35);S.setKey(scene,'camera','focal',1,70);
    S.setKey(scene,'camera','position',0,[4,3,7]);S.setKey(scene,'camera','position',1,[3,3,7]);
    const progress=[],blob=await E.exportSceneGLB(scene,{fps:12,onProgress:p=>progress.push(p.progress)}),buffer=await blob.arrayBuffer();
    const gltf=await new GLTFLoader().parseAsync(buffer,''),mixer=new T.AnimationMixer(gltf.scene);for(const clip of gltf.animations)mixer.clipAction(clip).setLoop(T.LoopOnce,1).play();
    const comparisons=[];
    for(const time of [0,.25,.5,.75,.999]) {
      mixer.setTime(time);gltf.scene.updateMatrixWorld(true);const at=S.evaluateScene(scene,time),expected=new T.Vector3().setFromMatrixPosition(S.worldMatrix(at,'prop')).toArray();
      const actual=gltf.scene.getObjectByName('Lumen_1_0').getWorldPosition(new T.Vector3()).toArray();comparisons.push({time,expected,actual});
    }
    let rejected=false;try{const c=new AbortController();c.abort();await E.exportSceneGLB(scene,{signal:c.signal});}catch(e){rejected=e.name==='AbortError';}
    const bytes=new Uint8Array(buffer),parts=[];for(let i=0;i<bytes.length;i+=32768)parts.push(String.fromCharCode(...bytes.slice(i,i+32768)));
    return {base64:btoa(parts.join('')),comparisons,animations:gltf.animations.length,tracks:gltf.animations[0]?.tracks.map(t=>t.name),progress,rejected,scene};
  });
  const bytes=Buffer.from(result.base64,'base64');delete result.base64;
  assert.equal(bytes.subarray(0,4).toString(),'glTF');assert(bytes.length>10000);
  const json=JSON.parse(bytes.subarray(20,20+bytes.readUInt32LE(12)).toString());
  assert.equal(json.scenes[0].extras.lumenPrevis.camera[0].keys.at(-1).focal,70);
  assert(result.animations>0&&result.tracks.length>20);assert(result.rejected);
  for(const v of result.comparisons)assert(Math.hypot(...v.actual.map((n,i)=>n-v.expected[i]))<1e-4,JSON.stringify(v));
  assert.equal(result.progress.at(-1),100);
  fs.writeFileSync(path.join(root,'diagnostics/previs-animated-export.glb'),bytes);
  fs.writeFileSync(path.join(root,'diagnostics/previs-export-evidence.json'),JSON.stringify(result,null,2));
  console.log(JSON.stringify({passed:5,bytes:bytes.length,animatedTracks:result.tracks.length,proof:'diagnostics/previs-export-evidence.json'}));
})().catch(error=>{console.error(error);process.exitCode=1;}).finally(async()=>{await browser?.close();server.stdin.end('\n');});
