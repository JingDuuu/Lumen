import * as THREE from './vendor/three/three.module.js';

// Original geometric expressions; no downloaded character art or textures.
export const FACE_FIELDS = [
  ['style', '立体程度', 0, 1, 0], ['eyeOpen', '睁眼', 0, 1.4, 1],
  ['eyeSlant', '眼角倾斜', -1, 1, 0], ['blinkLeft', '左眼闭合', 0, 1, 0], ['blinkRight', '右眼闭合', 0, 1, 0],
  ['gazeX', '视线左右', -1, 1, 0], ['gazeY', '视线上下', -1, 1, 0],
  ['browHeight', '眉毛高低', -1, 1, 0], ['browTilt', '眉毛倾斜', -1, 1, 0],
  ['mouthOpen', '张嘴', 0, 1, 0], ['mouthSmile', '嘴角', -1, 1, 0],
  ['mouthWidth', '嘴宽', 0.5, 1.5, 1], ['cheekRaise', '脸颊表情', 0, 1, 0],
].map(([id, label, min, max, value]) => ({ id, label, min, max, step: 0.01, default: value }));
const DEFAULT_FACE = Object.fromEntries(FACE_FIELDS.map(field => [field.id, field.default]));
const rawPresets = [
  ['neutral', '平静', {}],
  ['happy', '开心', { eyeOpen: 0.72, browHeight: 0.15, mouthSmile: 0.85, mouthOpen: 0.2, cheekRaise: 0.65 }],
  ['joy', '大笑', { eyeOpen: 0.18, browHeight: 0.3, mouthSmile: 1, mouthOpen: 0.75, mouthWidth: 1.2, cheekRaise: 1 }],
  ['angry', '生气', { eyeOpen: 0.7, eyeSlant: 0.35, browHeight: -0.55, browTilt: -0.85, mouthSmile: -0.6, mouthWidth: 0.85 }],
  ['sad', '难过', { eyeOpen: 0.65, browHeight: 0.1, browTilt: 0.75, mouthSmile: -0.8, mouthWidth: 0.8, gazeY: -0.3 }],
  ['surprise', '惊讶', { eyeOpen: 1.35, browHeight: 0.9, mouthOpen: 0.95, mouthWidth: 0.6 }],
  ['fear', '害怕', { eyeOpen: 1.25, browHeight: 0.55, browTilt: 0.6, mouthOpen: 0.45, mouthSmile: -0.4, mouthWidth: 1.15 }],
  ['skeptical', '疑惑', { eyeOpen: 0.7, browTilt: -0.35, browHeight: 0.2, mouthSmile: -0.2, gazeX: 0.6 }],
  ['sleepy', '困倦', { eyeOpen: 0.2, browHeight: -0.25, mouthOpen: 0.1, gazeY: -0.5 }],
  ['wink', '眨眼', { blinkRight: 1, eyeOpen: 0.9, mouthSmile: 0.7, cheekRaise: 0.5 }],
  ['determined', '坚定', { eyeOpen: 0.75, browHeight: -0.2, browTilt: -0.35, mouthSmile: 0.12 }],
  ['embarrassed', '害羞', { eyeOpen: 0.65, browTilt: 0.4, mouthSmile: 0.35, cheekRaise: 0.9, gazeX: -0.5, gazeY: -0.25 }],
];
export const EXPRESSION_PRESETS = rawPresets.map(([id, label, face]) => ({ id, label, face: { ...DEFAULT_FACE, ...face } }));

export function normalizeFace(face = {}, previous = DEFAULT_FACE) {
  const result = {};
  for (const field of FACE_FIELDS) {
    const value = Number(face[field.id] ?? previous[field.id] ?? field.default);
    result[field.id] = Number.isFinite(value) ? THREE.MathUtils.clamp(value, field.min, field.max) : field.default;
  }
  return result;
}

