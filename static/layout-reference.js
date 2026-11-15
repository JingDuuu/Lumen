import * as THREE from './vendor/three/three.module.js';

const textures=new Map();

/* Used by the editor and GLB exporter so the original reference travels with it. */
export async function createReferenceImage(record) {
  const url=new URL(record.reference.image_url,location.href);
  if(url.origin!==location.origin)throw new Error('角色参考须使用本地素材图片。');
  if(!textures.has(url.href))textures.set(url.href,new THREE.TextureLoader().loadAsync(url.href));
  const original=await textures.get(url.href),texture=original.clone();texture.colorSpace=THREE.SRGBColorSpace;
  const aspect=texture.image.width/texture.image.height;
  const root=new THREE.Group();
  root.add(new THREE.Mesh(new THREE.PlaneGeometry(2*aspect,2),new THREE.MeshBasicMaterial({map:texture,side:THREE.DoubleSide,toneMapped:false})));
  return root;
}
