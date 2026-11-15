import test from 'node:test';
import assert from 'node:assert/strict';
import { numericChannels, sampleChannel, normalizeCurves, editTangent, segmentHandles } from '../static/layout-curves.js';
import { normalizeScene, evaluateScene, sampleTrack, applyKeyEdits, pasteKeys, createPrefab, instantiatePrefab } from '../static/layout-scene.js';

const near=(a,b,e=1e-7)=>assert.ok(Math.abs(a-b)<e,`${a} != ${b}`);
const track=(values=[0,10,0])=>({id:'track',targetId:'box',property:'position.0',interpolation:'linear',keys:values.map((value,i)=>({id:'key'+i,time:i,value}))});
const scene=t=>normalizeScene({version:3,objects:[{id:'box',type:'box'}],sequence:{duration:5,fps:24,tracks:[t]}});

test('legacy smooth, linear and step values stay exact without curve metadata',()=>{
  const t=track([0,8]);for(const [mode,value]of [['linear',2],['smooth',1.25],['step',0]]){t.interpolation=mode;near(sampleTrack(t,.25),value);near(sampleChannel(t,.25),value);}
});
test('weighted Bezier solves time rather than treating its parameter as time',()=>{
  const t=track([0,10]);t.keys[0].curves={'':{mode:'break',out:{dt:.1,dv:8}}};t.keys[1].curves={'':{mode:'break',in:{dt:.6,dv:1}}};
  // At u=.5, x=.3125 and y=7.625 from the authored Bezier control points.
  near(sampleChannel(t,.3125),7.625);near(sampleTrack(t,.3125),7.625);
  assert.ok(Math.abs(sampleChannel(t,.5)-5)>1);
});
test('auto tangents keep extrema and monotone segments bounded',()=>{
  const t=track([0,10,0]);for(const key of t.keys)key.curves={'':{mode:'auto'}};
  for(let time=0;time<=2;time+=.01){const value=sampleChannel(t,time);assert.ok(value>=-1e-8&&value<=10+1e-8);}
  near(sampleChannel(t,1),10);assert.ok(sampleChannel(t,.75)>7.5);
});
test('constant mode holds until exact next key and curves override legacy step locally',()=>{
  const t=track([0,10]);t.keys[0].curves={'':{mode:'constant'}};near(sampleTrack(t,.999),0);near(sampleTrack(t,1),10);
  t.interpolation='step';t.keys[0].curves[''].mode='linear';near(sampleTrack(t,.5),5);
});
test('nested numeric components work while quaternion, clip and discrete tracks remain unsupported',()=>{
  const t={...track(),property:'face',keys:[{time:0,value:{mouthSmile:0,style:0}},{time:1,value:{mouthSmile:1,style:1}}]};
  assert.deepEqual(numericChannels(t),['mouthSmile','style']);t.keys[0].curves={mouthSmile:{mode:'constant'}};
  assert.deepEqual(sampleTrack(t,.5),{mouthSmile:0,style:.5});
  for(const property of ['quaternion','quaternion.0','animation.clip','visible','hands','parentId'])assert.deepEqual(numericChannels({...track(),property}),[]);
  assert.throws(()=>normalizeCurves({'':{mode:'auto'}},'quaternion.0',1));
});
test('vector XYZ channels remain independent and explicit rotations can author long turns',()=>{
  const t={...track(),property:'position',keys:[{time:0,value:[0,10,20],curves:{0:{mode:'constant'},1:{mode:'linear'}}},{time:1,value:[10,20,30]}]};
  assert.deepEqual(sampleTrack(t,.5),[0,15,25]);
  const rotation={...track([170,-170]),property:'rotation.1'};near(sampleTrack(rotation,.5),180);rotation.keys[0].curves={'':{mode:'linear'}};near(sampleTrack(rotation,.5),0);
});
test('user handle edits link slopes; Alt/broken edits keep the opposite tangent',()=>{
  const t=track([0,10,0]);const linked=editTangent(t,1,'','out',{dt:.2,dv:3});near(linked[''].in.dv/linked[''].in.dt,15);
  t.keys[1].curves=linked;const broken=editTangent(t,1,'','out',{dt:.3,dv:-2},true);assert.equal(broken[''].mode,'break');assert.deepEqual(broken[''].in,linked[''].in);
});
test('weighted time handles remain monotonic after key spacing changes',()=>{
  const t=track([0,10]);for(const key of t.keys)key.curves={'':{mode:'break',in:{dt:5,dv:5},out:{dt:8,dv:8}}};const h=segmentHandles(t,0,'');near(h.in.dt+h.out.dt,1);
  for(let time=0;time<1;time+=.01)assert.ok(Number.isFinite(sampleChannel(t,time)));
});
test('curve metadata roundtrips through normalization, evaluation and prefab insertion',()=>{
  const t=track([0,10]);t.keys[0].curves={'':{mode:'user',out:{dt:.2,dv:8}}};t.keys[1].curves={'':{mode:'break',in:{dt:.2,dv:0}}};const s=scene(t),expected=sampleChannel(t,.5);
  near(evaluateScene(normalizeScene(JSON.parse(JSON.stringify(s))),.5).objects[0].position[0],expected);
  const prefab=createPrefab(s,['box'],'Animated curve'),target=scene({...track(),keys:[]});target.objects=[];target.sequence.tracks=[];instantiatePrefab(target,prefab,[0,0,0]);near(evaluateScene(target,.5).objects.find(o=>o.type==='box').position[0],expected);
});
test('multi-key moves are atomic and do not collide with their own vacated times',()=>{
  const s=scene(track());applyKeyEdits(s,[{trackId:'track',keyId:'key0',time:1},{trackId:'track',keyId:'key1',time:2},{trackId:'track',keyId:'key2',time:3}]);assert.deepEqual(s.sequence.tracks[0].keys.map(k=>k.time),[1,2,3]);const before=JSON.stringify(s);assert.throws(()=>applyKeyEdits(s,[{trackId:'track',keyId:'key0',time:2},{trackId:'track',keyId:'key2',time:4}]));assert.equal(JSON.stringify(s),before);
});
test('paste retains tangent data and rejects a later collision without partial writes',()=>{
  const s=scene(track([0,10])),entry={trackId:'track',key:{time:3,value:7,curves:{'':{mode:'constant'}}}};pasteKeys(s,[entry]);assert.equal(s.sequence.tracks[0].keys.at(-1).curves[''].mode,'constant');const before=JSON.stringify(s);assert.throws(()=>pasteKeys(s,[{...entry,key:{time:4,value:9}},{...entry,key:{time:1,value:3}}]));assert.equal(JSON.stringify(s),before);
});
test('malformed handles and prototype paths never normalize into a scene',()=>{
  assert.throws(()=>normalizeCurves({'':{mode:'user',out:{dt:-1,dv:0}}},'focal',35));assert.throws(()=>normalizeCurves({'':{mode:'user',out:{dt:1,dv:Infinity}}},'focal',35));assert.throws(()=>normalizeCurves(JSON.parse('{"__proto__":{"mode":"auto"}}'),'face',{x:1}));
});
