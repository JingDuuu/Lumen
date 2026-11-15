/* Lumen Previs: renderer and editing commands. Serializable scene logic is separate. */
import * as THREE from './vendor/three/three.module.js';
import { OrbitControls } from './vendor/three/examples/jsm/controls/OrbitControls.js';
import { TransformControls } from './vendor/three/examples/jsm/controls/TransformControls.js';
import { GLTFLoader } from './vendor/three/examples/jsm/loaders/GLTFLoader.js';
import { RGBELoader } from './vendor/three/examples/jsm/loaders/RGBELoader.js';
import { clone as cloneSkeleton } from './vendor/three/examples/jsm/utils/SkeletonUtils.js';
import {
  ASSETS, POSES, HAND_POSES, JOINTS, BODY_FIELDS, FACE_FIELDS, EXPRESSION_PRESETS,
  HDR_PRESETS, createAsset, applyRig, applyMaterial, applyPose, applyHand,
  applyExpression, getIKTargets, solveIK, serializeRig, disposeAsset
} from './layout-assets.js';
import {
  MAX_OBJECTS, normalizeScene, evaluateScene, getValue, setValue, setKey,
  removeKey, moveKey, keyAll, reparent, createGroup, deleteObjects,
  createPrefab, instantiatePrefab, attachAt, defaultCamera, applyKeyEdits, pasteKeys
} from './layout-scene.js';
import { exportSceneGLB } from './layout-exchange.js';
import { mountFileUI } from './layout-file-ui.js';
import { EditorUI } from './layout-editor-ui.js';
import { TimelineUI } from './layout-timeline-ui.js';
import { RailOverlay } from './layout-rail.js';
import { createReferenceImage } from './layout-reference.js';

const $ = id => document.getElementById(id);
const copy = value => JSON.parse(JSON.stringify(value));
const rad = THREE.MathUtils.degToRad, deg = THREE.MathUtils.radToDeg;
const STORE = 'lumen-previs-scene-v3';
const EXTRA_ASSETS = [
  {id:'point_light',label:'点光源',category:'lighting'},
  {id:'spot_light',label:'聚光灯',category:'lighting'},
  {id:'directional_light',label:'方向光',category:'lighting'},
  {id:'camera',label:'相机',category:'lighting'}
];
const EDITOR_ASSETS = [...ASSETS,...EXTRA_ASSETS];
const gltfLoader = new GLTFLoader(), hdrLoader = new RGBELoader();
const assets = new Map(), hdrs = new Map(), thumbnails = new Map();
const hdrTextures=new Map();
const roots = new Map(), mixers = new Map(), markers = new Map();
const raycaster = new THREE.Raycaster(), mouse = new THREE.Vector2();
const selection = new Set(), keys = new Set();
const markerGeometry = new THREE.SphereGeometry(1, 12, 8);
let data, evaluated, ui, timeline, fileUI, renderer, world, camera, shotCamera;
let orbit, transform, transformHelper, grid, axes, floor, lights, bounds, pivot;
let railOverlay;
let selectedJoint = 'leftElbow', viewMode = 'free', time = 0, speed = 3;
let history = [], future = [], dirty = true, syncing = false, syncAgain = false;
let ready = false, busy = false, playing = false, animationFrame = 0, lastFrame = 0;
let playStart = 0, playOffset = 0, editBefore = null, pointer = null, fly = null, ikDrag = null;
let transformBefore = null, transformMatrices = new Map(), pivotBefore = null, hovered = null;
let exportCancelled = false, exportStart = 0, exportDuration = 5, saveTimer = 0;
let editingId = null, editingKind = null, environmentSignature = '', sceneRevision = 0;
let environmentReady=Promise.resolve();
let controlGesture=null,railDrag=null,railSelection=-1,pilotId=null;

function initialScene() {
  return normalizeScene({
    version: 3, name: '新构图场景', camera: defaultCamera(),
    objects: [
      {id:'person-a',type:'adult_female',label:'人物 A',position:[-.7,0,0],rotation:[0,0,0],scale:[1,1,1]},
      {id:'box-a',type:'box',label:'道具 A',position:[1.1,0,-.5],rotation:[0,0,0],scale:[1,1,1],color:'#aaa4cf'}
    ], sequence:{duration:5,fps:24,tracks:[]}
  });
}

function cameraRecord(object) {
  return {position:object.getWorldPosition(new THREE.Vector3()).toArray(),quaternion:object.getWorldQuaternion(new THREE.Quaternion()).toArray(),focal:object.getFocalLength()};
}

function putCamera(object, record) {
  object.position.fromArray(record.position);
  object.quaternion.fromArray(record.quaternion);
  object.setFocalLength(record.focal);
  object.near = record.near || .05;
  object.far = record.far || 1000;
  object.updateProjectionMatrix();
  object.updateMatrixWorld();
}

function activeCamera() { return viewMode==='pilot'?(fly?camera:roots.get(pilotId)?.userData.camera||camera):viewMode === 'camera' ? shotCamera : camera; }
function selectedId() { return [...selection].at(-1) || null; }
function objectById(id, source = data) { return source.objects.find(object => object.id === id); }
function visible(root) { for(let current=root; current&&current!==world; current=current.parent) if(!current.visible)return false; return true; }

function snapshot() {
  const scene = copy(data);
  scene.viewport.editorCamera = cameraRecord(camera);
  scene.viewport.playhead = time;
  return scene;
}

function saveDraft(immediate = false) {
  clearTimeout(saveTimer);
  const save = () => {
    try { localStorage.setItem(STORE,JSON.stringify(snapshot())); }
    catch { ui.message('本地草稿空间不足，请使用文件菜单保存场景。',true); }
  };
  if(immediate)save();else saveTimer=setTimeout(save,250);
}

function remember(before) {
  if(JSON.stringify(before)===JSON.stringify(snapshot()))return;
  history.push(before);
  if(history.length>80)history.shift();
  future=[];
  saveDraft();
  updateHistory();
}

function updateHistory() {
  $('layout-undo').disabled=!history.length||busy;
  $('layout-redo').disabled=!future.length||busy;
}

function mutate(run, message) {
  if(busy)return;
  const before=snapshot();
  try {
    run();
    data=normalizeScene(data);
    if(controlGesture){applyState(currentScene());dirty=false;return;}
    remember(before);
    dirty=true;
    refresh(true);
    if(message)ui.message(message);
  } catch(error) {
    data=before;
    dirty=true;
    refresh(true);
    ui.message(error.message,true);
  }
}

function beginControlGesture() {
  if(busy||controlGesture)return;
  stopPlayback();controlGesture={before:snapshot()};
}

function endControlGesture(cancel=false) {
  if(!controlGesture)return;
  const before=controlGesture.before;controlGesture=null;
  if(cancel)data=before;else remember(before);
  dirty=true;refresh(true);
}

async function undo(redo=false) {
  const source=redo?future:history,target=redo?history:future;
  if(!source.length||busy)return;
  stopPlayback();
  const selected=[...selection];
  target.push(snapshot());
  await installScene(source.pop(),false);
  selection.clear();for(const id of selected)if(objectById(id))selection.add(id);
  attachTransform();ui.sync(currentScene(),[...selection],true);
  updateHistory();saveDraft();
}

function currentScene() {
  evaluated=evaluateScene(data,time);
  return evaluated;
}

function syncTrackedProperty(id, property) {
  for(const track of data.sequence.tracks) {
    if(track.targetId!==id)continue;
    if(track.property===property||track.property.startsWith(property+'.')||property.startsWith(track.property+'.')) {
      setKey(data,id,track.property,time,getValue(data,id,track.property),track.interpolation);
    }
  }
}

function setProperty(id, property, value) {
  mutate(()=>{
    if(property==='label') { objectById(id).label=String(value).trim()||'对象';return; }
    const ids=selection.has(id)&&selection.size>1&&(/^(position|rotation|scale)\./.test(property)||['visible','locked'].includes(property)) ? topSelection() : [id];
    const old=property==='locked'?objectById(id).locked:getValue(currentScene(),id,property);
    for(const target of ids) {
      const source=objectById(target);
      if(source?.locked&&!['locked','visible'].includes(property))continue;
      if(property==='locked') { source.locked=!!value;continue; }
      const container=property.split('.')[0];
      if(property.includes('.')){
        const current=getValue(currentScene(),target,container);
        if(current!==undefined)setValue(data,target,container,copy(current));
      }
      let next=copy(value);
      if(ids.length>1&&typeof value==='number') {
        const previous=getValue(currentScene(),target,property);
        next=property.startsWith('scale.')?previous*(old?value/old:1):previous+(value-old);
      }
      setValue(data,target,property,next);
      if(source?.type==='imported'&&property.startsWith('material.'))source.asset.materialOverride=true;
      syncTrackedProperty(target,property);
    }
    if(id==='camera'&&!property.startsWith('rail.points')&&!property.startsWith('rail.lookAt')){pilotId=null;viewMode='camera';}
  });
}

