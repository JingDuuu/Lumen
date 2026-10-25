import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from '../static/vendor/three/three.module.js';
import {
  ASSETS, POSES, HAND_POSES, JOINTS, BODY_FIELDS, createAsset,
  applyRig, applyPose, applyHand, solveIK, getIKTargets, serializeRig, disposeAsset,
  FACE_FIELDS, EXPRESSION_PRESETS, applyFace, applyExpression, applyMaterial, HDR_PRESETS,
} from '../static/layout-assets.js';

const world = object => object.getWorldPosition(new THREE.Vector3());
const near = (a, b, epsilon = 0.0001) => assert.ok(a.distanceTo(b) < epsilon, `${a.toArray()} != ${b.toArray()}`);
const validTree = root => {
  root.updateWorldMatrix(true, true);
  let meshes = 0;
  root.traverse(object => {
    assert.ok(object.matrixWorld.elements.every(Number.isFinite));
    if (object.isMesh) {
      meshes++;
      assert.ok([...object.geometry.attributes.position.array].every(Number.isFinite));
    }
  });
  assert.ok(meshes > 0);
  const bounds = new THREE.Box3().setFromObject(root);
  assert.ok([...bounds.min.toArray(), ...bounds.max.toArray()].every(Number.isFinite));
  assert.ok(bounds.max.y > bounds.min.y);
};

test('all local assets create finite visible geometry and catalog identifiers are unique', () => {
  assert.ok(ASSETS.length >= 35);
  assert.equal(new Set(ASSETS.map(asset => asset.id)).size, ASSETS.length);
  for (const asset of ASSETS) {
    const root = createAsset(asset.id);
    validTree(root);
    assert.equal(root.userData.proceduralBlockingModel, true);
    disposeAsset(root);
    assert.equal(root.children.length, 0);
  }
  assert.equal(createAsset('person').userData.assetType, 'adult_male');
  assert.throws(() => createAsset('unknown'));
});

test('human profiles, rig hierarchy and body boundaries are real', () => {
  const adult = createAsset('adult_male'), child = createAsset('child_girl');
  assert.equal(Object.keys(adult.userData.rig.joints).length, JOINTS.length);
  assert.equal(getIKTargets(adult).length, 8);
  assert.equal(adult.userData.rig.joints.leftElbow.node.parent, adult.userData.rig.joints.leftShoulder.node);
  assert.equal(adult.userData.rig.joints.leftIndex3.node.parent, adult.userData.rig.joints.leftIndex2.node);
  assert.ok(child.userData.body.height < adult.userData.body.height);
  const identity = adult, previousJoint = adult.userData.rig.joints.head.node;
  applyRig(adult, { body: { height: 99, build: 0, shoulderWidth: NaN } });
  assert.equal(adult, identity);
  assert.notEqual(adult.userData.rig.joints.head.node, previousJoint);
  for (const field of BODY_FIELDS) assert.ok(adult.userData.body[field.id] >= field.min && adult.userData.body[field.id] <= field.max);
  validTree(adult);
  disposeAsset(adult); disposeAsset(child);
});

test('all body presets are stable, grounded, and serialize without accumulating pelvis movement', () => {
  const root = createAsset('adult_female');
  for (const preset of POSES) {
    const first = applyPose(root, preset.id), second = applyPose(root, preset.id);
    assert.deepEqual(second, first);
    validTree(root);
    const bounds = new THREE.Box3().setFromObject(root);
    assert.ok(Math.abs(bounds.min.y) < 0.00001, `${preset.id} floor=${bounds.min.y}`);
    const saved = JSON.parse(JSON.stringify(serializeRig(root)));
    const restored = createAsset('adult_female', saved);
    for (const id of Object.keys(root.userData.rig.chains)) near(world(root.userData.rig.chains[id].end), world(restored.userData.rig.chains[id].end));
    assert.deepEqual(JSON.parse(JSON.stringify(serializeRig(restored))), saved);
    disposeAsset(restored);
  }
  disposeAsset(root);
});

