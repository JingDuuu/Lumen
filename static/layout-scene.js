/* Serializable Previs scene operations. No renderer, DOM, network or persistence. */
import * as THREE from './vendor/three/three.module.js';
import { ASSETS } from './layout-assets.js';

export const MAX_OBJECTS = 200;
export const MAX_KEYS = 10000;
export const MAX_DURATION = 300;
const copy = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
const uid = () => globalThis.crypto.randomUUID();
const finite = (value, fallback, min = -1e6, max = 1e6) => Number.isFinite(Number(value)) ? Math.max(min, Math.min(max, Number(value))) : fallback;
const vector = (raw, fallback, min = -1e6, max = 1e6) => fallback.map((v, i) => finite(raw?.[i], v, min, max));
const object = value => value && typeof value === 'object' && !Array.isArray(value) ? copy(value) : {};
const rad = THREE.MathUtils.degToRad, deg = THREE.MathUtils.radToDeg;
const SAFE = new Set(['position','rotation','quaternion','scale','focal','near','far','visible','parentId','pose','hands','body','face','ik','material','color','rail','intensity','exposure','rotationY','background','hdri','lighting','animation','enabled','power','light']);

function safePath(path) {
  if (typeof path !== 'string' || path.length > 200) throw new Error('属性路径无效');
  const parts = path.split('.');
  if (!SAFE.has(parts[0]) || parts.some(p => !/^[\w-]+$/.test(p) || ['__proto__','constructor','prototype'].includes(p))) throw new Error('此属性不能记录关键帧');
  return parts;
}
function target(scene, id) {
  if (id === 'camera') return scene.camera;
  if (id === 'environment' || id === 'scene') return scene.environment;
  return scene.objects.find(o => o.id === id);
}
export function getValue(scene, targetId, property) {
  return copy(safePath(property).reduce((v, key) => v?.[key], target(scene, targetId)));
}
export function setValue(scene, targetId, property, value) {
  let current = target(scene, targetId);
  if (!current) throw new Error('关键帧对象不存在');
  const parts = safePath(property);
  for (const part of parts.slice(0, -1)) {
    if (current[part] == null || typeof current[part] !== 'object') current[part] = {};
    current = current[part];
  }
  current[parts.at(-1)] = copy(value);
}