function keyProperty(id, property) {
  mutate(()=>setKey(data,id,property,time,getValue(currentScene(),id,property),'smooth'),'已记录这项属性的关键帧。');
}

function captureCamera(recordKey=false) {
  mutate(()=>{
    const state=currentScene();
    data.objects=copy(state.objects);
    data.environment=copy(state.environment);
    data.camera={...copy(state.camera),...cameraRecord(activeCamera())};
    if(viewMode==='free')data.camera.rail.enabled=false;
    if(recordKey)keyAll(data,time);
    viewMode='camera';
  },recordKey?'已记录全部场景状态与当前视角。':'已将当前视角保存为拍摄机位。');
}

function topSelection() {
  if(!data)return [];
  const state=currentScene();
  return [...selection].filter(id=>{
    let parent=objectById(id,state)?.parentId;
    while(parent){if(selection.has(parent))return false;parent=objectById(parent,state)?.parentId;}
    return true;
  });
}

function select(id, additive=false, range=false) {
  if(range&&selectedId()) {
    const list=data.objects.map(object=>object.id),a=list.indexOf(selectedId()),b=list.indexOf(id);
    for(const item of list.slice(Math.min(a,b),Math.max(a,b)+1))selection.add(item);
  }else if(additive){if(selection.has(id))selection.delete(id);else selection.add(id);}
  else {selection.clear();if(id)selection.add(id);}
  attachTransform();
  ui.sync(currentScene(),[...selection],true);
}

function addAsset(type) {
  if(data.objects.length>=MAX_OBJECTS){ui.message(`场景最多 ${MAX_OBJECTS} 个对象。`,true);return;}
  mutate(()=>{
    const id=crypto.randomUUID();
    data.objects.push({id,type,label:EDITOR_ASSETS.find(item=>item.id===type)?.label||'对象',position:[0,type.includes('light')?2:0,0],rotation:[0,0,0],scale:[1,1,1],...(type.includes('light')?{light:{color:'#ffffff',intensity:3}}:{}),...(type==='camera'?{focal:35}:{})});
    selection.clear();selection.add(id);
  },'已加入场景。直接拖动角色手脚控制点，或用坐标轴调整对象。');
}

function newCamera() {
  mutate(()=>{
    const record=cameraRecord(activeCamera()),rotation=new THREE.Euler().setFromQuaternion(new THREE.Quaternion(...record.quaternion));
    const id=crypto.randomUUID();data.objects.push({id,type:'camera',label:`相机 ${data.objects.filter(o=>o.type==='camera').length+1}`,position:record.position,rotation:[rotation.x,rotation.y,rotation.z].map(deg),scale:[1,1,1],focal:record.focal});selection.clear();selection.add(id);
  },'相机已创建在当前视角。点“进入所选相机”驾驶，或“作为拍摄机位”用于导出。');
}

function pilotCamera(id=selectedId()) {
  const record=objectById(id,currentScene());
  if(record?.type!=='camera'){ui.message('先在层级中选择一台相机，或点击“新建相机”。',true);return;}
  if(record.locked){ui.message('相机已锁定，请先解锁再驾驶。',true);return;}
  stopPlayback();pilotId=id;viewMode='pilot';putCamera(camera,cameraRecord(roots.get(id).userData.camera));updateViewUI();
  ui.message(`正在驾驶「${record.label}」：右键 + WASD / QE 调整相机，脱离后保留位置。`);
}

function useCamera(id) {
  const root=roots.get(id);if(!root?.userData.camera)return;
  mutate(()=>{data.camera={...data.camera,...cameraRecord(root.userData.camera)};data.camera.rail.enabled=false;for(const property of ['position','quaternion','focal'])syncTrackedProperty('camera',property);pilotId=null;viewMode='camera';},'所选相机已作为 H3 输出拍摄机位。');
}

function updatePilotedCamera() {
  const root=roots.get(pilotId);if(!root)return;
  const matrix=new THREE.Matrix4().compose(camera.position,camera.quaternion,new THREE.Vector3(1,1,1));
  root.parent.updateMatrixWorld(true);matrix.premultiply(root.parent.matrixWorld.clone().invert());
  const position=new THREE.Vector3(),rotation=new THREE.Quaternion(),scale=new THREE.Vector3();matrix.decompose(position,rotation,scale);
  const rebuilt=new THREE.Matrix4().compose(position,rotation,scale);
  if(matrix.elements.some((value,index)=>Math.abs(value-rebuilt.elements[index])>1e-5)){ui.message('父级非均匀缩放会造成相机剪切。请先解除挂接再驾驶。',true);return;}
  root.position.copy(position);root.quaternion.copy(rotation);root.scale.copy(scale);storeRootTransform(pilotId,root);world.updateMatrixWorld(true);
}

function createRail(animated) {
  mutate(()=>{
    const view=activeCamera(),position=view.getWorldPosition(new THREE.Vector3()),right=new THREE.Vector3(1,0,0).applyQuaternion(view.getWorldQuaternion(new THREE.Quaternion()));
    if(!data.camera.rail.enabled){data.camera.rail.points=[-2,0,2].map(offset=>position.clone().addScaledVector(right,offset).toArray());data.camera.rail.lookAt=position.clone().addScaledVector(view.getWorldDirection(new THREE.Vector3()),5).toArray();}
    data.camera.rail.enabled=true;
    if(animated){setKey(data,'camera','rail.progress',0,0,'smooth');setKey(data,'camera','rail.progress',data.sequence.duration,1,'smooth');}
    enterFree();selection.clear();railSelection=0;
  },animated?'导轨相机已建立：进度从起点到终点。拖蓝色控制点修改路线，播放查看镜头。':'样条编辑已开启：直接拖动蓝色点；在属性面板添加/移除控制点。');
  focusRail();
  setTimeout(()=>{const rail=$('layout-rail-details');if(rail){rail.open=true;rail.parentElement.open=true;rail.scrollIntoView({block:'nearest'});}},0);
}

function focusRail() {
  const points=currentScene().camera.rail.points||[];if(!points.length)return;
  const box=new THREE.Box3().setFromPoints(points.map(point=>new THREE.Vector3(...point))),center=box.getCenter(new THREE.Vector3());
  const radius=Math.max(1.2,box.getSize(new THREE.Vector3()).length()/2);
  enterFree();camera.position.copy(center).addScaledVector(new THREE.Vector3(.65,.5,1).normalize(),radius*3.5);camera.lookAt(center);orbit.target.copy(center);saveDraft();
}

function getCharacters() {return window.LumenBoard?.getCharacters?.()||[];}

async function addCharacter(character) {
  if(!ready||!$('layout-dialog').open)await open();
  if(!character?.image_url){ui.message('此角色没有可用图片参考。',true);return;}
  if(data.objects.length+2>MAX_OBJECTS){ui.message('场景对象数量已达上限。',true);return;}
  const identity={character_id:character.character_id,asset_id:character.asset_id};
  const reference={image_url:character.image_url,name:character.name,description:character.description||'',items:copy(character.items||[])};
  mutate(()=>{
    const proxy=crypto.randomUUID(),board=crypto.randomUUID();
    data.objects.push({id:proxy,type:'adult_female',label:character.name+' · 姿势代理',position:[0,0,0],rotation:[0,0,0],scale:[1,1,1],...identity,reference:{...reference,kind:'proxy'}},
      {id:board,type:'plane',label:character.name+' · 原图参考',position:[-1.6,1.1,0],rotation:[0,0,0],scale:[1,1,1],...identity,reference:{...reference,kind:'image'}});
    selection.clear();selection.add(proxy);selection.add(board);
  },'已加入原始图片和可摆姿势的人体代理。代理用于构图，不是精确三维重建。');
  await refresh(true);focusSelection();
}