test('hand presets move each finger chain and keep the opposite hand, body and FK overrides independent', () => {
  const root = createAsset('adult_male');
  applyPose(root, 'sitting');
  const rightBefore = world(root.userData.rig.joints.rightIndex3.node);
  const pelvisBefore = world(root.userData.rig.joints.pelvis.node);
  applyHand(root, 'left', 'open');
  const openTip = world(root.userData.rig.joints.leftIndex3.node);
  applyHand(root, 'left', 'fist');
  assert.ok(openTip.distanceTo(world(root.userData.rig.joints.leftIndex3.node)) > 0.025);
  near(rightBefore, world(root.userData.rig.joints.rightIndex3.node));
  near(pelvisBefore, world(root.userData.rig.joints.pelvis.node));
  for (const preset of HAND_POSES) {
    applyHand(root, 'left', preset.id); validTree(root);
  }
  const saved = serializeRig(root);
  saved.pose.leftIndex2 = [-23, 12, 5];
  saved.pose.head = [10, 20, 5];
  applyRig(root, saved);
  const restored = createAsset('adult_male', serializeRig(root));
  near(world(root.userData.rig.joints.leftIndex3.node), world(restored.userData.rig.joints.leftIndex3.node));
  near(world(root.userData.rig.joints.head.node), world(restored.userData.rig.joints.head.node));
  assert.deepEqual(serializeRig(restored).hands, { left: 'thumbs_up', right: 'relaxed' });
  disposeAsset(root); disposeAsset(restored);
});

test('two-bone IK reaches hands and feet under a moved, rotated, nonuniformly scaled root', () => {
  const root = createAsset('adult_male');
  root.position.set(2.1, 0.5, -3.4); root.rotation.set(0.12, 0.8, -0.09); root.scale.set(1.2, 0.85, 1.4);
  for (const [id, chain] of Object.entries(root.userData.rig.chains)) {
    root.updateWorldMatrix(true, true);
    const local = chain.upper.position.clone().add(new THREE.Vector3(id.startsWith('left') ? 0.08 : -0.08, id.endsWith('Hand') ? -0.23 : -0.51, 0.25));
    const target = chain.upper.parent.localToWorld(local);
    const solved = solveIK(root, id, target);
    assert.ok(Object.keys(solved).length > 30);
    near(world(chain.end), target, 0.000001);
  }
  const saved = JSON.parse(JSON.stringify(serializeRig(root)));
  const restored = createAsset('adult_male', saved);
  restored.position.copy(root.position); restored.rotation.copy(root.rotation); restored.scale.copy(root.scale);
  restored.updateWorldMatrix(true, true);
  for (const id of Object.keys(root.userData.rig.chains)) near(world(root.userData.rig.chains[id].end), world(restored.userData.rig.chains[id].end));
  disposeAsset(root); disposeAsset(restored);
});

test('IK pole changes bend direction without moving end target; unreachable and zero-distance targets remain finite', () => {
  const root = createAsset('adult_male'), chain = root.userData.rig.chains.leftHand;
  const target = chain.upper.parent.localToWorld(chain.upper.position.clone().add(new THREE.Vector3(0, -0.35, 0.1)));
  solveIK(root, 'leftHand', target);
  const before = world(chain.lower);
  solveIK(root, 'leftHandPole', new THREE.Vector3(-0.6, 1.3, -0.6));
  near(world(chain.end), target, 0.000001);
  assert.ok(before.distanceTo(world(chain.lower)) > 0.05);
  const pole = serializeRig(root).ik.leftHandPole;
  assert.deepEqual(pole, [-0.6, 1.3, -0.6]);
  solveIK(root, 'leftHand', new THREE.Vector3(500, 500, 500)); validTree(root);
  const maximum = chain.lengths.reduce((a, b) => a + b);
  assert.ok(world(chain.upper).distanceTo(world(chain.end)) <= maximum + 0.00001);
  solveIK(root, 'leftHand', world(chain.upper)); validTree(root);
  assert.throws(() => solveIK(root, 'leftHand', [NaN, 0, 0]));
  disposeAsset(root);
});

test('asset disposal releases every shared geometry/material once and does not affect other assets', () => {
  const root = createAsset('adult_male'), other = createAsset('adult_male');
  const resources = new Set(); root.traverse(object => { if (object.geometry) resources.add(object.geometry); if (object.material) resources.add(object.material); });
  const counts = new Map();
  for (const resource of resources) { counts.set(resource, 0); resource.addEventListener('dispose', () => counts.set(resource, counts.get(resource) + 1)); }
  other.traverse(object => { assert.ok(!resources.has(object.geometry)); assert.ok(!resources.has(object.material)); });
  disposeAsset(root); disposeAsset(root);
  for (const count of counts.values()) assert.equal(count, 1);
  assert.equal(root.userData.rig, undefined);
  validTree(other); disposeAsset(other);
});

