/* Offline glTF exchange. Object parents are baked into world transforms so an
 * animated attachment remains portable to formats with a fixed node tree. */
import * as THREE from './vendor/three/three.module.js';
import { GLTFExporter } from './vendor/three/examples/jsm/exporters/GLTFExporter.js';
import { GLTFLoader } from './vendor/three/examples/jsm/loaders/GLTFLoader.js';
import { createAsset, applyRig, applyMaterial, disposeAsset } from './layout-assets.js';
import { normalizeScene, evaluateScene, worldMatrix } from './layout-scene.js';

const pause = () => new Promise(resolve => setTimeout(resolve, 0));
const abort = signal => { if (signal?.aborted) throw new DOMException('已取消导出', 'AbortError'); };
const assetURL = value => {
  const url = new URL(value || '', location.href);
  if (url.origin !== location.origin || !url.pathname.startsWith('/api/previs/assets/')) throw new Error('导入模型须先保存到本地素材库');
  return url.href;
};
function visible(scene, record) {
  const byId = new Map(scene.objects.map(o => [o.id,o]));
  for (let current = record; current; current = byId.get(current.parentId)) if (current.visible === false) return false;
  return true;
}
function prepareNames(root, prefix) {
  let index = 0;
  root.traverse(node => { node.name = prefix + '_' + index++; });
}
function collectNodes(root) { const nodes=[]; root.traverse(node=>nodes.push(node)); return nodes; }
function valueFor(node, property, hidden) {
  if (property === 'scale' && hidden) return [0,0,0];
  if (property === 'morphTargetInfluences') return [...node.morphTargetInfluences];
  return node[property].toArray();
}
function compressedTrack(name, property, times, values, size) {
  let changed=false;
  for(let i=size;i<values.length;i++) if(Math.abs(values[i]-values[i%size])>1e-6) {changed=true;break;}
  if(!changed)return null;
  // Drop consecutive constant samples while preserving the two ends of a hold.
  const kept=[0];
  for(let f=1;f<times.length-1;f++) {
    let same=true;
    for(let k=0;k<size;k++) if(Math.abs(values[f*size+k]-values[(f-1)*size+k])>1e-7 || Math.abs(values[f*size+k]-values[(f+1)*size+k])>1e-7) {same=false;break;}
    if(!same)kept.push(f);
  }
  kept.push(times.length-1);
  const t=kept.map(i=>times[i]),v=kept.flatMap(i=>values.slice(i*size,(i+1)*size));
  const C=property==='quaternion'?THREE.QuaternionKeyframeTrack:property==='morphTargetInfluences'?THREE.NumberKeyframeTrack:THREE.VectorKeyframeTrack;
  return new C(name+'.'+property,t,v);
}