function duplicate() {
  if(!selection.size)return;
  mutate(()=>{
    const prefab=createPrefab(data,[...selection],'副本');
    const ids=instantiatePrefab(data,prefab,[.5,0,0]);
    selection.clear();ids.forEach(id=>selection.add(id));
  });
}

function removeSelected() {
  let removed=0;
  mutate(()=>{const previous=data.objects.length;deleteObjects(data,[...selection].filter(id=>!objectById(id)?.locked));removed=previous-data.objects.length;selection.clear();});
  if(removed)ui.message(`已删除 ${removed} 个对象（含原始子级）。可撤销恢复。`);
}

function reparentSelected(parentId, ids=[...selection]) {
  mutate(()=>{
    for(const id of ids) {
      if(objectById(id)?.locked)continue;
      if(time>0||data.sequence.tracks.some(track=>track.targetId===id&&track.property==='parentId'))attachAt(data,id,parentId,time);
      else reparent(data,id,parentId,{keepWorld:true});
    }
  },'已挂接并保持世界位置。时间线中的挂接切换也已记录。');
}

function groupSelected() {
  if(!selection.size)return;
  mutate(()=>{const result=createGroup(data,[...selection],'新组');selection.clear();selection.add(typeof result==='string'?result:result.id);});
}

async function importedRoot(record) {
  const url=record.asset?.url;
  if(!url)throw new Error('导入对象缺少本地模型文件。');
  if(!assets.has(url))assets.set(url,gltfLoader.loadAsync(url));
  const gltf=await assets.get(url);
  const content=cloneSkeleton(gltf.scene),root=new THREE.Group();
  root.add(content);
  root.traverse(part=>{
    if(part.isMesh){part.geometry=part.geometry.clone();part.material=Array.isArray(part.material)?part.material.map(m=>m.clone()):part.material.clone();}
  });
  root.userData.importedClips=gltf.animations.map(original=>{
    const clip=original.clone();
    for(const track of clip.tracks){const binding=THREE.PropertyBinding.parseTrackName(track.name),node=THREE.PropertyBinding.findNode(content,binding.nodeName);if(node)track.name=node.uuid+track.name.slice(binding.nodeName.length);}
    return clip;
  });
  if(gltf.animations.length)root.userData.mixer=new THREE.AnimationMixer(content);
  return root;
}

function editorAsset(record) {
  const root=new THREE.Group();
  const marker=new THREE.Mesh(
    record.type==='camera'?new THREE.BoxGeometry(.28,.2,.36):new THREE.SphereGeometry(.14,12,8),
    new THREE.MeshBasicMaterial({color:record.type==='camera'?'#9acbff':'#d7e9ff',wireframe:true})
  );
  marker.userData.editorOnly=true;root.add(marker);
  if(record.type==='camera'){
    const lens=new THREE.PerspectiveCamera(50,16/9,.05,1000);lens.filmGauge=36;
    root.userData.camera=lens;root.add(lens);
  }else{
    const light=record.type==='point_light'?new THREE.PointLight():record.type==='spot_light'?new THREE.SpotLight():new THREE.DirectionalLight();
    light.intensity=record.light?.intensity??3;
    if(light.target){light.target.position.set(0,0,-1);root.add(light.target);}
    root.userData.light=light;root.add(light);
  }
  return root;
}

async function ensureObjects(state) {
  const ids=new Set(state.objects.map(record=>record.id));
  for(const [id,root] of roots)if(!ids.has(id)){
    transform.detach();world.remove(root);root.removeFromParent();disposeAsset(root);roots.delete(id);mixers.delete(id);
  }
  const revision=sceneRevision;
  for(const record of state.objects)if(!roots.has(record.id)){
    const root=record.reference?.kind==='image'?await createReferenceImage(record):record.type==='group'?new THREE.Group():record.type==='imported'?await importedRoot(record):EXTRA_ASSETS.some(asset=>asset.id===record.type)?editorAsset(record):createAsset(record.type,record);
    if(revision!==sceneRevision){disposeAsset(root);return;}
    root.name=record.id;root.userData.recordId=record.id;
    root.traverse(part=>{if(part.isMesh){part.castShadow=true;part.receiveShadow=true;}});
    world.add(root);roots.set(record.id,root);
    if(root.userData.mixer)mixers.set(record.id,root.userData.mixer);
    if(root.userData.rig){
      const complete=serializeRig(root);
      Object.assign(record,complete);
      const source=objectById(record.id);if(source)for(const property of ['pose','hands','body','face','ik','material'])if(!source[property]||!Object.keys(source[property]).length)source[property]=copy(complete[property]);
    }
  }
}

function applyState(state) {
  for(const record of state.objects){
    const root=roots.get(record.id);if(!root)continue;
    const parent=record.parentId?roots.get(record.parentId):world;
    if(parent&&root.parent!==parent)parent.add(root);
    root.position.fromArray(record.position);root.rotation.set(...record.rotation.map(rad));root.scale.fromArray(record.scale);
    root.visible=record.visible!==false;root.userData.locked=!!record.locked;
    if(root.userData.light){root.userData.light.color.set(record.light?.color||'#ffffff');root.userData.light.intensity=record.light?.intensity??3;}
    else if(root.userData.camera)root.userData.camera.setFocalLength(record.focal||35);
    else if(root.userData.rig)applyRig(root,record);
    else if(record.type!=='group'&&record.reference?.kind!=='image'&&(record.type!=='imported'||record.asset?.materialOverride)){
      if(record.type==='imported')root.traverse(part=>{for(const material of part.material?Array.isArray(part.material)?part.material:[part.material]:[])material.userData.layoutTint=true;});
      applyMaterial(root,record.material||{});
    }
    const mixer=mixers.get(record.id);
    if(mixer){
      const clips=root.userData.importedClips,index=Math.max(0,Math.min(clips.length-1,Math.floor(Number(record.animation?.clip)||0))),clip=clips[index];
      const enabled=record.animation?.enabled!==false;
      if(root.userData.activeClip!==clip||root.userData.clipEnabled!==enabled){mixer.stopAllAction();if(enabled)mixer.clipAction(clip).play();root.userData.activeClip=clip;root.userData.clipEnabled=enabled;}
      mixer.setTime(Math.max(0,time*(record.animation?.speed??1)+(record.animation?.offset??0)));
    }
  }
  world.updateMatrixWorld(true);
  putCamera(shotCamera,state.camera);
  grid.visible=!!state.viewport.grid;axes.visible=!!state.viewport.axes;
  railOverlay.update(state.camera.rail);railOverlay.visible=!busy&&!!state.camera.rail.enabled;
  renderer.shadowMap.enabled=state.viewport.renderMode!=='simple';
  renderer.toneMappingExposure=state.environment.exposure;
  if(!busy)renderer.setPixelRatio(state.viewport.renderMode==='simple'?1:Math.min(devicePixelRatio,1.5));
  refreshMarkers(state);
  updateBounds();
  applyEnvironment(state.environment);
}

async function refresh(force=false) {
  if(!ready)return;
  if(syncing){syncAgain=true;return;}
  syncing=true;
  try {
    const revision=sceneRevision,state=currentScene();await ensureObjects(state);
    if(revision!==sceneRevision){syncAgain=true;return;}
    applyState(state);dirty=false;
    attachTransform();ui.sync(state,[...selection],force);timeline.render(data,time);updateViewUI();updateHistory();
  } catch(error){ui.message(error.message,true);console.error(error);}
  finally{syncing=false;if(syncAgain){syncAgain=false;refresh(force);}}
}