export function defaultCamera() {
  const camera = new THREE.PerspectiveCamera();
  camera.position.set(4.8, 2.6, 7.5); camera.lookAt(0, 1, 0);
  return {position:camera.position.toArray(),quaternion:camera.quaternion.toArray(),focal:35};
}
function normalizeCamera(raw = {}) {
  const base = defaultCamera(), q = new THREE.Quaternion(...vector(raw.quaternion, base.quaternion, -1, 1));
  if (q.lengthSq() < 1e-8) q.identity(); else q.normalize();
  const rail = raw.rail || {};
  return {position:vector(raw.position, base.position),quaternion:q.toArray(),focal:finite(raw.focal,35,12,300),
    near:finite(raw.near,.05,.001,10),far:finite(raw.far,1000,20,100000),
    rail:{enabled:!!rail.enabled,progress:finite(rail.progress,0,0,1),
      points:(Array.isArray(rail.points) && rail.points.length >= 2 ? rail.points : [[-4,2,6],[0,2.5,5],[4,2,6]]).slice(0,32).map(p=>vector(p,[0,1,0])),
      lookAt:vector(rail.lookAt,[0,1,0]),orientation:rail.orientation === 'tangent' ? 'tangent' : 'target'}};
}
export function normalizeScene(raw) {
  if (!raw || typeof raw !== 'object') throw new Error('场景须为 JSON 对象');
  raw = copy(raw);
  if (raw.version === 1) {
    const c = new THREE.PerspectiveCamera(), old = raw.camera || {}, yaw=rad(finite(old.yaw,15)), distance=finite(old.distance,7,.1,1000);
    c.position.set(Math.sin(yaw)*distance,finite(old.height,1.7),Math.cos(yaw)*distance); c.lookAt(0,finite(old.targetY,.9),0);
    raw.camera={position:c.position.toArray(),quaternion:c.quaternion.toArray(),focal:old.focal || 35};
    raw.objects=(raw.objects || []).map(o=>({...o,type:o.type==='person'?'adult_male':o.type==='backdrop'?'wall':o.type,
      position:[o.x || 0,0,o.z || 0],rotation:[0,0,0],scale:[o.scale || 1,o.scale || 1,o.scale || 1]}));
    raw.version=2;
  }
  if (![2,3].includes(raw.version)) throw new Error('不支持此场景版本');
  if (!Array.isArray(raw.objects) || raw.objects.length > MAX_OBJECTS) throw new Error(`场景最多 ${MAX_OBJECTS} 个对象`);
  const known=new Set([...ASSETS.map(a=>a.id),'group','imported','camera','point_light','spot_light','directional_light']), ids=new Set();
  const objects=raw.objects.map(o=>{
    if (!o || !known.has(o.type)) throw new Error('未知对象类型：'+o?.type);
    const id=String(o.id || uid());
    if (ids.has(id) || ['camera','scene','environment'].includes(id)) throw new Error('对象 ID 重复或占用系统名称');
    ids.add(id);
    return {...o,id,label:String(o.label || o.type).slice(0,120),parentId:o.parentId || null,
      position:vector(o.position,[0,0,0]),rotation:vector(o.rotation,[0,0,0],-36000,36000),scale:vector(o.scale,[1,1,1],.001,1000),
      visible:o.visible !== false,locked:!!o.locked,color:/^#[\da-f]{6}$/i.test(o.color)?o.color:'#94aecb',
      pose:object(o.pose),hands:object(o.hands),body:object(o.body),face:object(o.face),ik:object(o.ik),
      material:{color:o.material?.color || o.color || '#94aecb',roughness:finite(o.material?.roughness,.65,0,1),metalness:finite(o.material?.metalness,0,0,1),opacity:finite(o.material?.opacity,1,0,1)}};
  });
  for (const o of objects) if (o.parentId && !ids.has(o.parentId)) throw new Error(`对象「${o.label}」的父级不存在`);
  const duration=finite(raw.sequence?.duration,5,1,MAX_DURATION), tracks=[];
  if (raw.version === 2) {
    for (const property of ['position','quaternion','focal']) {
      const keys=(raw.sequence?.keys || []).map(k=>({id:uid(),time:k.time,value:k.camera?.[property]})).filter(k=>k.value !== undefined);
      if (keys.length) tracks.push({id:uid(),targetId:'camera',property,interpolation:raw.sequence.interpolation || 'smooth',keys});
    }
  } else if (Array.isArray(raw.sequence?.tracks)) tracks.push(...raw.sequence.tracks);
  if (tracks.reduce((n,t)=>n+(t.keys?.length || 0),0) > MAX_KEYS) throw new Error(`最多支持 ${MAX_KEYS} 个关键帧`);
  const scene={version:3,name:String(raw.name || '未命名场景').slice(0,120),camera:normalizeCamera(raw.camera),objects,
    lighting:raw.lighting || 'studio',environment:{hdri:null,intensity:1,rotation:0,exposure:1.35,background:false,...object(raw.environment)},
    viewport:{grid:true,axes:true,thirds:!!raw.thirds,renderMode:'quality',...object(raw.viewport)},
    sequence:{duration,fps:finite(raw.sequence?.fps,24,1,60),interpolation:raw.sequence?.interpolation || 'smooth',tracks:[]}};
  if (scene.viewport.editorCamera) scene.viewport.editorCamera=normalizeCamera(scene.viewport.editorCamera);
  for (const track of tracks) {
    if (!target(scene,track.targetId)) throw new Error('时间线引用了不存在的对象');
    safePath(track.property);
    const keys=[];
    for (const key of [...(track.keys || [])].sort((a,b)=>a.time-b.time)) {
      if (key.value === undefined) continue;
      const normal={id:String(key.id || uid()),time:finite(key.time,0,0,duration),value:copy(key.value)};
      if (key.interpolation) normal.interpolation=['linear','smooth','step'].includes(key.interpolation)?key.interpolation:'linear';
      const match=keys.find(k=>Math.abs(k.time-normal.time)<1e-5);
      if (match) Object.assign(match,normal); else keys.push(normal);
    }
    scene.sequence.tracks.push({id:String(track.id || uid()),targetId:track.targetId,property:track.property,
      interpolation:['linear','smooth','step'].includes(track.interpolation)?track.interpolation:'linear',muted:!!track.muted,keys});
  }
  validateHierarchy(scene);
  // Parent tracks can be individually valid but form a cycle at a switch.
  const switches=new Set([0,...scene.sequence.tracks.filter(t=>t.property==='parentId').flatMap(t=>t.keys.map(k=>k.time))]);
  for (const time of switches) {
    const at=copy(scene); for (const track of scene.sequence.tracks.filter(t=>t.property==='parentId'&&!t.muted)) setValue(at,track.targetId,track.property,sampleTrack(track,time));
    validateHierarchy(at);
  }
  return scene;
}