export function buildFace(c, head, width, height, depth, skin) {
  const ink = c.material('#302c36', { roughness: 0.65 }), white = c.material('#fffcf6');
  const iris = c.material('#506376', { roughness: 0.52 }), shine = c.material('#ffffff');
  const lip = c.material('#9b5f65'), mouthDark = c.material('#4d2832'), tongue = c.material('#d88995');
  const blush = c.material('#e79597', { transparent: true, opacity: 0.35, depthWrite: false });
  const group = new THREE.Group(); group.name = 'expression'; head.add(group);
  const ball = (scale, position, material) => c.mesh(group, 'sphere', scale, position, material);
  const segment = material => c.mesh(group, 'cylinder', [1, 1, 1], [0, 0, 0], material);
  const face = { width, height, depth, group, eyes: [], brows: [], cheeks: [], lips: [], style: 0 };
  for (const sign of [-1, 1]) {
    const eye = {
      sign, white: ball([1, 1, 1], [0, 0, 0], white), iris: ball([1, 1, 1], [0, 0, 0], iris),
      pupil: ball([1, 1, 1], [0, 0, 0], ink), shine: ball([1, 1, 1], [0, 0, 0], shine),
      lid: Array.from({ length: 6 }, () => segment(ink)),
    };
    face.eyes.push(eye);
    face.brows.push({ sign, pieces: Array.from({ length: 3 }, () => segment(ink)) });
    face.cheeks.push({ sign, mesh: ball([1, 1, 1], [0, 0, 0], blush) });
  }
  face.nose = ball([width * 0.045, height * 0.055, depth * 0.055], [0, height * 0.47, depth * 0.48], skin);
  face.opening = ball([1, 1, 1], [0, 0, 0], mouthDark);
  face.tongue = ball([1, 1, 1], [0, 0, 0], tongue);
  face.lips = Array.from({ length: 12 }, () => segment(lip));
  group.traverse(object => { if (object.isMesh) { object.castShadow = false; object.userData.facePart = true; } });
  return face;
}

const vertical = new THREE.Vector3(0, 1, 0);
const start = new THREE.Vector3(), end = new THREE.Vector3(), direction = new THREE.Vector3();
function line(mesh, ax, ay, az, bx, by, bz, radius) {
  start.set(ax, ay, az); end.set(bx, by, bz); direction.copy(end).sub(start);
  mesh.position.copy(start).add(end).multiplyScalar(0.5);
  mesh.scale.set(radius, Math.max(1e-7, direction.length()), radius);
  mesh.quaternion.setFromUnitVectors(vertical, direction.normalize());
}