function setupRenderer() {
  renderer=new THREE.WebGLRenderer({antialias:true,preserveDrawingBuffer:true});
  renderer.outputColorSpace=THREE.SRGBColorSpace;renderer.toneMapping=THREE.ACESFilmicToneMapping;
  renderer.shadowMap.type=THREE.PCFSoftShadowMap;
  const canvas=renderer.domElement;canvas.id='layout-canvas';canvas.tabIndex=0;
  canvas.setAttribute('aria-label','三维视口，右键飞行，直接拖动人物控制点');ui.viewport.prepend(canvas);
  world=new THREE.Scene();world.background=new THREE.Color('#1d2939');
  camera=new THREE.PerspectiveCamera(50,16/9,.05,1000);camera.filmGauge=36;
  shotCamera=camera.clone();
  floor=new THREE.Mesh(new THREE.PlaneGeometry(200,200),new THREE.MeshStandardMaterial({color:'#65768d',roughness:.9}));
  floor.rotation.x=-Math.PI/2;floor.position.y=-.02;floor.receiveShadow=true;world.add(floor);
  grid=new THREE.GridHelper(40,40,'#adcae9','#7289a7');grid.material.transparent=true;grid.material.opacity=.2;world.add(grid);
  axes=new THREE.AxesHelper(2);world.add(axes);
  railOverlay=new RailOverlay();world.add(railOverlay);
  lights=new THREE.Group();lights.add(new THREE.HemisphereLight('#dbeaff','#516078',2));
  const key=new THREE.DirectionalLight('#f2f7ff',3);key.position.set(4,8,5);key.castShadow=true;key.shadow.mapSize.set(1024,1024);key.shadow.camera.left=key.shadow.camera.bottom=-15;key.shadow.camera.right=key.shadow.camera.top=15;key.shadow.normalBias=.035;lights.add(key);world.add(lights);
  orbit=new OrbitControls(camera,canvas);orbit.enabled=false;orbit.enableDamping=false;orbit.enableZoom=false;
  orbit.mouseButtons.LEFT=THREE.MOUSE.ROTATE;orbit.mouseButtons.MIDDLE=THREE.MOUSE.PAN;orbit.mouseButtons.RIGHT=null;
  orbit.addEventListener('end',()=>saveDraft());
  transform=new TransformControls(camera,canvas);transform.setSize(1);transformHelper=transform.getHelper();world.add(transformHelper);
  pivot=new THREE.Group();world.add(pivot);
  bounds=new THREE.Box3Helper(new THREE.Box3(),'#9cddff');bounds.material.transparent=true;bounds.material.opacity=.45;world.add(bounds);
  transform.addEventListener('mouseDown',beginTransform);
  transform.addEventListener('objectChange',changeTransform);
  transform.addEventListener('mouseUp',endTransform);
  transform.addEventListener('dragging-changed',event=>{orbit.enabled=false;if(event.value&&pointer)pointer.dragged=true;});
  bindViewport();new ResizeObserver(resize).observe(ui.viewport);
}

function resize() {
  if(!ready||!$('layout-dialog').open||busy)return;
  const width=Math.max(200,ui.viewport.clientWidth),height=Math.max(150,ui.viewport.clientHeight);
  const framed=viewMode!=='free';
  const renderWidth=framed?Math.min(width,height*16/9):width;
  const renderHeight=framed?renderWidth*9/16:height;
  const focal=camera.getFocalLength();
  renderer.setSize(renderWidth,renderHeight);camera.aspect=width/height;shotCamera.aspect=16/9;
  camera.setFocalLength(focal);shotCamera.setFocalLength(currentScene().camera.focal);
  camera.updateProjectionMatrix();shotCamera.updateProjectionMatrix();
  if(viewMode==='pilot'){const pilot=roots.get(pilotId)?.userData.camera;if(pilot){pilot.aspect=16/9;pilot.updateProjectionMatrix();}}
  ui.thirds.style.inset=`${(height-renderHeight)/2}px ${(width-renderWidth)/2}px`;
}

function applyEnvironment(environment) {
  const signature=JSON.stringify(environment);
  if(signature===environmentSignature)return environmentReady;
  environmentSignature=signature;
  world.environmentIntensity=environment.intensity;
  world.environmentRotation.set(0,rad(environment.rotation||0),0);
  world.backgroundRotation.set(0,rad(environment.rotation||0),0);
  if(!environment.hdri){world.environment=null;world.background=new THREE.Color('#1d2939');environmentReady=Promise.resolve();return environmentReady;}
  if(hdrTextures.has(environment.hdri)){
    const texture=hdrTextures.get(environment.hdri);world.environment=texture;world.background=environment.background?texture:new THREE.Color('#1d2939');
    environmentReady=Promise.resolve();return environmentReady;
  }
  environmentReady=(async()=>{try{
    const preset=HDR_PRESETS.find(item=>item.id===environment.hdri);if(!preset)throw new Error('HDR 环境不存在');
    if(!hdrs.has(preset.id))hdrs.set(preset.id,hdrLoader.loadAsync(preset.url));
    const texture=await hdrs.get(preset.id);texture.mapping=THREE.EquirectangularReflectionMapping;
    hdrTextures.set(preset.id,texture);
    if(environmentSignature!==signature)return;
    world.environment=texture;world.background=environment.background?texture:new THREE.Color('#1d2939');
  }catch(error){ui.message('HDR 载入失败：'+error.message,true);throw error;}})();
  environmentReady.catch(()=>{});
  return environmentReady;
}

async function preloadVideoEnvironments() {
  const ids=new Set([data.environment.hdri]);
  for(const track of data.sequence.tracks)if(track.targetId==='environment'&&track.property==='hdri')for(const key of track.keys)ids.add(key.value);
  await Promise.all([...ids].filter(Boolean).map(async id=>{
    if(hdrTextures.has(id))return;
    const preset=HDR_PRESETS.find(item=>item.id===id);if(!preset)throw new Error('动画使用的 HDR 环境不存在：'+id);
    if(!hdrs.has(id))hdrs.set(id,hdrLoader.loadAsync(preset.url));
    const texture=await hdrs.get(id);texture.mapping=THREE.EquirectangularReflectionMapping;hdrTextures.set(id,texture);
  }));
}

function updateBounds() {
  const box=new THREE.Box3();let has=false;
  for(const id of selection){const root=roots.get(id);if(root&&visible(root)){box.union(new THREE.Box3().setFromObject(root));has=true;}}
  bounds.visible=has&&!playing;bounds.box.copy(box);
}

function attachTransform() {
  if(transform.dragging||ikDrag||railDrag)return;
  transform.camera=activeCamera();
  const ids=topSelection().filter(id=>roots.has(id)&&!objectById(id)?.locked&&(viewMode!=='pilot'||id!==pilotId));
  transform.detach();
  if(!ids.length||playing)return;
  if(ids.length===1)transform.attach(roots.get(ids[0]));
  else {updateBounds();bounds.box.getCenter(pivot.position);pivot.quaternion.identity();pivot.scale.set(1,1,1);pivot.updateMatrixWorld();transform.attach(pivot);}
}

function beginTransform() {
  transformBefore=snapshot();transformMatrices.clear();world.updateMatrixWorld(true);
  for(const id of topSelection())if(!objectById(id)?.locked)transformMatrices.set(id,roots.get(id).matrixWorld.clone());
  pivotBefore=pivot.matrixWorld.clone().invert();
}

function storeRootTransform(id,root) {
  const record=objectById(id);record.position=root.position.toArray();record.rotation=[deg(root.rotation.x),deg(root.rotation.y),deg(root.rotation.z)];record.scale=root.scale.toArray();
  for(const property of ['position','rotation','scale'])syncTrackedProperty(id,property);
}

function changeTransform() {
  if(!transformBefore)return;
  if(transform.object===pivot){
    pivot.updateMatrixWorld();const delta=pivot.matrixWorld.clone().multiply(pivotBefore);
    const next=[];
    for(const [id,matrix]of transformMatrices){
      const root=roots.get(id),local=root.parent.matrixWorld.clone().invert().multiply(delta.clone().multiply(matrix));
      const position=new THREE.Vector3(),quaternion=new THREE.Quaternion(),scale=new THREE.Vector3();local.decompose(position,quaternion,scale);
      const recomposed=new THREE.Matrix4().compose(position,quaternion,scale);
      if(local.elements.some((value,index)=>Math.abs(value-recomposed.elements[index])>1e-5)){
        ui.message('父级含非均匀缩放，此旋转会产生无法保存的剪切。请先解除挂接或统一父级缩放。',true);return;
      }
      next.push({id,root,position,quaternion,scale});
    }
    for(const item of next){item.root.position.copy(item.position);item.root.quaternion.copy(item.quaternion);item.root.scale.copy(item.scale);storeRootTransform(item.id,item.root);}
  }else if(transform.object)storeRootTransform(transform.object.userData.recordId,transform.object);
  world.updateMatrixWorld(true);refreshMarkers(currentScene());updateBounds();
}

function endTransform() {
  if(transformBefore)remember(transformBefore);transformBefore=null;dirty=true;refresh(true);
}