export function validateHierarchy(scene) {
  const map=new Map(scene.objects.map(o=>[o.id,o]));
  for (const item of scene.objects) {
    const seen=new Set([item.id]); let parent=item.parentId;
    while (parent) { if (!map.has(parent)) throw new Error('父级对象不存在'); if (seen.has(parent)) throw new Error('不能将对象附加到自己或自己的子级'); seen.add(parent); parent=map.get(parent).parentId; }
  }
  return true;
}
function blend(a,b,t,path) {
  if(path==='animation.clip')return copy(t<1?a:b);
  if (path.endsWith('quaternion') && Array.isArray(a) && a.length===4) return new THREE.Quaternion(...a).slerp(new THREE.Quaternion(...b),t).normalize().toArray();
  if (typeof a==='number' && typeof b==='number') {
    const angle=path.startsWith('rotation') || (path.startsWith('pose.')&&!path.includes('pelvisTranslation'));
    return a+(angle?(((b-a+180)%360+360)%360)-180:b-a)*t;
  }
  if (Array.isArray(a)&&Array.isArray(b)) return a.map((v,i)=>blend(v,b[i]??v,t,path));
  if (a&&b&&typeof a==='object'&&typeof b==='object') return Object.fromEntries([...new Set([...Object.keys(a),...Object.keys(b)])].map(k=>[k,blend(a[k]??b[k],b[k]??a[k],t,path+'.'+k)]));
  if (typeof a==='string'&&typeof b==='string'&&/^#[\da-f]{6}$/i.test(a)&&/^#[\da-f]{6}$/i.test(b)) {
    return '#'+[1,3,5].map(i=>Math.round(parseInt(a.slice(i,i+2),16)*(1-t)+parseInt(b.slice(i,i+2),16)*t).toString(16).padStart(2,'0')).join('');
  }
  return copy(t<1?a:b);
}
export function sampleTrack(track,time) {
  const keys=track.keys;
  if (!keys.length) return undefined;
  if(time<=keys[0].time)return copy(keys[0].value);
  if(time>=keys.at(-1).time)return copy(keys.at(-1).value);
  const index=keys.findIndex(k=>k.time>time), a=keys[index-1],b=keys[index];
  const mode=a.interpolation || track.interpolation, discrete=['parentId','visible','hands','hdri'].includes(track.property)||track.property.endsWith('.enabled');
  if(mode==='step'||discrete)return copy(a.value);
  const t=(time-a.time)/(b.time-a.time), s=mode==='smooth'?t*t*(3-2*t):t;
  return blend(a.value,b.value,s,track.property);
}
export function evaluateScene(scene,time) {
  const result=copy(scene), at=finite(time,0,0,scene.sequence.duration);
  // Specific channels override their containing snapshot, independent of creation order.
  const tracks=[...scene.sequence.tracks].sort((a,b)=>a.property.split('.').length-b.property.split('.').length);
  for(const track of tracks) if(!track.muted&&track.keys.length) setValue(result,track.targetId,track.property,sampleTrack(track,at));
  validateHierarchy(result);
  if(result.camera.rail?.enabled) applyRail(result.camera);
  return result;
}
export function applyRail(camera) {
  const rail=camera.rail, points=rail.points.map(p=>new THREE.Vector3(...p));
  if(points.length<2)return camera;
  const curve=new THREE.CatmullRomCurve3(points,false,'centripetal'), t=finite(rail.progress,0,0,1),p=curve.getPointAt(t);
  const look=rail.orientation==='tangent'?p.clone().add(curve.getTangentAt(t)):new THREE.Vector3(...rail.lookAt);
  if(p.distanceToSquared(look)<1e-8)look.z-=1;
  const helper=new THREE.PerspectiveCamera(); helper.position.copy(p); helper.lookAt(look);
  camera.position=p.toArray();camera.quaternion=helper.quaternion.toArray();return camera;
}
export function setKey(scene,targetId,property,time,value,interpolation='linear') {
  if(value===undefined)throw new Error('属性尚无值，无法记录关键帧');
  if(!target(scene,targetId))throw new Error('找不到要记录的对象'); safePath(property);
  let track=scene.sequence.tracks.find(t=>t.targetId===targetId&&t.property===property);
  const at=finite(time,0,0,scene.sequence.duration);
  if(!track && scene.sequence.tracks.reduce((n,t)=>n+t.keys.length,0)>=MAX_KEYS)throw new Error('关键帧数量已达到上限');
  if(!track) {track={id:uid(),targetId,property,interpolation,keys:[]};scene.sequence.tracks.push(track);}
  let key=track.keys.find(k=>Math.abs(k.time-at)<1e-5);
  if(!key) {if(scene.sequence.tracks.reduce((n,t)=>n+t.keys.length,0)>=MAX_KEYS)throw new Error('关键帧数量已达到上限');key={id:uid(),time:at,value:copy(value)};track.keys.push(key);}
  else key.value=copy(value);
  track.keys.sort((a,b)=>a.time-b.time); return key;
}
export function removeKey(scene,trackId,keyId) {
  const track=scene.sequence.tracks.find(t=>t.id===trackId); if(!track)return false;
  const count=track.keys.length;track.keys=track.keys.filter(k=>k.id!==keyId);
  if(!track.keys.length)scene.sequence.tracks=scene.sequence.tracks.filter(t=>t!==track);return count!==track.keys.length;
}
export function moveKey(scene,trackId,keyId,time) {
  const track=scene.sequence.tracks.find(t=>t.id===trackId),key=track?.keys.find(k=>k.id===keyId);
  if(!key)throw new Error('关键帧不存在');const at=finite(time,0,0,scene.sequence.duration);
  if(track.keys.some(k=>k!==key&&Math.abs(k.time-at)<1e-5))throw new Error('此时刻已有关键帧');key.time=at;track.keys.sort((a,b)=>a.time-b.time);return key;
}
export function keyAll(scene,time,objectIds=null) {
  const next={...scene,sequence:copy(scene.sequence)};
  // Existing component channels take precedence during evaluation; key them too.
  for(const track of scene.sequence.tracks)if(!track.muted&&(!objectIds||['camera','scene','environment'].includes(track.targetId)||objectIds.includes(track.targetId))){
    const value=getValue(scene,track.targetId,track.property);if(value!==undefined)setKey(next,track.targetId,track.property,time,value,track.interpolation);
  }
  for(const property of ['position','quaternion','focal','rail'])setKey(next,'camera',property,time,getValue(scene,'camera',property),scene.sequence.interpolation);
  for(const o of scene.objects)if(!objectIds||objectIds.includes(o.id))for(const property of ['position','rotation','scale','pose','hands','body','face','ik','material','visible','parentId'])
    setKey(next,o.id,property,time,copy(o[property]??(property==='parentId'?null:{})),['visible','parentId','hands'].includes(property)?'step':scene.sequence.interpolation);
  for(const o of scene.objects)if(!objectIds||objectIds.includes(o.id))for(const property of ['light','color','intensity','focal','near','far','animation'])
    if(o[property]!==undefined)setKey(next,o.id,property,time,copy(o[property]),scene.sequence.interpolation);
  for(const property of ['hdri','intensity','rotation','exposure','background'])setKey(next,'environment',property,time,getValue(scene,'environment',property),property==='hdri'||property==='background'?'step':scene.sequence.interpolation);
  scene.sequence=next.sequence;
}
export function worldMatrix(scene,id,cache=new Map(),visiting=new Set()) {
  if(cache.has(id))return cache.get(id).clone();const o=scene.objects.find(n=>n.id===id);if(!o)throw new Error('对象不存在');
  if(visiting.has(id))throw new Error('父级关系存在循环');visiting.add(id);
  const q=new THREE.Quaternion().setFromEuler(new THREE.Euler(...o.rotation.map(rad))),matrix=new THREE.Matrix4().compose(new THREE.Vector3(...o.position),q,new THREE.Vector3(...o.scale));
  if(o.parentId)matrix.premultiply(worldMatrix(scene,o.parentId,cache,visiting));visiting.delete(id);cache.set(id,matrix);return matrix.clone();
}
function writeTransform(record,matrix) {
  const p=new THREE.Vector3(),q=new THREE.Quaternion(),s=new THREE.Vector3();matrix.decompose(p,q,s);
  const rebuilt=new THREE.Matrix4().compose(p,q,s);
  if(matrix.elements.some((v,i)=>Math.abs(v-rebuilt.elements[i])>1e-4))throw new Error('此父级缩放会产生剪切，请先将父级恢复为等比缩放');
  record.position=p.toArray();record.rotation=new THREE.Euler().setFromQuaternion(q).toArray().slice(0,3).map(deg);record.scale=s.toArray();
}
const transformProperty=property=>['parentId','position','rotation','scale'].includes(property.split('.')[0]);
function worldDependencies(scene,ids) {
  const result=new Set(),pending=ids.filter(Boolean),byId=new Map(scene.objects.map(o=>[o.id,o]));
  while(pending.length){
    const id=pending.pop();if(result.has(id)||!byId.has(id))continue;result.add(id);
    if(byId.get(id).parentId)pending.push(byId.get(id).parentId);
    for(const track of scene.sequence.tracks)if(track.targetId===id&&track.property==='parentId'&&!track.muted)
      for(const key of track.keys)if(key.value)pending.push(key.value);
  }
  return result;
}
function hasWorldAnimation(scene,ids) {
  const relevant=worldDependencies(scene,ids);
  return scene.sequence.tracks.some(track=>relevant.has(track.targetId)&&!track.muted&&track.keys.length&&transformProperty(track.property));
}
function validateAnimatedHierarchy(scene) {
  validateHierarchy(scene);
  const times=new Set([0,...scene.sequence.tracks.filter(t=>t.property==='parentId'&&!t.muted).flatMap(t=>t.keys.map(k=>k.time))]);
  for(const time of times)validateHierarchy(evaluateScene(scene,time));
}
function bakeLocalTransforms(source,destination,bindings,center=new THREE.Vector3()) {
  const ids=new Set(bindings.map(binding=>binding.id));
  const relevant=worldDependencies(source,bindings.flatMap(binding=>[binding.id,binding.parentId]));
  const remaining=destination.sequence.tracks.filter(track=>!ids.has(track.targetId)||!transformProperty(track.property));
  const count=Math.ceil(source.sequence.duration*source.sequence.fps), times=new Set([0,source.sequence.duration]);
  for(let frame=0;frame<=count;frame++)times.add(Math.min(source.sequence.duration,frame/source.sequence.fps));
  for(const track of source.sequence.tracks)if(relevant.has(track.targetId)&&transformProperty(track.property))for(const key of track.keys)times.add(key.time);
  const ordered=[...times].sort((a,b)=>a-b).filter((value,index,all)=>!index||value-all[index-1]>1e-5);
  if(remaining.reduce((n,t)=>n+t.keys.length,0)+ordered.length*bindings.length*3>MAX_KEYS)throw new Error('保持动画需要的关键帧超过上限，请缩短片段或减少对象');
  const channels=new Map(bindings.map(binding=>[binding.id,['position','rotation','scale'].map(property=>({id:uid(),targetId:binding.id,property,interpolation:'linear',keys:[]}))]));
  for(const time of ordered){
    const at=evaluateScene(source,time),cache=new Map();
    for(const binding of bindings){
      const matrix=worldMatrix(at,binding.id,cache);
      if(binding.parentId)matrix.premultiply(worldMatrix(at,binding.parentId,cache).invert());
      else {matrix.elements[12]-=center.x;matrix.elements[13]-=center.y;matrix.elements[14]-=center.z;}
      const sampled={};writeTransform(sampled,matrix);
      for(const track of channels.get(binding.id))track.keys.push({id:uid(),time,value:sampled[track.property]});
    }
  }
  destination.sequence.tracks=[...remaining,...[...channels.values()].flat()];
}
export function reparent(scene,id,parentId,{keepWorld=true}={}) {
  validateHierarchy(scene);const item=scene.objects.find(o=>o.id===id);if(!item)throw new Error('对象不存在');
  const next=copy(scene),changed=next.objects.find(o=>o.id===id),world=keepWorld?worldMatrix(scene,id):null;changed.parentId=parentId || null;
  validateHierarchy(next);
  if(keepWorld){
    const local=parentId?worldMatrix(scene,parentId).invert().multiply(world):world;writeTransform(changed,local);
    if(hasWorldAnimation(scene,[id,parentId]))bakeLocalTransforms(scene,next,[{id,parentId:parentId||null}]);
  }
  validateAnimatedHierarchy(next);
  Object.assign(item,changed);scene.sequence=next.sequence;return item;
}
export function descendants(scene,ids) {
  const result=new Set(ids);let changed=true;while(changed){changed=false;for(const o of scene.objects)if(o.parentId&&result.has(o.parentId)&&!result.has(o.id)){result.add(o.id);changed=true;}}return [...result];
}
export function createGroup(scene,ids,label='新组') {
  if(scene.objects.length>=MAX_OBJECTS)throw new Error('场景对象达到上限');
  validateHierarchy(scene);
  const selected=new Set(ids),byId=new Map(scene.objects.map(o=>[o.id,o]));
  const roots=scene.objects.filter(o=>{
    if(!selected.has(o.id))return false;
    for(let parent=o.parentId;parent;parent=byId.get(parent)?.parentId)if(selected.has(parent))return false;
    return true;
  });if(!roots.length)throw new Error('请先选择对象');
  const center=new THREE.Vector3();roots.forEach(o=>center.add(new THREE.Vector3().setFromMatrixPosition(worldMatrix(scene,o.id))));center.divideScalar(roots.length);
  const group={id:uid(),type:'group',label,parentId:null,position:center.toArray(),rotation:[0,0,0],scale:[1,1,1],visible:true,locked:false};
  const before=copy(scene);scene.objects.push(group);try{roots.forEach(o=>reparent(scene,o.id,group.id));}catch(error){scene.objects=before.objects;scene.sequence=before.sequence;throw error;}return group;
}
export function deleteObjects(scene,ids) {
  const deleted=new Set(descendants(scene,ids));scene.objects=scene.objects.filter(o=>!deleted.has(o.id));
  scene.sequence.tracks=scene.sequence.tracks.filter(t=>!deleted.has(t.targetId));
  for(const track of scene.sequence.tracks)if(track.property==='parentId')for(const key of track.keys)if(deleted.has(key.value))key.value=null;
}
export function attachAt(scene,id,parentId,time) {
  const at=evaluateScene(scene,time),before=at.objects.find(o=>o.id===id);if(!before)throw new Error('对象不存在');
  const old=copy(before),world=worldMatrix(at,id);before.parentId=parentId||null;validateHierarchy(at);
  writeTransform(before,parentId?worldMatrix(at,parentId).invert().multiply(world):world);const current=before,next=copy(scene);
  if(time>0){const previousTime=Math.max(0,time-1/scene.sequence.fps),previous=evaluateScene(scene,previousTime).objects.find(o=>o.id===id);
    for(const property of ['parentId','position','rotation','scale']){const k=setKey(next,id,property,previousTime,previous[property],'linear');k.interpolation='step';}}
  for(const property of ['parentId','position','rotation','scale'])setKey(next,id,property,time,current[property],property==='parentId'?'step':'linear');
  if(time===0)Object.assign(next.objects.find(o=>o.id===id),{parentId:current.parentId,position:current.position,rotation:current.rotation,scale:current.scale});
  validateAnimatedHierarchy(next);scene.objects=next.objects;scene.sequence=next.sequence;
  return {before:old,after:copy(current)};
}
export function createPrefab(scene,ids,name='新 Prefab') {
  const selected=new Set(descendants(scene,ids)),prefab=copy(scene);prefab.name=name;
  prefab.objects=prefab.objects.filter(o=>selected.has(o.id));prefab.sequence.tracks=prefab.sequence.tracks.filter(t=>selected.has(t.targetId));
  if(!prefab.objects.length)throw new Error('请先选择对象');
  if(prefab.objects.length>=MAX_OBJECTS)throw new Error('Prefab需要一个根组，请减少一个对象');
  const roots=prefab.objects.filter(o=>!selected.has(o.parentId)),center=new THREE.Vector3();
  roots.forEach(o=>center.add(new THREE.Vector3().setFromMatrixPosition(worldMatrix(scene,o.id))));if(roots.length)center.divideScalar(roots.length);
  const group={id:uid(),type:'group',label:name,parentId:null,position:[0,0,0],rotation:[0,0,0],scale:[1,1,1],visible:true,locked:false};
  for(const root of roots){const matrix=worldMatrix(scene,root.id);matrix.elements[12]-=center.x;matrix.elements[13]-=center.y;matrix.elements[14]-=center.z;root.parentId=group.id;writeTransform(root,matrix);}
  prefab.objects.unshift(group);
  const rootIds=new Set(roots.map(o=>o.id));
  const escaped=new Set(prefab.sequence.tracks.filter(t=>t.property==='parentId'&&t.keys.some(k=>!selected.has(k.value))).map(t=>t.targetId));
  const animated=hasWorldAnimation(scene,[...rootIds,...escaped]);
  if(animated){
    const bindings=prefab.objects.filter(o=>rootIds.has(o.id)||escaped.has(o.id)).map(o=>({id:o.id,parentId:rootIds.has(o.id)?null:o.parentId}));
    bakeLocalTransforms(scene,prefab,bindings,center);
  }
  // Muted external references must not prevent an otherwise self-contained preset loading.
  prefab.sequence.tracks=prefab.sequence.tracks.filter(t=>!(t.property==='parentId'&&t.muted&&t.keys.some(k=>!selected.has(k.value))));
  return normalizeScene(prefab);
}
export function instantiatePrefab(scene,prefab,position=[0,0,0]) {
  const source=normalizeScene(prefab);if(scene.objects.length+source.objects.length>MAX_OBJECTS)throw new Error('放入 Prefab 后超过对象上限');
  if([...scene.sequence.tracks,...source.sequence.tracks].reduce((n,t)=>n+t.keys.length,0)>MAX_KEYS)throw new Error('放入 Prefab 后超过关键帧上限');
  const map=new Map(source.objects.map(o=>[o.id,uid()])), result=[];
  for(const item of source.objects){const o=copy(item);o.id=map.get(item.id);o.parentId=map.get(item.parentId)||null;if(!o.parentId)o.position=o.position.map((v,i)=>v+position[i]);scene.objects.push(o);result.push(o.id);}
  for(const t of source.sequence.tracks){if(!map.has(t.targetId))continue;const track=copy(t);track.id=uid();track.targetId=map.get(t.targetId);track.keys=track.keys.map(k=>({...k,id:uid(),value:track.property==='parentId'?(map.get(k.value)||null):k.value}));scene.sequence.tracks.push(track);}
  scene.sequence.duration=Math.max(scene.sequence.duration,source.sequence.duration);validateHierarchy(scene);return result;
}