export async function exportSceneGLB(input, {fps=24, includeAnimation=true, onProgress=()=>{}, signal}={}) {
  const data=normalizeScene(input),rate=Math.max(1,Math.min(60,Number(fps)||24));
  const frames=includeAnimation?Math.ceil(data.sequence.duration*rate):0;
  if(frames>3600)throw new Error('动画导出最多3600帧，请降低导出帧率或缩短片段');
  const scene=new THREE.Scene(),roots=new Map(),mixers=new Map(),samples=new Map(),times=[],cameraSamples=[];
  const camera=new THREE.PerspectiveCamera(50,16/9,.05,1000);camera.filmGauge=36;camera.name='Lumen_ShotCamera';scene.add(camera);
  const warnings=[];
  if(data.sequence.tracks.some(t=>/^material\.|^material$|^color$/.test(t.property))) warnings.push('材质使用首帧静态值；GLB/FBX不携带此编辑器的材质属性动画。');
  if(data.sequence.tracks.some(t=>['environment','scene'].includes(t.targetId))) warnings.push('HDR环境与曝光动画保存在Lumen场景文件中，不嵌入通用模型格式。');
  if(data.sequence.tracks.some(t=>t.targetId==='camera'&&t.property==='focal'))warnings.push('相机焦距动画附在Lumen数据中，本地转换器会恢复；标准GLB查看器不一定支持动态焦距。');
  if(data.sequence.tracks.some(t=>data.objects.some(o=>o.id===t.targetId&&(o.type.endsWith('_light')||o.type==='camera'))&&!/^(position|rotation|scale|parentId|visible)(\.|$)/.test(t.property)))warnings.push('对象灯光强度/颜色与辅助相机光学属性导出为首帧静态值，完整属性动画请保存Lumen场景包。');
  try {
    for(let i=0;i<data.objects.length;i++) {
      abort(signal); const record=data.objects[i]; let root;
      if(record.type==='imported') {
        const gltf=await new GLTFLoader().loadAsync(assetURL(record.asset?.url)),sourceRoot=gltf.scene;
        root=new THREE.Group();root.add(sourceRoot);
        if(gltf.animations.length) {
          // Bind imported animation by UUID before assigning export-safe node names.
          const clips=gltf.animations.map(source=>{const clip=source.clone();for(const track of clip.tracks){const binding=THREE.PropertyBinding.parseTrackName(track.name),node=THREE.PropertyBinding.findNode(sourceRoot,binding.nodeName);if(node)track.name=node.uuid+track.name.slice(binding.nodeName.length);}return clip;});
          mixers.set(record.id,{mixer:new THREE.AnimationMixer(sourceRoot),clips,index:null,enabled:null});
        }
        if(record.asset?.materialOverride){root.traverse(node=>{for(const mat of Array.isArray(node.material)?node.material:node.material?[node.material]:[])mat.userData.layoutTint=true;});applyMaterial(root,record.material);}
      } else if(record.type==='group') root=new THREE.Group();
      else if(record.type==='camera') { root=new THREE.PerspectiveCamera(50,16/9,.05,1000);root.filmGauge=36;root.setFocalLength(record.focal||35); }
      else if(record.type.endsWith('_light')) {
        const C=record.type==='point_light'?THREE.PointLight:record.type==='spot_light'?THREE.SpotLight:THREE.DirectionalLight;
        root=new C(record.color||'#ffffff',record.light?.intensity??record.intensity??3);
      } else root=createAsset(record.type,record);
      prepareNames(root,'Lumen_'+i);roots.set(record.id,root);scene.add(root);
      onProgress({stage:'准备模型',progress:Math.round(10*(i+1)/Math.max(1,data.objects.length))});
    }
    const nodeCount=1+[...roots.values()].reduce((n,r)=>n+collectNodes(r).length,0);
    if((frames+1)*nodeCount>2000000)throw new Error('此场景动画数据过大，请减少角色、缩短时长或降低导出帧率');
    for(let frame=0;frame<=frames;frame++) {
      abort(signal); const time=includeAnimation?Math.min(data.sequence.duration,frame/rate):0,at=evaluateScene(data,time),cache=new Map();times.push(time);
      for(let i=0;i<at.objects.length;i++) {
        const record=at.objects[i],root=roots.get(record.id);
        if(!['group','imported','camera','point_light','spot_light','directional_light'].includes(record.type)) {
          applyRig(root,record);prepareNames(root,'Lumen_'+i);
        }
        const state=mixers.get(record.id);
        if(state) {
          const index=Math.max(0,Math.min(state.clips.length-1,Math.floor(Number(record.animation?.clip)||0))),enabled=record.animation?.enabled!==false;
          if(index!==state.index||enabled!==state.enabled){state.mixer.stopAllAction();if(enabled)state.mixer.clipAction(state.clips[index]).play();state.index=index;state.enabled=enabled;}
          state.mixer.timeScale=1;state.mixer.setTime(Math.max(0,time*(record.animation?.speed??1)+(record.animation?.offset??0)));
        }
        const matrix=worldMatrix(at,record.id,cache),p=new THREE.Vector3(),q=new THREE.Quaternion(),s=new THREE.Vector3();matrix.decompose(p,q,s);
        const reconstructed=new THREE.Matrix4().compose(p,q,s);
        if(matrix.elements.some((v,i)=>Math.abs(v-reconstructed.elements[i])>1e-4))throw new Error('对象父级产生剪切，无法可靠导出；请先使用等比缩放');
        root.position.copy(p);root.quaternion.copy(q);root.scale.copy(s);
        root.visible=visible(at,record);
      }
      camera.position.fromArray(at.camera.position);camera.quaternion.fromArray(at.camera.quaternion);camera.setFocalLength(at.camera.focal);camera.near=at.camera.near;camera.far=at.camera.far;
      cameraSamples.push({time,focal:at.camera.focal});
      scene.updateMatrixWorld(true);
      for(const root of [...roots.values(),camera]) {
        root.traverse(node=>{
          let hidden=false;for(let p=node;p&&p!==scene;p=p.parent)if(p.visible===false){hidden=true;break;}
          for(const property of ['position','quaternion','scale',...(node.morphTargetInfluences?.length?['morphTargetInfluences']:[])]) {
            const key=node.name+'.'+property, value=valueFor(node,property,hidden);
            let sample=samples.get(key);if(!sample){sample={name:node.name,property,size:value.length,values:[]};samples.set(key,sample);}
            if(sample.size!==value.length)throw new Error('模型动画拓扑变化，无法烘焙到GLB');
            if(property==='quaternion'&&sample.values.length) {
              const prior=sample.values.slice(-4);if(prior.reduce((v,n,i)=>v+n*value[i],0)<0)for(let i=0;i<4;i++)value[i]*=-1;
            }
            sample.values.push(...value);
          }
        });
      }
      if(frame%8===0||frame===frames) {onProgress({stage:'烘焙动画',progress:10+Math.round(75*frame/Math.max(1,frames)),frame,totalFrames:frames+1});await pause();}
    }
    const tracks=[];
    for(const sample of samples.values()) {
      if(sample.values.length!==times.length*sample.size)throw new Error('动画期间模型节点发生变化，无法可靠导出');
      if(includeAnimation) {const track=compressedTrack(sample.name,sample.property,times,sample.values,sample.size);if(track)tracks.push(track);}
    }
    // Restore first-frame body geometry/materials before restoring sampled transforms.
    const first=evaluateScene(data,0);
    first.objects.forEach((record,i)=>{
      const root=roots.get(record.id);
      if(!['group','imported','camera','point_light','spot_light','directional_light'].includes(record.type)){applyRig(root,record);prepareNames(root,'Lumen_'+i);}
      else if(record.type==='imported'&&record.asset?.materialOverride)applyMaterial(root,record.material);
      else if(record.type.endsWith('_light')){root.color.set(record.light?.color||record.color||'#ffffff');root.intensity=record.light?.intensity??record.intensity??3;}
      else if(record.type==='camera'){root.setFocalLength(record.focal||35);root.near=record.near||.05;root.far=record.far||1000;root.updateProjectionMatrix();}
    });
    // Export at the first frame; animation channels then animate from this pose.
    scene.traverse(node=>{
      for(const property of ['position','quaternion','scale','morphTargetInfluences']) {
        const sample=samples.get(node.name+'.'+property);if(!sample)continue;const first=sample.values.slice(0,sample.size);
        if(property==='morphTargetInfluences')node.morphTargetInfluences=first;else node[property].fromArray(first);
      }
      node.visible=true;
      // Runtime rigs contain circular Object3D links, which are not glTF extras.
      node.userData={};
    });
    camera.setFocalLength(first.camera.focal);
    camera.near=first.camera.near;camera.far=first.camera.far;camera.updateProjectionMatrix();
    scene.userData.lumenPrevis={version:1,fps:rate,duration:includeAnimation?data.sequence.duration:0,camera:[{node:'Lumen_ShotCamera',keys:cameraSamples}],warnings,
      additionalTracks:data.sequence.tracks.filter(t=>['environment','scene'].includes(t.targetId)||/^(material|color)(\.|$)/.test(t.property)||data.objects.some(o=>o.id===t.targetId&&(o.type.endsWith('_light')||o.type==='camera'))&&!/^(position|rotation|scale|parentId|visible)(\.|$)/.test(t.property)),
      limitations:['HDR is stored in the Lumen scene.','Material animation is not supported by standard glTF.','Animated parents are baked into world-space transforms.']};
    const animations=tracks.length?[new THREE.AnimationClip('Lumen_Previs',data.sequence.duration,tracks)]:[];
    abort(signal);onProgress({stage:'封装GLB',progress:90});
    const buffer=await new GLTFExporter().parseAsync(scene,{binary:true,onlyVisible:false,animations,trs:true});
    abort(signal);onProgress({stage:'完成',progress:100});
    const blob=new Blob([buffer],{type:'model/gltf-binary'});blob.lumenWarnings=warnings;return blob;
  } finally { for(const root of roots.values())disposeAsset(root); }
}