function refreshMarkers(state) {
  const wanted=new Set();
  for(const record of state.objects) {
    const root=roots.get(record.id);
    if(!root?.userData.rig||record.locked||!visible(root))continue;
    for(const target of getIKTargets(root)) {
      const id=record.id+'|'+target.id;wanted.add(id);
      let marker=markers.get(id);
      if(!marker) {
        marker=new THREE.Mesh(markerGeometry,new THREE.MeshBasicMaterial({color:target.kind==='pole'?'#bca0ff':'#8adeff',transparent:true,opacity:.7,depthTest:false,depthWrite:false}));
        marker.userData={objectId:record.id,targetId:target.id,label:target.label,pole:target.kind==='pole'};
        marker.renderOrder=20;world.add(marker);markers.set(id,marker);
      }
      marker.position.copy(target.object.getWorldPosition(new THREE.Vector3()));
      marker.visible=!busy&&!playing;
      marker.material.opacity=selection.has(record.id)?.9:.45;
    }
  }
  for(const [id,marker] of markers)if(!wanted.has(id)){marker.removeFromParent();marker.material.dispose();markers.delete(id);}
  scaleMarkers();
}

function scaleMarkers() {
  const view=activeCamera();
  for(const marker of markers.values()) {
    const radius=Math.max(.018,view.getWorldPosition(new THREE.Vector3()).distanceTo(marker.position)*.012)*(marker.userData.pole?.75:1)*(marker===hovered?1.4:1);
    marker.scale.setScalar(radius);
    marker.material.color.set(marker===hovered?'#f1fbff':marker.userData.pole?'#bca0ff':'#8adeff');
  }
}

function railPointAt(event) {
  if(!railOverlay.visible||playing)return -1;
  const box=renderer.domElement.getBoundingClientRect(),points=currentScene().camera.rail.points||[];
  let nearest=-1,distance=16;
  points.forEach((point,index)=>{const p=new THREE.Vector3(...point).project(activeCamera());if(p.z<-1||p.z>1)return;const d=Math.hypot(box.x+(p.x+1)*box.width/2-event.clientX,box.y+(1-p.y)*box.height/2-event.clientY);if(d<distance){nearest=index;distance=d;}});
  return nearest;
}

function scaleRailPoints() {
  if(!railOverlay.visible)return;
  const points=currentScene().camera.rail.points||[],viewPosition=activeCamera().getWorldPosition(new THREE.Vector3());
  const matrix=new THREE.Matrix4(),q=new THREE.Quaternion();
  points.forEach((point,index)=>{const p=new THREE.Vector3(...point),radius=Math.max(.025,viewPosition.distanceTo(p)*.012)*(index===railSelection?1.25:1);matrix.compose(p,q,new THREE.Vector3().setScalar(radius/.055));railOverlay.controlPoints.setMatrixAt(index,matrix);railOverlay.controlPoints.setColorAt(index,new THREE.Color(index===railSelection?'#ffffff':'#7acaff'));});
  railOverlay.controlPoints.instanceMatrix.needsUpdate=true;if(railOverlay.controlPoints.instanceColor)railOverlay.controlPoints.instanceColor.needsUpdate=true;
}

function beginRailDrag(event,index) {
  event.preventDefault();event.stopImmediatePropagation();stopPlayback();beginControlGesture();
  railSelection=index;const position=new THREE.Vector3(...currentScene().camera.rail.points[index]);
  const plane=new THREE.Plane().setFromNormalAndCoplanarPoint(activeCamera().getWorldDirection(new THREE.Vector3()),position);
  const hit=pointerRay(event).ray.intersectPlane(plane,new THREE.Vector3());
  railDrag={index,plane,offset:hit?hit.sub(position):new THREE.Vector3()};transform.enabled=false;transform.detach();orbit.enabled=false;
  renderer.domElement.setPointerCapture(event.pointerId);renderer.domElement.style.cursor='grabbing';
  ui.message(`拖动样条点 ${index+1} · Esc 取消 · 一次撤销恢复整次拖动`);
}

function moveRailDrag(event) {
  const point=pointerRay(event).ray.intersectPlane(railDrag.plane,new THREE.Vector3());
  if(point)setProperty('camera',`rail.points.${railDrag.index}`,point.sub(railDrag.offset).toArray());
}

function endRailDrag(cancel=false) {
  if(!railDrag)return;railDrag=null;transform.enabled=true;renderer.domElement.style.cursor='';endControlGesture(cancel);
}

function pointerRay(event) {
  const box=renderer.domElement.getBoundingClientRect();
  mouse.set((event.clientX-box.left)/box.width*2-1,-(event.clientY-box.top)/box.height*2+1);
  raycaster.setFromCamera(mouse,activeCamera());
  return raycaster;
}

function markerAt(event) {
  return pointerRay(event).intersectObjects([...markers.values()].filter(marker=>marker.visible),false)[0]?.object;
}

function pickObject(event) {
  const hit=pointerRay(event).intersectObjects([...roots.values()].filter(visible),true)[0];
  let root=hit?.object;
  while(root&&!root.userData.recordId)root=root.parent;
  select(root?.userData.recordId||null,event.ctrlKey||event.metaKey,event.shiftKey);
}

function beginIK(event,marker) {
  if(objectById(marker.userData.objectId)?.locked)return;
  event.preventDefault();event.stopImmediatePropagation();
  selection.clear();selection.add(marker.userData.objectId);
  const before=snapshot(),normal=activeCamera().getWorldDirection(new THREE.Vector3());
  const plane=new THREE.Plane().setFromNormalAndCoplanarPoint(normal,marker.position);
  const hit=pointerRay(event).ray.intersectPlane(plane,new THREE.Vector3());
  ikDrag={before,marker,plane,offset:hit?hit.sub(marker.position):new THREE.Vector3()};
  transform.enabled=false;transform.detach();orbit.enabled=false;
  renderer.domElement.setPointerCapture(event.pointerId);
  renderer.domElement.style.cursor='grabbing';
  ui.sync(currentScene(),[...selection],true);
}

function moveIK(event) {
  const point=pointerRay(event).ray.intersectPlane(ikDrag.plane,new THREE.Vector3());
  if(!point)return;
  point.sub(ikDrag.offset);
  const id=ikDrag.marker.userData.objectId,root=roots.get(id),record=objectById(id);
  solveIK(root,ikDrag.marker.userData.targetId,point);
  Object.assign(record,serializeRig(root));
  syncTrackedProperty(id,'pose');syncTrackedProperty(id,'ik');
  world.updateMatrixWorld(true);
  refreshMarkers(currentScene());updateBounds();
}

function endIK(cancel=false) {
  if(!ikDrag)return;
  const before=ikDrag.before;ikDrag=null;
  if(cancel)data=before;else remember(before);
  transform.enabled=true;renderer.domElement.style.cursor='';dirty=true;refresh(true);
}

function updateOrbitTarget() {
  const distance=Math.max(2,camera.position.distanceTo(orbit.target));
  orbit.target.copy(camera.position).addScaledVector(camera.getWorldDirection(new THREE.Vector3()),distance);
}

function enterFree() {
  if(viewMode!=='free')putCamera(camera,cameraRecord(activeCamera()));
  pilotId=null;viewMode='free';orbit.object=camera;updateOrbitTarget();updateViewUI();
}

function stopFly() {
  if(!fly)return;
  const before=fly.before;if(pilotId)updatePilotedCamera();
  fly=null;keys.clear();transform.enabled=true;updateOrbitTarget();saveDraft();
  if(before){remember(before);dirty=true;refresh(true);}
  renderer.domElement.classList.remove('flying');
}