export function updateFace(rig, values) {
  const f = rig.faceRig, p = normalizeFace(values, rig.face), W = f.width, H = f.height, D = f.depth;
  // The surface follows the head's ellipsoid. Flat marks remain attached at oblique views.
  const zAt = (x, y, offset = 0) => D * 0.5 * Math.sqrt(Math.max(0.05, 1 - (x / (W * 0.5)) ** 2 - ((y - H * 0.5) / (H * 0.5)) ** 2)) + D * 0.018 + offset;
  for (const eye of f.eyes) {
    const x = eye.sign * W * 0.22, y = H * 0.605, blink = eye.sign > 0 ? p.blinkLeft : p.blinkRight;
    const open = Math.max(0.025, p.eyeOpen * (1 - blink)), halfW = W * 0.125, halfH = H * 0.075 * open;
    const flatDepth = D * (0.013 + p.style * 0.075), z = Math.max(zAt(x, y), D * 0.51) + flatDepth * 0.25;
    for (const mesh of [eye.white, eye.iris, eye.pupil, eye.shine]) mesh.rotation.z = eye.sign * p.eyeSlant * 0.24;
    eye.white.position.set(x, y, z); eye.white.scale.set(halfW, halfH, flatDepth);
    const gx = p.gazeX * halfW * 0.35, gy = p.gazeY * halfH * 0.38;
    eye.iris.position.set(x + gx, y + gy, z + flatDepth * 0.93); eye.iris.scale.set(halfW * 0.57, halfH * 0.83, D * 0.008);
    eye.pupil.position.set(x + gx, y + gy, z + flatDepth + D * 0.007); eye.pupil.scale.set(halfW * 0.29, halfH * 0.63, D * 0.006);
    eye.shine.position.set(x + gx - halfW * 0.19, y + gy + halfH * 0.35, z + flatDepth + D * 0.014); eye.shine.scale.set(halfW * 0.13, halfH * 0.17, D * 0.006);
    for (let i = 0; i < eye.lid.length; i++) {
      const a = -1 + 2 * i / eye.lid.length, b = -1 + 2 * (i + 1) / eye.lid.length;
      const yy = t => y + Math.sqrt(Math.max(0, 1 - t * t)) * halfH + eye.sign * t * p.eyeSlant * H * 0.02;
      line(eye.lid[i], x + a * halfW, yy(a), z + flatDepth, x + b * halfW, yy(b), z + flatDepth, H * 0.006);
    }
  }
  for (const brow of f.brows) {
    const cx = brow.sign * W * 0.22, cy = H * (0.745 + p.browHeight * 0.06);
    for (let i = 0; i < brow.pieces.length; i++) {
      const a = -1 + 2 * i / brow.pieces.length, b = -1 + 2 * (i + 1) / brow.pieces.length;
      const point = t => { const x = cx + t * W * 0.13, y = cy - brow.sign * t * p.browTilt * H * 0.045 + (1 - t * t) * H * 0.012; return [x, y, zAt(x, y, D * 0.012)]; };
      line(brow.pieces[i], ...point(a), ...point(b), H * 0.009);
    }
  }
  f.nose.scale.set(W * (0.018 + p.style * 0.035), H * (0.024 + p.style * 0.035), D * (0.008 + p.style * 0.062));
  f.nose.position.set(0, H * 0.465, zAt(0, H * 0.465));
  const mouthY = H * 0.29, mouthW = W * 0.17 * p.mouthWidth, opening = H * 0.075 * p.mouthOpen;
  const openingWidth = Math.max(0.000001, mouthW * Math.min(1, p.mouthOpen * 20));
  f.opening.position.set(0, mouthY - opening * 0.25, zAt(0, mouthY, D * 0.01)); f.opening.scale.set(openingWidth, Math.max(H * 0.00001, opening), D * (0.012 + p.style * 0.025));
  f.tongue.position.set(0, mouthY - opening * 0.7, f.opening.position.z + D * (0.018 + p.style * 0.025)); f.tongue.scale.set(openingWidth * 0.6, Math.max(H * 0.00001, opening * 0.23), D * 0.006);
  for (let i = 0; i < f.lips.length; i++) {
    const a = -1 + 2 * i / f.lips.length, b = -1 + 2 * (i + 1) / f.lips.length;
    const point = t => {
      const x = t * mouthW, closed = mouthY + p.mouthSmile * H * 0.055 * (t * t - 0.45);
      const lowerLip = mouthY - opening * 0.25 - opening * Math.sqrt(Math.max(0, 1 - t * t));
      const y = THREE.MathUtils.lerp(closed, lowerLip, Math.min(1, p.mouthOpen * 8));
      return [x, y, zAt(x, y, D * 0.025)];
    };
    line(f.lips[i], ...point(a), ...point(b), H * (0.005 + p.style * 0.003));
  }
  for (const cheek of f.cheeks) {
    const x = cheek.sign * W * 0.30, y = H * (0.40 + p.cheekRaise * 0.015);
    cheek.mesh.position.set(x, y, zAt(x, y, D * 0.012)); cheek.mesh.scale.set(W * 0.1 * Math.max(0.001, p.cheekRaise), H * 0.032 * Math.max(0.001, p.cheekRaise), D * 0.009);
  }
  rig.face = p;
  return { ...p };
}
