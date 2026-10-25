// Regenerate after changing the local asset/pose/expression library. No WebGL or network.
import { writeFile } from 'node:fs/promises';
import * as assets from '../static/layout-assets.js';
import { normalizeScene } from '../static/layout-scene.js';

const rig = assets.createAsset('adult_female', { id: 'catalog-character' });
const poses = assets.POSES.map(preset => ({ ...preset, pose: assets.applyPose(rig, preset.id) }));
const hands = assets.HAND_POSES.map(preset => {
  assets.applyHand(rig, 'left', preset.id);
  assets.applyHand(rig, 'right', preset.id);
  const pose = assets.serializeRig(rig).pose;
  return { ...preset, joints: Object.fromEntries(Object.entries(pose).filter(([name]) => /thumb|index|middle|ring|pinky/i.test(name))) };
});
assets.disposeAsset(rig);
const catalog = {
  version: 1, units: { position: 'metres', rotation: 'Euler XYZ degrees', quaternion: '[x,y,z,w]', time: 'seconds', up: '+Y', forward: '+Z' },
  assets: assets.ASSETS, poses, hand_poses: hands, joints: assets.JOINTS,
  body_fields: assets.BODY_FIELDS, face_fields: assets.FACE_FIELDS, expressions: assets.EXPRESSION_PRESETS,
  hdri: assets.HDR_PRESETS, default_scene: normalizeScene({version:3,objects:[]}),
  timeline_properties: ['position','rotation','quaternion','scale','focal','near','far','visible','parentId','pose','hands','body','face','ik','material','color','rail','intensity','exposure','rotationY','background','hdri','lighting','animation','enabled','power','light'],
  notes: ['Procedural people and props are original blocking assets, not finished production models.',
    'Copy pose into a character record; proportions affect the result. Left/right hand joints remain independently editable.',
    'Whole-container tracks evaluate before their property tracks. parentId is discrete; matrix-preserving attachments should be authored in the editor or scene module.',
    'Prefab is a version 3 scene saved with kind=prefab.']
};
await writeFile(new URL('../agent-catalog.json', import.meta.url), JSON.stringify(catalog, null, 2) + '\n', 'utf8');
console.log(`Agent catalog: ${catalog.assets.length} assets, ${poses.length} poses, ${hands.length} hands`);