function bindViewport() {
  const canvas=renderer.domElement;
  canvas.addEventListener('contextmenu',event=>event.preventDefault());
  canvas.addEventListener('pointerdown',event=>{
    if(busy)return;
    canvas.focus({preventScroll:true});
    if(event.button===2) {
      event.preventDefault();event.stopImmediatePropagation();stopPlayback();
      const before=viewMode==='pilot'?snapshot():null;
      if(viewMode==='pilot'){const record=cameraRecord(activeCamera());camera.aspect=16/9;putCamera(camera,record);}else enterFree();
      transform.enabled=false;orbit.enabled=false;fly={x:event.clientX,y:event.clientY,before};
      canvas.setPointerCapture(event.pointerId);canvas.classList.add('flying');return;
    }
    const navigation=event.button===1||(event.button===0&&event.altKey);
    if(navigation){stopPlayback();enterFree();orbit.enabled=true;transform.enabled=false;event.preventDefault();}
    else {
      orbit.enabled=false;
      if(event.button===0){const point=railPointAt(event);if(point>=0){beginRailDrag(event,point);return;}const marker=markerAt(event);if(marker){stopPlayback();beginIK(event,marker);return;}}
      transform.enabled=true;
    }
    pointer={x:event.clientX,y:event.clientY,navigation,dragged:false};
  },true);
  canvas.addEventListener('pointermove',event=>{
    if(railDrag){moveRailDrag(event);return;}
    if(ikDrag){moveIK(event);return;}
    if(fly){
      const dx=event.clientX-fly.x,dy=event.clientY-fly.y;fly.x=event.clientX;fly.y=event.clientY;
      const angles=new THREE.Euler().setFromQuaternion(camera.quaternion,'YXZ');
      angles.y-=dx*.003;angles.x=THREE.MathUtils.clamp(angles.x-dy*.003,-Math.PI/2+.015,Math.PI/2-.015);angles.z=0;
      camera.quaternion.setFromEuler(angles);return;
    }
    if(transform.dragging)return;
    const railPoint=railPointAt(event);
    if(railPoint>=0){railSelection=railPoint;canvas.style.cursor='grab';ui.message(`样条点 ${railPoint+1}：按住左键直接拖动，当前时间的轨道关键帧同步更新。`);return;}
    const next=markerAt(event);
    if(next!==hovered){hovered=next;canvas.style.cursor=next?'grab':'';scaleMarkers();if(next)ui.message(`${objectById(next.userData.objectId)?.label} · ${next.userData.label}：直接拖动调整。`);}
  });
  canvas.addEventListener('pointerup',event=>{
    if(railDrag){endRailDrag();return;}
    if(ikDrag){endIK();return;}
    if(event.button===2){stopFly();return;}
    if(pointer&&!pointer.navigation&&!pointer.dragged&&!transform.dragging&&event.button===0&&Math.hypot(event.clientX-pointer.x,event.clientY-pointer.y)<4&&!transform.axis)pickObject(event);
    pointer=null;transform.enabled=true;
  });
  canvas.addEventListener('pointercancel',()=>{endRailDrag(true);endIK(true);stopFly();pointer=null;});
  canvas.addEventListener('wheel',event=>{
    if(busy)return;event.preventDefault();
    if(fly)speed=THREE.MathUtils.clamp(speed*(event.deltaY<0?1.2:1/1.2),.2,40);
    else {enterFree();camera.position.addScaledVector(camera.getWorldDirection(new THREE.Vector3()),-Math.sign(event.deltaY)*Math.max(.15,camera.position.distanceTo(orbit.target)*.08));saveDraft();}
  },{passive:false});
  window.addEventListener('blur',()=>{stopFly();endIK();endRailDrag();});
  $('layout-dialog').addEventListener('keydown',event=>{
    event.stopPropagation();
    if(busy){if(event.key==='Escape'){event.preventDefault();exportCancelled=true;activeExportController?.abort();}return;}
    const key=event.key.toLowerCase(),typing=/^(INPUT|TEXTAREA|SELECT)$/.test(event.target.tagName);
    if(railDrag&&key==='escape'){event.preventDefault();endRailDrag(true);return;}
    if(typing)return;
    if(fly){if(['w','a','s','d','q','e','shift'].includes(key)){keys.add(key);event.preventDefault();}return;}
    const ctrl=event.ctrlKey||event.metaKey;
    if(ctrl&&key==='z'){event.preventDefault();undo(event.shiftKey);}
    else if(ctrl&&key==='y'){event.preventDefault();undo(true);}
    else if(ctrl&&key==='s'){event.preventDefault();fileUI?.save();}
    else if(ctrl&&key==='d'){event.preventDefault();duplicate();}
    else if(key==='w'||key==='e'||key==='r'){event.preventDefault();setTransform({w:'translate',e:'rotate',r:'scale'}[key]);}
    else if(key==='f'){event.preventDefault();focusSelection();}
    else if(key==='k'){event.preventDefault();captureCamera(true);}
    else if(key===' '){event.preventDefault();togglePlayback();}
    else if(key==='delete'||key==='backspace'){event.preventDefault();if(timeline.selectedCount())timeline.deleteSelected();else removeSelected();}
  });
  $('layout-dialog').addEventListener('keyup',event=>{event.stopPropagation();keys.delete(event.key.toLowerCase());});
  $('layout-dialog').addEventListener('cancel',event=>{if(busy){event.preventDefault();exportCancelled=true;activeExportController?.abort();}});
}

function setTransform(mode) {
  transform.setMode(mode);attachTransform();
  for(const name of ['translate','rotate','scale'])$('layout-tool-'+name).classList.toggle('active',name===mode);
}

function focusSelection() {
  const box=new THREE.Box3();
  for(const id of selection.size?selection:roots.keys()){const root=roots.get(id);if(root&&visible(root))box.union(new THREE.Box3().setFromObject(root));}
  if(box.isEmpty())return;
  enterFree();
  const center=box.getCenter(new THREE.Vector3()),radius=Math.max(.5,box.getSize(new THREE.Vector3()).length()/2),forward=camera.getWorldDirection(new THREE.Vector3());
  const vertical=rad(camera.fov),horizontal=2*Math.atan(Math.tan(vertical/2)*camera.aspect);
  const distance=radius/Math.sin(Math.min(vertical,horizontal)/2)*1.12;
  camera.position.copy(center).addScaledVector(forward,-distance);camera.lookAt(center);orbit.target.copy(center);saveDraft();
}

function updateViewUI() {
  ui.viewButton.textContent=viewMode==='free'?'自由视角':viewMode==='pilot'?'驾驶相机':'拍摄机位';
  ui.viewButton.classList.toggle('active',viewMode==='camera');
  $('layout-exit-camera').disabled=viewMode==='free';
  $('layout-pilot-camera').classList.toggle('active',viewMode==='pilot');
  for(const [id,root] of roots)root.traverse(part=>{if(part.userData.editorOnly)part.visible=viewMode!=='pilot'||id!==pilotId;});
  transform.camera=activeCamera();
  setTransform(transform.mode);
  resize();
}

function seek(value) {
  stopPlayback();time=THREE.MathUtils.clamp(value,0,data.sequence.duration);viewMode='camera';dirty=true;
  refresh();timeline.setTime(time);saveDraft();
}

function stopPlayback() {
  if(!ready)return;
  playing=false;timeline.setPlaying(false);attachTransform();updateBounds();
  for(const marker of markers.values())marker.visible=!busy;
}

function togglePlayback() {
  if(busy)return;
  if(playing){stopPlayback();return;}
  if(time>=data.sequence.duration-.001)time=0;
  viewMode='camera';playing=true;playOffset=time;playStart=performance.now();timeline.setPlaying(true);transform.detach();bounds.visible=false;
  for(const marker of markers.values())marker.visible=false;
  updateViewUI();
}

function animate(now) {
  animationFrame=0;
  if(!$('layout-dialog').open)return;
  const delta=Math.min(.05,(now-lastFrame)/1000||.016);lastFrame=now;
  if(fly){
    const local=new THREE.Vector3(Number(keys.has('d'))-Number(keys.has('a')),0,Number(keys.has('s'))-Number(keys.has('w')));
    if(local.lengthSq())camera.position.addScaledVector(local.normalize().applyQuaternion(camera.quaternion),speed*delta*(keys.has('shift')?3:1));
    camera.position.y+=(Number(keys.has('e'))-Number(keys.has('q')))*speed*delta*(keys.has('shift')?3:1);
    if(pilotId)updatePilotedCamera();
  }
  if(!busy){
    if(playing){time=Math.min(data.sequence.duration,playOffset+(now-playStart)/1000);applyState(currentScene());timeline.setTime(time);if(time>=data.sequence.duration){stopPlayback();saveDraft();}}
    else if(dirty&&!ikDrag&&!railDrag&&!controlGesture&&!transform.dragging&&!syncing)refresh();
    scaleMarkers();scaleRailPoints();renderer.render(world,activeCamera());
    const view=activeCamera();ui.hud.textContent=`${viewMode==='free'?'自由视口':viewMode==='pilot'?'驾驶 · '+objectById(pilotId)?.label:'拍摄机位'} · ${Math.round(view.getFocalLength())} mm · ${view.getWorldPosition(new THREE.Vector3()).y.toFixed(2)} m · 飞行 ${speed.toFixed(1)}`;
  }
  animationFrame=requestAnimationFrame(animate);
}

