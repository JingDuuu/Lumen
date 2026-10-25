import assert from 'node:assert/strict';
import * as THREE from '../static/vendor/three/three.module.js';
import {normalizeScene,evaluateScene,setKey,keyAll,getValue,moveKey,removeKey,worldMatrix,reparent,createGroup,attachAt,createPrefab,instantiatePrefab,deleteObjects} from '../static/layout-scene.js';
const record=(id,changes={})=>({id,type:'box',label:id,position:[0,0,0],rotation:[0,0,0],scale:[1,1,1],...changes});
const make=()=>normalizeScene({version:3,objects:[record('a'),record('b',{position:[4,0,0],rotation:[0,30,0]})],sequence:{duration:4,fps:24,tracks:[]}});
const near=(a,b,tolerance=1e-6)=>assert(Math.abs(a-b)<tolerance,`${a} != ${b}`);
const sameMatrix=(a,b)=>a.elements.forEach((v,i)=>near(v,b.elements[i]));
let passed=0;function check(label,run){run();passed++;console.log('PASS '+label);}
check('v1 and v2 camera animation migrate without losing poses',()=>{
  const v1=normalizeScene({version:1,camera:{yaw:30,height:2,distance:7},objects:[{id:'old',type:'person',x:1,z:2,scale:1.2}]});
  assert.equal(v1.version,3);assert.equal(v1.objects[0].type,'adult_male');assert.deepEqual(v1.objects[0].position,[1,0,2]);
  const v2=normalizeScene({version:2,camera:{position:[0,2,7],quaternion:[0,0,0,1],focal:35},objects:[record('old',{pose:{pelvisTranslation:[0,-.4,0]},hands:{left:'fist'}})],sequence:{duration:4,keys:[{time:0,camera:{position:[0,2,7],quaternion:[0,0,0,1],focal:35}},{time:4,camera:{position:[4,2,7],quaternion:[0,0,0,1],focal:55}}]}});
  near(evaluateScene(v2,2).camera.position[0],2);near(evaluateScene(v2,2).camera.focal,45);assert.deepEqual(v2.objects[0].pose.pelvisTranslation,[0,-.4,0]);
});
check('parenting keeps world transforms and refuses cycles atomically',()=>{
  const scene=make(),before=worldMatrix(scene,'a');reparent(scene,'a','b');sameMatrix(before,worldMatrix(scene,'a'));
  assert.throws(()=>reparent(scene,'b','a'),/子级/);assert.equal(scene.objects[1].parentId,null);reparent(scene,'a',null);sameMatrix(before,worldMatrix(scene,'a'));
});
check('group transforms drive all children while world pose is preserved',()=>{
  const scene=make(),a=worldMatrix(scene,'a'),b=worldMatrix(scene,'b'),group=createGroup(scene,['a','b'],'演员与道具');
  sameMatrix(a,worldMatrix(scene,'a'));sameMatrix(b,worldMatrix(scene,'b'));group.position[1]+=2;
  near(worldMatrix(scene,'a').elements[13],2);near(worldMatrix(scene,'b').elements[13],2);
});
check('numeric, quaternion, pose, facial and material tracks interpolate',()=>{
  const scene=make();for(const [property,start,end] of [['position',[0,0,0],[4,2,0]],['pose.leftElbow',[0,0,0],[60,0,0]],['face.smile',0,1],['material.roughness',.2,.8]]){setKey(scene,'a',property,0,start);setKey(scene,'a',property,4,end);}
  setKey(scene,'camera','quaternion',0,[0,0,0,1]);setKey(scene,'camera','quaternion',4,new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0,1,0),Math.PI/2).toArray());
  const original=JSON.stringify(scene),at=evaluateScene(scene,2);assert.deepEqual(at.objects[0].position,[2,1,0]);near(at.objects[0].pose.leftElbow[0],30);near(at.objects[0].face.smile,.5);near(at.objects[0].material.roughness,.5);near(new THREE.Quaternion(...at.camera.quaternion).angleTo(new THREE.Quaternion()),Math.PI/4);assert.equal(JSON.stringify(scene),original);
});
check('short rotation path and step visibility/hands stay deterministic',()=>{
  const scene=make();setKey(scene,'a','rotation',0,[0,170,0]);setKey(scene,'a','rotation',4,[0,-170,0]);setKey(scene,'a','visible',0,true);setKey(scene,'a','visible',4,false);setKey(scene,'a','hands',0,{left:'fist'},'step');setKey(scene,'a','hands',4,{left:'open'},'step');
  const at=evaluateScene(scene,2).objects[0];near(at.rotation[1],180);assert(at.visible);assert.equal(at.hands.left,'fist');assert.equal(evaluateScene(scene,4).objects[0].visible,false);
});
check('key edit move and delete maintain unique sorted time positions',()=>{
  const scene=make(),key=setKey(scene,'a','position',2,[2,0,0]);setKey(scene,'a','position',0,[0,0,0]);setKey(scene,'a','position',2,[3,0,0]);const track=scene.sequence.tracks[0];assert.equal(track.keys.length,2);assert.equal(track.keys[1].id,key.id);
  assert.throws(()=>moveKey(scene,track.id,key.id,0),/已有/);moveKey(scene,track.id,key.id,3);near(track.keys[1].time,3);removeKey(scene,track.id,key.id);assert.equal(track.keys.length,1);
});
check('rail progresses on real curved path with valid camera orientation',()=>{
  const scene=make();scene.camera.rail={enabled:true,points:[[-3,2,4],[0,3,3],[3,2,4]],progress:0,lookAt:[0,1,0],orientation:'target'};setKey(scene,'camera','rail.progress',0,0);setKey(scene,'camera','rail.progress',4,1);
  assert.deepEqual(evaluateScene(scene,0).camera.position,[-3,2,4]);near(evaluateScene(scene,2).camera.position[0],0,.02);near(new THREE.Quaternion(...evaluateScene(scene,2).camera.quaternion).length(),1);assert.deepEqual(evaluateScene(scene,4).camera.position,[3,2,4]);
});
check('attachment switches on a frame without teleporting at the switch',()=>{
  const scene=make(),before=worldMatrix(evaluateScene(scene,2),'a');attachAt(scene,'a','b',2);assert.equal(evaluateScene(scene,1).objects[0].parentId,null);assert.equal(evaluateScene(scene,2).objects[0].parentId,'b');sameMatrix(before,worldMatrix(evaluateScene(scene,2),'a'));
});
check('prefab contains selected subtree and remaps all parents and tracks',()=>{
  const scene=make();reparent(scene,'a','b');setKey(scene,'b','position',0,[4,0,0]);setKey(scene,'b','position',4,[8,0,0]);const prefab=createPrefab(scene,['b'],'道具组合');assert.equal(prefab.objects.length,3);assert(prefab.sequence.tracks.length);
  const target=make(),ids=instantiatePrefab(target,prefab,[10,0,0]);assert.equal(ids.length,3);assert.equal(new Set(target.objects.map(o=>o.id)).size,5);const moved=evaluateScene(target,4);const child=ids.find(id=>moved.objects.find(o=>o.id===id).label==='b');near(worldMatrix(moved,child).elements[12],14);
});
check('deleting a hierarchy removes only its subtree and related tracks',()=>{
  const scene=make();reparent(scene,'a','b');setKey(scene,'a','visible',0,true);deleteObjects(scene,['b']);assert.equal(scene.objects.length,0);assert.equal(scene.sequence.tracks.length,0);
});
check('unsafe property paths and animated hierarchy cycles are rejected',()=>{
  const scene=make();assert.throws(()=>setKey(scene,'a','__proto__.x',0,1));assert.throws(()=>setKey(scene,'a','face.constructor.x',0,1));setKey(scene,'a','parentId',1,'b','step');setKey(scene,'b','parentId',1,'a','step');assert.throws(()=>normalizeScene(scene),/子级/);assert.equal({}.x,undefined);
});
check('quick key stores whole scene while leaving editor camera unanimated',()=>{
  const scene=make();scene.viewport.editorCamera={position:[0,2,3]};keyAll(scene,0);assert(scene.sequence.tracks.some(t=>t.property==='face'));assert(scene.sequence.tracks.some(t=>t.targetId==='environment'));assert(!scene.sequence.tracks.some(t=>t.property.startsWith('viewport')));assert.deepEqual(getValue(scene,'a','position'),[0,0,0]);
});
console.log(JSON.stringify({passed}));