test('expanded poses have searchable metadata and distinct grounded body configurations', () => {
  assert.ok(POSES.length >= 60);
  assert.equal(new Set(POSES.map(p => p.id)).size, POSES.length);
  assert.ok(new Set(POSES.map(p => p.category)).size >= 6);
  const root = createAsset('adult_male');
  const configurations = new Set();
  for (const preset of POSES) {
    assert.ok(preset.description && preset.tags.length);
    const pose = applyPose(root, preset.id);
    configurations.add(JSON.stringify(pose));
  }
  assert.equal(configurations.size, POSES.length, 'presets must not merely relabel the same pose');
  disposeAsset(root);
});

test('expressions interpolate and serialize with zero geometry/material/node rebuilds', () => {
  const root = createAsset('adult_female', { id: 'character-test' });
  const before = [];
  root.traverse(object => before.push([object, object.name, object.geometry, object.material]));
  assert.equal(new Set(before.map(row => row[1])).size, before.length);
  assert.ok(EXPRESSION_PRESETS.length >= 6);
  for (const preset of EXPRESSION_PRESETS) {
    applyExpression(root, preset.id);
    for (const style of [0, 0.5, 1]) { applyFace(root, { style }); validTree(root); }
  }
  const a = EXPRESSION_PRESETS.find(p => p.id === 'sad').face, b = EXPRESSION_PRESETS.find(p => p.id === 'happy').face;
  const middle = Object.fromEntries(FACE_FIELDS.map(field => [field.id, (a[field.id] + b[field.id]) / 2]));
  applyFace(root, middle);
  assert.deepEqual(serializeRig(root).face, middle);
  for (let frame = 0; frame < 120; frame++) applyRig(root, { ...serializeRig(root), face: { ...middle, mouthOpen: frame / 120 } });
  const after = []; root.traverse(object => after.push([object, object.name, object.geometry, object.material]));
  assert.equal(after.length, before.length);
  after.forEach((row, i) => row.forEach((value, j) => assert.equal(value, before[i][j])));
  const saved = serializeRig(root), copy = createAsset('adult_female', { id: 'character-test', ...saved });
  assert.deepEqual(serializeRig(copy).face, saved.face);
  const names = []; copy.traverse(object => names.push(object.name)); assert.deepEqual(names, before.map(row => row[1]));
  const oldNames = names.slice(); applyRig(copy, { ...saved, body: { ...saved.body, height: 1.9 } });
  const rebuiltNames = []; copy.traverse(object => rebuiltNames.push(object.name)); assert.deepEqual(rebuiltNames, oldNames);
  disposeAsset(root); disposeAsset(copy);
});

test('face boundaries and material edits remain finite and preserve glass transparency and live geometry', () => {
  const root = createAsset('adult_male');
  const nodes = []; root.traverse(object => nodes.push(object));
  const face = applyFace(root, { eyeOpen: 400, mouthOpen: -10, style: 5, gazeX: NaN });
  assert.equal(face.eyeOpen, 1.4); assert.equal(face.mouthOpen, 0); assert.equal(face.style, 1); assert.equal(face.gazeX, 0);
  applyMaterial(root, { color: '#ff5533', roughness: 0.12, metalness: 0.8, opacity: 0.4 });
  applyRig(root, { ...serializeRig(root), color: '#22cc88', material: { color: '#22cc88', roughness: 0.3, metalness: 0.2, opacity: 1 } });
  const after = []; root.traverse(object => after.push(object)); assert.deepEqual(after, nodes);
  assert.equal(serializeRig(root).material.color, '#22cc88');
  validTree(root);
  const window = createAsset('window'), translucent = [];
  window.traverse(object => { if (object.material?.opacity < 1) translucent.push(object.material); });
  assert.ok(translucent.length);
  applyMaterial(window, { color: '#6633aa', opacity: 0.5 }); assert.ok(translucent.every(m => Math.abs(m.opacity - 0.14) < 0.00001));
  applyMaterial(window, { opacity: 1 }); assert.ok(translucent.every(m => Math.abs(m.opacity - 0.28) < 0.00001));
  assert.equal(serializeRig(window).material.color, '#6633aa');
  disposeAsset(root); disposeAsset(window);
});

test('HDR catalog uses only shipped local resources with explicit CC0 provenance', () => {
  assert.equal(HDR_PRESETS.length, 4);
  for (const hdr of HDR_PRESETS) { assert.equal(hdr.license, 'CC0-1.0'); assert.ok(hdr.url.startsWith('/static/hdri/')); assert.ok(hdr.preview.endsWith('.jpg')); }
});