function changeRig(id,kind,value,side) {
  mutate(()=>{
    const root=roots.get(id),record=objectById(id);
    if(kind==='pose')applyPose(root,value);
    if(kind==='hand')applyHand(root,side,value);
    if(kind==='expression')applyExpression(root,value);
    Object.assign(record,serializeRig(root));
    for(const property of ['pose','hands','face'])syncTrackedProperty(id,property);
  });
}

async function thumbnail(type) {
  if(thumbnails.has(type))return thumbnails.get(type);
  const root=EXTRA_ASSETS.some(asset=>asset.id===type)?editorAsset({type}):createAsset(type,{id:'thumbnail-'+type}),scene=new THREE.Scene();scene.background=new THREE.Color('#17263a');
  scene.add(root,new THREE.HemisphereLight('#e7f1ff','#6b7a94',3));
  const light=new THREE.DirectionalLight('#fff',3);light.position.set(4,6,5);scene.add(light);
  const box=new THREE.Box3().setFromObject(root),center=box.getCenter(new THREE.Vector3()),length=Math.max(.5,box.getSize(new THREE.Vector3()).length()),view=new THREE.PerspectiveCamera(35,1.2,.01,100);
  view.position.copy(center).add(new THREE.Vector3(.7,.35,1).normalize().multiplyScalar(length*1.5));view.lookAt(center);
  const size=renderer.getSize(new THREE.Vector2()),ratio=renderer.getPixelRatio();renderer.setPixelRatio(1);renderer.setSize(144,120,false);renderer.render(scene,view);
  const url=renderer.domElement.toDataURL('image/png');renderer.setPixelRatio(ratio);renderer.setSize(size.x,size.y);disposeAsset(root);thumbnails.set(type,url);return url;
}

async function importAsset(asset) {
  if(data.objects.length>=MAX_OBJECTS)throw new Error('场景对象数量已达上限。');
  await gltfLoader.loadAsync(asset.url);
  const id=crypto.randomUUID();
  mutate(()=>{data.objects.push({id,type:'imported',label:asset.name||'导入模型',asset:copy(asset),position:[0,0,0],rotation:[0,0,0],scale:[1,1,1]});selection.clear();selection.add(id);},'本地模型已载入场景。');
  await refresh(true);focusSelection();
}

function helpers(show) {
  grid.visible=show&&data.viewport.grid;axes.visible=show&&data.viewport.axes;
  transformHelper.visible=show&&!!transform.object;bounds.visible=show&&!!selection.size;
  for(const marker of markers.values())marker.visible=show;
  railOverlay.visible=show&&!!currentScene().camera.rail.enabled;
  for(const root of roots.values())root.traverse(part=>{if(part.userData.editorOnly)part.visible=show;});
  ui.thirds.hidden=!show||!data.viewport.thirds;
}

function setBusy(value) {busy=value;ui.setBusy(value);updateHistory();}

async function upload(blob,extension) {
  const body=new FormData();body.append('file',blob,'lumen-previs-'+Date.now()+'.'+extension);
  const response=await fetch('/api/upload',{method:'POST',body}),result=await response.json();
  if(!response.ok)throw new Error(result.error||'上传失败');
  return result.name;
}

function exportNotes(video=false,start=time,duration=0) {
  const scene=evaluateScene(data,start);
  return `真实三维${video?'动画预演视频':'构图参考'}。参考空间、遮挡、机位与动作；简模外貌和材质不是最终人物外观。焦距${scene.camera.focal.toFixed(1)}mm。${video?`截取完整时间线 ${start.toFixed(2)} 秒起 ${duration.toFixed(2)} 秒。`:''}`;
}

async function exportImage() {
  if(busy)return;
  stopPlayback();const saved=snapshot(),notes=exportNotes(),aspect=shotCamera.aspect;
  try{
    setBusy(true);exportCancelled=false;await ensureObjects(currentScene());applyState(currentScene());await environmentReady;helpers(false);
    renderer.setPixelRatio(1);renderer.setSize(960,540);shotCamera.aspect=16/9;shotCamera.setFocalLength(currentScene().camera.focal);renderer.render(world,shotCamera);
    ui.message('正在保存真实构图参考…');
    const blob=await new Promise(resolve=>renderer.domElement.toBlob(resolve,'image/png'));
    if(!blob)throw new Error('构图渲染失败。');
    const file=await upload(blob,'png');if(exportCancelled)throw new Error('已取消导出。');
    await window.LumenBoard.addLayoutReference({file,notes,layout:saved,itemId:editingKind==='image'?editingId:null});
    saveDraft(true);$('layout-dialog').close();
  }catch(error){ui.message(error.message,true);}
  finally{shotCamera.aspect=aspect;shotCamera.updateProjectionMatrix();setBusy(false);helpers(true);resize();}
}

async function exportVideo() {
  if(busy)return;
  const start=Math.max(0,Math.min(exportStart,data.sequence.duration)),requested=Math.min(15,exportDuration,data.sequence.duration-start);
  if(requested<.21){ui.message('视频片段起点须早于结束，且至少保留 0.21 秒。',true);return;}
  const fps=24,frameCount=Math.max(6,Math.min(360,Math.round(requested*fps))),duration=frameCount/fps;
  stopPlayback();const saved=snapshot(),previousTime=time,aspect=shotCamera.aspect,notes=exportNotes(true,start,duration);
  activeExportController=new AbortController();
  const signal=activeExportController.signal;
  const checkCancelled=()=>{if(exportCancelled||signal.aborted)throw new DOMException('已取消动画导出。','AbortError');};
  try{
    setBusy(true);exportCancelled=false;ui.message('正在准备本地逐帧渲染…');
    await preloadVideoEnvironments();checkCancelled();await ensureObjects(currentScene());
    renderer.setPixelRatio(1);renderer.setSize(960,540);shotCamera.aspect=16/9;
    const body=new FormData();body.append('fps',String(fps));
    for(let frame=0;frame<frameCount;frame++){
      checkCancelled();time=start+frame/fps;applyState(currentScene());helpers(false);renderer.render(world,shotCamera);
      const blob=await new Promise(resolve=>renderer.domElement.toBlob(resolve,'image/png'));
      if(!blob)throw new Error(`第 ${frame+1} 帧渲染失败。`);
      body.append('frames',blob,`frame${String(frame).padStart(6,'0')}.png`);
      ui.message(`逐帧渲染 ${frame+1} / ${frameCount} · ${fps} fps · ${duration.toFixed(2)} 秒`);
      await new Promise(resolve=>setTimeout(resolve,0));
    }
    checkCancelled();ui.message(`正在本地编码 ${frameCount} 帧并核对视频…`);
    const response=await fetch('/api/previs/render-video',{method:'POST',body,signal});
    const result=await response.json();
    if(!response.ok)throw new Error(result.error||'本地视频编码失败。');
    checkCancelled();
    await window.LumenBoard.addLayoutVideo({file:result.name,notes,layout:saved,duration:result.duration??duration});
    time=previousTime;saveDraft(true);$('layout-dialog').close();
  }catch(error){ui.message(error.name==='AbortError'?'已取消动画导出。':error.message,true);}
  finally{
    activeExportController=null;
    time=previousTime;applyState(currentScene());shotCamera.aspect=aspect;shotCamera.updateProjectionMatrix();setBusy(false);helpers(true);resize();saveDraft();
  }
}

