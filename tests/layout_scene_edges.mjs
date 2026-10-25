import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeScene, evaluateScene, setKey, keyAll, worldMatrix, reparent,
  createGroup, attachAt, createPrefab, instantiatePrefab, MAX_KEYS,
} from '../static/layout-scene.js';

const record = (id, extra = {}) => ({ id, type: 'box', position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1], ...extra });
const make = () => normalizeScene({ version: 3, objects: [record('actor'), record('parent', { position: [3, 0, 0] })], sequence: { duration: 4, fps: 24, tracks: [] } });
const nearMatrix = (a, b, tolerance = 1e-6) => a.elements.forEach((value, i) => assert.ok(Math.abs(value - b.elements[i]) < tolerance, `matrix[${i}] ${value} != ${b.elements[i]}`));
const clone = value => JSON.parse(JSON.stringify(value));

test('whole snapshots never overwrite more specific channels merely because track creation order differs', () => {
  const scene = make();
  setKey(scene, 'actor', 'pose.leftElbow', 0, [10, 0, 0]); setKey(scene, 'actor', 'pose.leftElbow', 4, [50, 0, 0]);
  setKey(scene, 'actor', 'pose', 0, { leftElbow: [0, 0, 0], head: [0, 10, 0] });
  setKey(scene, 'actor', 'pose', 4, { leftElbow: [0, 0, 0], head: [0, 30, 0] });
  setKey(scene, 'actor', 'position.0', 0, 8); setKey(scene, 'actor', 'position.0', 4, 12);
  setKey(scene, 'actor', 'position', 0, [0, 1, 0]); setKey(scene, 'actor', 'position', 4, [0, 3, 0]);
  const a = evaluateScene(scene, 2).objects[0]; scene.sequence.tracks.reverse(); const b = evaluateScene(scene, 2).objects[0];
  assert.deepEqual(a, b); assert.deepEqual(a.pose.leftElbow, [30, 0, 0]); assert.deepEqual(a.pose.head, [0, 20, 0]); assert.deepEqual(a.position, [10, 2, 0]);
});

test('numeric facial style is interpolated consistently in whole and individual channels', () => {
  const scene = make(); setKey(scene, 'actor', 'face.style', 0, 0); setKey(scene, 'actor', 'face.style', 4, 1);
  assert.equal(evaluateScene(scene, 2).objects[0].face.style, 0.5);
  scene.sequence.tracks = []; setKey(scene, 'actor', 'face', 0, { style: 0 }); setKey(scene, 'actor', 'face', 4, { style: 1 });
  assert.equal(evaluateScene(scene, 2).objects[0].face.style, 0.5);
});

test('IK pole state participates in quick keys and remains linear rather than angular', () => {
  const scene = make(); scene.objects[0].ik = { leftHandPole: [0.2, 1, 0.5] };
  keyAll(scene, 0); assert.ok(scene.sequence.tracks.some(t => t.targetId === 'actor' && t.property === 'ik'));
  setKey(scene, 'actor', 'ik.leftHandPole', 0, [0.2, 1, 0.5]); setKey(scene, 'actor', 'ik.leftHandPole', 4, [0.6, 2, 0.9]);
  assert.deepEqual(evaluateScene(scene, 2).objects[0].ik.leftHandPole, [0.4, 1.5, 0.7]);
});

test('keepWorld reparent bakes both child and animated parent transforms without changing sampled world trajectory', () => {
  const scene = make();
  setKey(scene, 'actor', 'position', 0, [0, 1, 0]); setKey(scene, 'actor', 'position', 4, [4, 1, 2]);
  setKey(scene, 'actor', 'position.1', 0, 1); setKey(scene, 'actor', 'position.1', 4, 2);
  setKey(scene, 'parent', 'position', 0, [3, 0, 0]); setKey(scene, 'parent', 'position', 4, [7, 0, 1]);
  setKey(scene, 'parent', 'rotation', 0, [0, 0, 0]); setKey(scene, 'parent', 'rotation', 4, [0, 80, 0]);
  const original = clone(scene); reparent(scene, 'actor', 'parent');
  assert.equal(scene.objects[0].parentId, 'parent');
  assert.ok(!scene.sequence.tracks.some(t => t.targetId === 'actor' && t.property === 'position.1'));
  for (const time of [0, 1, 2, 3, 4]) nearMatrix(worldMatrix(evaluateScene(original, time), 'actor'), worldMatrix(evaluateScene(scene, time), 'actor'));
  nearMatrix(worldMatrix(evaluateScene(original, 1.37), 'actor'), worldMatrix(evaluateScene(scene, 1.37), 'actor'), 0.001);
});

test('grouping animated objects preserves motion and its new group can offset the entire animation', () => {
  const scene = make(); setKey(scene, 'actor', 'position', 0, [0, 0, 0]); setKey(scene, 'actor', 'position', 4, [4, 0, 0]);
  const original = clone(scene), group = createGroup(scene, ['actor', 'parent']);
  for (const time of [0, 2, 4]) nearMatrix(worldMatrix(evaluateScene(original, time), 'actor'), worldMatrix(evaluateScene(scene, time), 'actor'));
  group.position[1] = 2;
  assert.equal(worldMatrix(evaluateScene(scene, 2), 'actor').elements[13], 2);
});

