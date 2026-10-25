import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from '../static/vendor/three/three.module.js';
import { RailOverlay } from '../static/layout-rail.js';

const rail = { enabled: true, points: [[-3, 2, 4], [0, 3, 3], [3, 2, 4]], lookAt: [0, 1, 0], orientation: 'target' };
test('visible curve matches the same centripetal arc-length path as the scene camera', () => {
  const overlay = new RailOverlay().update(rail), curve = new THREE.CatmullRomCurve3(rail.points.map(p => new THREE.Vector3(...p)), false, 'centripetal');
  const positions = overlay.path.geometry.attributes.position;
  assert.equal(overlay.visible, true); assert.equal(overlay.controlPoints.count, 3);
  for (const i of [0, 64, 128, 192, 256]) {
    const actual = new THREE.Vector3().fromBufferAttribute(positions, i), expected = curve.getPointAt(i / 256);
    assert.ok(actual.distanceTo(expected) < 0.000001);
  }
  assert.deepEqual(overlay.target.position.toArray(), rail.lookAt);
  overlay.dispose();
});

test('unchanged points reuse buffers and all geometry/material objects across frames', () => {
  const overlay = new RailOverlay().update(rail), children = [...overlay.children], geometry = children.map(n => n.geometry), materials = children.map(n => n.material);
  const position = overlay.path.geometry.attributes.position, controls = overlay.controlPolygon.geometry.attributes.position;
  const versions = [position.version, controls.version, overlay.controlPoints.instanceMatrix.version];
  for (let i = 0; i < 120; i++) overlay.update({ ...rail, progress: i / 120, lookAt: [i / 120, 1, 0] });
  assert.deepEqual([position.version, controls.version, overlay.controlPoints.instanceMatrix.version], versions);
  overlay.children.forEach((child, i) => { assert.equal(child, children[i]); assert.equal(child.geometry, geometry[i]); assert.equal(child.material, materials[i]); });
  overlay.update({ ...rail, points: [[-4, 1, 2], [0, 4, 0], [3, 1, 2]] });
  assert.ok(position.version > versions[0]); assert.equal(position, overlay.path.geometry.attributes.position);
  overlay.update({ ...rail, enabled: false }); assert.equal(overlay.visible, false);
  overlay.update({ ...rail, orientation: 'tangent' }); assert.equal(overlay.target.visible, false);
  overlay.dispose();
});

test('point limits, degenerate curves and disposal are bounded and safe', () => {
  const overlay = new RailOverlay().update({ ...rail, points: Array.from({ length: 60 }, (_, i) => [i, 1, 0]) });
  assert.equal(overlay.controlPoints.count, 32);
  overlay.update({ ...rail, points: [[0, 0, 0], [0, 0, 0]] });
  assert.ok([...overlay.path.geometry.attributes.position.array].every(Number.isFinite));
  overlay.update({ ...rail, points: [[1e100, NaN, 0], [-1e100, 0, 0]] });
  assert.ok([...overlay.path.geometry.attributes.position.array].every(Number.isFinite));
  overlay.update({ ...rail, points: [] }); assert.equal(overlay.visible, false); assert.equal(overlay.path.geometry.drawRange.count, 0);
  const resources = overlay.children.flatMap(child => [child.geometry, child.material]); const counts = resources.map(() => 0);
  resources.forEach((resource, i) => resource.addEventListener('dispose', () => counts[i]++));
  const scene = new THREE.Scene(); scene.add(overlay); overlay.dispose(); overlay.dispose();
  assert.deepEqual(counts, counts.map(() => 1)); assert.equal(scene.children.length, 0); assert.equal(overlay.children.length, 0);
});