function createAPI() {
  return {
    undo:()=>undo(),redo:()=>undo(true),close:()=>$('layout-dialog').close(),
    fullscreen:async()=>{if(document.fullscreenElement)await document.exitFullscreen();else await $('layout-dialog').requestFullscreen();resize();},
    select,group:groupSelected,duplicate,remove:removeSelected,reparent:reparentSelected,
    rename:(id,label)=>setProperty(id,'label',label),property:setProperty,key:keyProperty,
    beginGesture:beginControlGesture,endGesture:endControlGesture,
    addAsset,thumbnail,transform:setTransform,focus:focusSelection,
    toggleView:()=>{if(viewMode==='free'){pilotId=null;viewMode='camera';updateViewUI();}else enterFree();},
    newCamera,pilotCamera,useCamera,exitCamera:enterFree,createRail,focusRail,characters:getCharacters,addCharacter,
    captureCamera:()=>captureCamera(),
    viewport:(key,value)=>mutate(()=>{data.viewport[key]=value;}),
    environment:(key,value)=>mutate(()=>{data.environment[key]=value;syncTrackedProperty('environment',key);}),
    selection:()=>[...selection],evaluated:currentScene,isRig:id=>!!roots.get(id)?.userData.rig,
    clips:id=>(roots.get(id)?.userData.importedClips||[]).map((clip,index)=>({id:String(index),label:clip.name||`动画 ${index+1}`})),
    pose:(id,value)=>changeRig(id,'pose',value),hand:(id,side,value)=>changeRig(id,'hand',value,side),
    expression:(id,value)=>changeRig(id,'expression',value),
    joint:value=>{if(value)selectedJoint=value;return selectedJoint;},
    cameraAngles:record=>new THREE.Euler().setFromQuaternion(new THREE.Quaternion(...record.quaternion),'YXZ').toArray().slice(0,3).map(deg),
    cameraAngle:(axis,value)=>{const record=currentScene().camera,angle=new THREE.Euler().setFromQuaternion(new THREE.Quaternion(...record.quaternion),'YXZ');angle[['x','y','z'][axis]]=rad(value);setProperty('camera','quaternion',new THREE.Quaternion().setFromEuler(angle).toArray());},
    railPoint:()=>mutate(()=>{data.camera.rail.points=copy(currentScene().camera.rail.points);data.camera.rail.points.push(activeCamera().getWorldPosition(new THREE.Vector3()).toArray());if(data.camera.rail.points.length>32)throw new Error('轨道最多 32 个点。');syncTrackedProperty('camera','rail.points');}),
    removeRailPoint:index=>mutate(()=>{data.camera.rail.points=copy(currentScene().camera.rail.points);if(data.camera.rail.points.length<=2)throw new Error('轨道至少保留两个点。');data.camera.rail.points.splice(index,1);syncTrackedProperty('camera','rail.points');}),
    exportRange:value=>{if(value){if(value.start!=null)exportStart=value.start;if(value.duration!=null)exportDuration=value.duration;}return{start:exportStart,duration:exportDuration};},
    exportImage,exportVideo,cancelExport:()=>{exportCancelled=true;activeExportController?.abort();}
  };
}

function timelineAPI() {
  return {
    play:togglePlayback,seek,keyAll:()=>captureCamera(true),
    undo,stop:stopPlayback,message:text=>ui.message(text),
    editKeys:edits=>mutate(()=>applyKeyEdits(data,edits)),
    pasteKeys:entries=>mutate(()=>pasteKeys(data,entries)),
    duration:value=>mutate(()=>{
      const last=Math.max(0,...data.sequence.tracks.flatMap(track=>track.keys.map(key=>key.time)));
      if(last>value)throw new Error(`末尾关键帧位于 ${last.toFixed(2)} 秒，请先移走或删除，再缩短时间线。`);
      data.sequence.duration=value;time=Math.min(time,value);exportDuration=Math.min(exportDuration,value);
    }),
    fps:value=>mutate(()=>{data.sequence.fps=value;}),
    moveKeys:items=>mutate(()=>applyKeyEdits(data,items)),
    removeKeys:items=>mutate(()=>{for(const item of items)removeKey(data,item.trackId,item.keyId);}),
    interpolation:(items,value)=>mutate(()=>{for(const item of items){const key=data.sequence.tracks.find(track=>track.id===item.trackId)?.keys.find(key=>key.id===item.keyId);if(key)key.interpolation=value;}})
  };
}

let activeExportController=null;
async function exportGLB(options={}) {
  activeExportController=new AbortController();
  try{
    setBusy(true);
    const blob=await exportSceneGLB(snapshot(),{
      fps:options.fps??data.sequence.fps,includeAnimation:options.includeAnimation!==false,signal:activeExportController.signal,
      onProgress:progress=>{ui.message(typeof progress==='string'?progress:progress.message||`正在烘焙三维动画 ${progress.frame||0} / ${progress.totalFrames||progress.total||''}…`);options.onProgress?.(progress);}
    });
    if(blob.lumenWarnings?.length)ui.message(blob.lumenWarnings.join('；'));
    return blob;
  }finally{activeExportController=null;setBusy(false);}
}

async function installScene(value,clearHistory=true) {
  stopPlayback();endIK();endRailDrag();endControlGesture();stopFly();pilotId=null;
  data=normalizeScene(value);sceneRevision++;
  time=THREE.MathUtils.clamp(Number(data.viewport.playhead)||0,0,data.sequence.duration);
  putCamera(camera,data.viewport.editorCamera||data.camera);putCamera(shotCamera,evaluateScene(data,time).camera);updateOrbitTarget();
  transform.detach();
  for(const root of roots.values()){root.removeFromParent();disposeAsset(root);}roots.clear();mixers.clear();
  for(const marker of markers.values()){marker.removeFromParent();marker.material.dispose();}markers.clear();
  hovered=null;environmentSignature='';selection.clear();if(data.objects[0])selection.add(data.objects[0].id);
  if(clearHistory){history=[];future=[];timeline.resetForScene();}
  viewMode='free';exportStart=0;exportDuration=Math.min(15,data.sequence.duration);dirty=true;
  await refresh(true);resize();saveDraft();
}

function initialize() {
  const api=createAPI();
  ui=new EditorUI($('layout-editor'),api,{assets:EDITOR_ASSETS,poses:POSES,hands:HAND_POSES,joints:JOINTS,body:BODY_FIELDS,face:FACE_FIELDS,expressions:EXPRESSION_PRESETS,hdri:HDR_PRESETS});
  timeline=new TimelineUI(ui.timelineMount,timelineAPI());
  setupRenderer();ready=true;
  fileUI=mountFileUI(ui.fileActions,{
    getScene:snapshot,getSelection:()=>[...selection],
    loadScene:async scene=>{editingId=null;editingKind=null;await installScene(scene);},
    createPrefab:()=>{if(!selection.size)throw new Error('请先选择要保存为 Prefab 的对象。');return createPrefab(snapshot(),[...selection],'新 Prefab');},
    addPrefab:async prefab=>{mutate(()=>{const ids=instantiatePrefab(data,prefab);selection.clear();ids.forEach(id=>selection.add(id));});await refresh(true);focusSelection();},
    onImportAsset:importAsset,exportGLB,cancelExport:()=>activeExportController?.abort()
  });
}

async function open() {
  try{
    if(!ready)initialize();
    const card=window.LumenBoard?.getSelectedLayout?.();editingId=card?.id||null;editingKind=card?.kind||null;
    let draft=null;
    if(!card?.layout){try{draft=JSON.parse(localStorage.getItem(STORE)||localStorage.getItem('lumen-layout-scene-v2'));}catch{}}
    $('layout-dialog').showModal();
    await installScene(card?.layout||draft||initialScene());
    ui.message(card?.layout?'已恢复参考素材的完整可编辑场景。':draft?'已恢复本机三维草稿。':'点击角色控制点直接摆姿势；调整后按 K 记录当前状态。');
    lastFrame=performance.now();if(!animationFrame)animationFrame=requestAnimationFrame(animate);
  }catch(error){console.error(error);if(!$('layout-dialog').open)$('layout-dialog').showModal();if(ui)ui.message('三维工作室无法打开：'+error.message,true);}
}

function init() {
  if(!$('layout-open'))return;
  $('layout-open').addEventListener('click',open);
  $('layout-dialog').addEventListener('close',()=>{
    if(!ready)return;
    endIK();stopFly();stopPlayback();exportCancelled=true;activeExportController?.abort();
    endRailDrag();endControlGesture();
    if(!busy)saveDraft(true);
    cancelAnimationFrame(animationFrame);animationFrame=0;
    if(document.fullscreenElement)document.exitFullscreen();
  });
  window.LumenLayout={
    open,getScene:()=>ready?snapshot():null,
    getEvaluatedScene:()=>ready?copy(currentScene()):null,
    loadScene:async value=>{if(!ready)initialize();await installScene(value);},
    importAsset,addCharacter,
    getSelection:()=>[...selection]
  };
  window.addEventListener('lumen:characters-changed',()=>{if(ready)ui.renderCharacters();});
}

if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init);else init();