test('grouping ancestor and grandchild preserves intervening unselected parent links', () => {
  const scene = normalizeScene({ version: 3, objects: [record('A', { type: 'group', position: [2, 0, 0] }), record('B', { type: 'group', parentId: 'A', position: [0, 1, 0] }), record('C', { parentId: 'B', position: [0, 0, 3] })], sequence: { duration: 2, tracks: [] } });
  const before = worldMatrix(scene, 'C'), group = createGroup(scene, ['A', 'C']);
  assert.equal(scene.objects.find(o => o.id === 'A').parentId, group.id);
  assert.equal(scene.objects.find(o => o.id === 'B').parentId, 'A');
  assert.equal(scene.objects.find(o => o.id === 'C').parentId, 'B');
  nearMatrix(worldMatrix(scene, 'C'), before);
});

test('prefab internal animated attachments to external parents or world are self-contained and placement-safe', () => {
  for (const outside of ['external', null]) {
    const scene = normalizeScene({ version: 3, objects: [record('group', { type: 'group', position: [3, 0, 0] }), record('child', { parentId: 'group', position: [1, 0, 0] }), record('external', { position: [20, 0, 0] })], sequence: { duration: 4, fps: 24, tracks: [] } });
    setKey(scene, 'child', 'parentId', 0, 'group', 'step'); setKey(scene, 'child', 'parentId', 2, outside, 'step');
    setKey(scene, 'external', 'position', 0, [20, 0, 0]); setKey(scene, 'external', 'position', 4, [24, 0, 0]);
    const prefab = createPrefab(scene, ['group']);
    assert.ok(!prefab.sequence.tracks.some(t => t.property === 'parentId' && t.keys.some(k => k.value === 'external')));
    const destination = normalizeScene({ version: 3, objects: [], sequence: { duration: 4, fps: 24, tracks: [] } });
    const ids = instantiatePrefab(destination, prefab, [10, 0, 0]);
    const child = destination.objects.find(o => ids.includes(o.id) && o.label === 'box');
    assert.ok(child);
    for (const time of [0, 1, 2, 3, 4]) {
      const expected = worldMatrix(evaluateScene(scene, time), 'child').elements[12] - 3 + 10;
      assert.ok(Math.abs(worldMatrix(evaluateScene(destination, time), child.id).elements[12] - expected) < 1e-6);
    }
  }
});

function almostFull(scene) {
  scene.sequence.tracks = [{ id: 'full', targetId: 'actor', property: 'face.mouthOpen', interpolation: 'linear', keys: Array.from({ length: MAX_KEYS - 1 }, (_, i) => ({ id: 'key-' + i, time: 4 * i / (MAX_KEYS - 2), value: 0 })) }];
}
test('quick key and timed attachment fail atomically at the global key limit', () => {
  const scene = make(); almostFull(scene); const before = JSON.stringify(scene);
  assert.throws(() => keyAll(scene, 2), /上限/); assert.equal(JSON.stringify(scene), before);
  assert.throws(() => attachAt(scene, 'actor', 'parent', 2), /上限/); assert.equal(JSON.stringify(scene), before);
});

test('group and reparent failures preserve objects and tracks when baking exceeds the limit', () => {
  const scene = make(); almostFull(scene);
  scene.sequence.tracks[0].keys.pop(); setKey(scene, 'actor', 'position', 0, [0, 0, 0]);
  const before = JSON.stringify(scene);
  assert.throws(() => reparent(scene, 'actor', 'parent'), /上限/); assert.equal(JSON.stringify(scene), before);
  assert.throws(() => createGroup(scene, ['actor']), /上限/); assert.equal(JSON.stringify(scene), before);
});

test('camera or unrelated animation does not force unnecessary object baking', () => {
  const scene = make(); scene.sequence.duration = 300;
  setKey(scene, 'camera', 'position', 0, [0, 1, 5]); setKey(scene, 'camera', 'position', 300, [8, 1, 5]);
  const oldCount = scene.sequence.tracks.length;
  reparent(scene, 'actor', 'parent');
  assert.equal(scene.sequence.tracks.length, oldCount);
  const prefab = createPrefab(scene, ['actor']);
  assert.equal(prefab.sequence.tracks.length, 0);
});

test('quick key includes real light, auxiliary camera and imported animation state', () => {
  const scene=normalizeScene({version:3,objects:[{id:'lamp',type:'point_light',light:{color:'#ffccaa',intensity:4}},
    {id:'cam2',type:'camera',focal:50},{id:'model',type:'imported',animation:{clip:0,speed:1,enabled:true}}],sequence:{duration:4,fps:24,tracks:[]}});
  keyAll(scene,0);scene.objects[0].light.intensity=12;scene.objects[1].focal=80;scene.objects[2].animation.clip=1;keyAll(scene,4);
  const middle=evaluateScene(scene,2);assert.equal(middle.objects[0].light.intensity,8);assert.equal(middle.objects[1].focal,65);
  assert.equal(middle.objects[2].animation.clip,0);assert.equal(evaluateScene(scene,4).objects[2].animation.clip,1);
});

test('quick key captures component tracks so an existing axis cannot override a newly captured camera', () => {
  const scene=make();setKey(scene,'camera','position.0',0,1);setKey(scene,'camera','position.0',4,3);
  scene.camera.position[0]=12;keyAll(scene,2);assert.equal(evaluateScene(scene,2).camera.position[0],12);
  assert.equal(scene.sequence.tracks.find(t=>t.targetId==='camera'&&t.property==='position.0').keys.find(k=>k.time===2).value,12);
});
