import * as THREE from './vendor/three/three.module.js';
import { buildFace, updateFace, normalizeFace, FACE_FIELDS, EXPRESSION_PRESETS } from './layout-face.js';
import { EXTRA_POSES, extraPose } from './layout-poses.js';
export { FACE_FIELDS, EXPRESSION_PRESETS };
export { HDR_PRESETS, CHARACTER_REFERENCE_GUIDE } from './layout-environments.js';

// Local blocking models. These deliberately communicate proportion, pose and space,
// rather than representing a finished character or production asset.
export const ASSETS = [
  ['adult_male', '成年男性', 'people', '标准成年比例，可编辑骨架与双手'],
  ['adult_female', '成年女性', 'people', '较窄肩、较宽髋的成年比例'],
  ['child_boy', '儿童男孩', 'people', '较大头身比、较短四肢'],
  ['child_girl', '儿童女孩', 'people', '儿童比例与双侧发束'],
  ['slim_adult', '纤细成人', 'people', '较细躯干与四肢'],
  ['strong_adult', '健壮成人', 'people', '宽肩与较厚躯干'],
  ['chair', '餐椅', 'furniture', '有靠背的木质座椅'],
  ['armchair', '扶手椅', 'furniture', '软包座面、靠背与双扶手'],
  ['office_chair', '办公椅', 'furniture', '转椅、升降柱与五脚底座'],
  ['stool', '圆凳', 'furniture', '无靠背圆形座面'],
  ['table', '方桌', 'furniture', '四脚方形桌'],
  ['dining_table', '长餐桌', 'furniture', '可围坐的长形餐桌'],
  ['desk', '书桌', 'furniture', '带侧柜与抽屉的办公桌'],
  ['coffee_table', '茶几', 'furniture', '低矮桌面与下层置物板'],
  ['bench', '长椅', 'furniture', '双人坐凳'],
  ['long_bench', '公园长椅', 'furniture', '有靠背、扶手与板条的三人长椅'],
  ['sofa', '三人沙发', 'furniture', '三块坐垫、靠垫与扶手'],
  ['bed', '单人床', 'furniture', '床架、床头、床垫、枕头与薄被'],
  ['double_bed', '双人床', 'furniture', '双枕与宽床面'],
  ['bunk_bed', '上下铺', 'furniture', '双层床、护栏与梯子'],
  ['cabinet', '矮柜', 'furniture', '双门储物柜'],
  ['wardrobe', '衣柜', 'furniture', '高立柜与双门把手'],
  ['bookshelf', '书架', 'furniture', '开放隔板与书本'],
  ['dresser', '抽屉柜', 'furniture', '四层抽屉与拉手'],
  ['counter', '柜台', 'furniture', '较高台面与内侧脚踏'],
  ['room', '开敞房间', 'architecture', '去除正面墙的房间构图框架'],
  ['wall', '墙体', 'architecture', '带踢脚线的实墙'],
  ['doorway', '门洞', 'architecture', '侧柱与门楣'],
  ['door', '半开门', 'architecture', '带门框、门板与把手'],
  ['window', '窗户', 'architecture', '窗框、窗台与半透明玻璃'],
  ['stairs', '台阶', 'architecture', '六级楼梯与两侧扶手'],
  ['box', '方箱', 'props', '一米方形占位体'],
  ['crate', '木箱', 'props', '箱板、边框与斜撑'],
  ['cylinder', '圆柱', 'primitives', '一米高的圆柱占位体'],
  ['sphere', '球体', 'primitives', '一米直径球体'],
  ['plane', '地台', 'primitives', '三米见方薄地台'],
  ['tree', '树木', 'outdoor', '树干、树枝与圆冠'],
  ['streetlamp', '路灯', 'outdoor', '灯柱、悬臂与灯罩'],
  ['car', '小汽车', 'outdoor', '车身、车窗与四轮'],
  ['bicycle', '自行车', 'outdoor', '双轮、三角车架、车把与座垫'],
].map(([id, label, category, description]) => ({ id, label, category, description }));

export const BODY_FIELDS = [
  { id: 'height', label: '身高（米）', min: 0.75, max: 2.3, step: 0.01, default: 1.75 },
  { id: 'build', label: '体格', min: 0.65, max: 1.6, step: 0.01, default: 1 },
  { id: 'shoulderWidth', label: '肩宽比例', min: 0.7, max: 1.4, step: 0.01, default: 1 },
  { id: 'hipWidth', label: '髋宽比例', min: 0.7, max: 1.4, step: 0.01, default: 1 },
  { id: 'headScale', label: '头部比例', min: 0.75, max: 1.35, step: 0.01, default: 1 },
];
export const POSES = [
  ['standing', '自然站立'], ['a_pose', 'A 字站姿'], ['t_pose', 'T 字站姿'],
  ['sitting', '端坐'], ['relaxed_sit', '放松坐姿'], ['walking', '迈步'], ['running', '跑步'],
  ['kneeling', '双膝跪地'], ['one_knee', '单膝跪地'], ['crouching', '下蹲'],
  ['hands_up', '双手举起'], ['wave', '单手招呼'], ['pointing', '伸手指向'],
  ['reaching', '双手前伸'], ['arms_crossed', '交叉抱臂'], ['looking_up', '仰头观察'],
].map(([id, label]) => ({ id, label,
  category: ['standing', 'a_pose', 't_pose', 'looking_up'].includes(id) ? 'standing' : ['sitting', 'relaxed_sit'].includes(id) ? 'seated' : ['walking', 'running'].includes(id) ? 'locomotion' : ['kneeling', 'one_knee', 'crouching'].includes(id) ? 'floor' : 'gesture',
  tags: [label], description: label + '构图姿态，可继续调整关节与身体比例。',
})).concat(EXTRA_POSES);
export const HAND_POSES = [
  ['relaxed', '放松'], ['fist', '握拳'], ['open', '张开'], ['point', '指向'],
  ['peace', 'V 字'], ['grip', '抓握'], ['pinch', '捏取'], ['thumbs_up', '竖拇指'],
].map(([id, label]) => ({ id, label }));

const jointDefs = [
  ['pelvis', '骨盆', -90, 90], ['spine', '腰部', -80, 80], ['chest', '胸部', -75, 75],
  ['neck', '颈部', -70, 70], ['head', '头部', -85, 85],
];
for (const [side, sideLabel] of [['left', '左'], ['right', '右']]) {
  for (const [part, label, min, max] of [
    ['Shoulder', '肩', -180, 180], ['Elbow', '肘', -175, 175], ['Wrist', '腕', -150, 150],
    ['Hip', '髋', -150, 150], ['Knee', '膝', -175, 175], ['Ankle', '踝', -100, 100],
  ]) jointDefs.push([side + part, sideLabel + label, min, max]);
  for (const [finger, label] of [['Thumb', '拇指'], ['Index', '食指'], ['Middle', '中指'], ['Ring', '无名指'], ['Pinky', '小指']])
    for (let n = 1; n <= 3; n++) jointDefs.push([`${side}${finger}${n}`, `${sideLabel}${label}·${n}`, -120, 120]);
}
export const JOINTS = jointDefs.map(([id, label, min, max]) => ({ id, label, min, max, step: 1 }));

const PROFILES = {
  adult_male: { height: 1.78, shoulder: 0.26, hip: 0.21, build: 1, shirt: '#778fa4', skin: '#c9a48a' },
  adult_female: { height: 1.68, shoulder: 0.235, hip: 0.235, build: 0.88, shirt: '#ac827e', skin: '#d1ae96', hair: 'long' },
  child_boy: { height: 1.15, shoulder: 0.25, hip: 0.225, build: 0.86, shirt: '#78a9a1', skin: '#d5b399', child: true },
  child_girl: { height: 1.12, shoulder: 0.245, hip: 0.23, build: 0.84, shirt: '#b59ac0', skin: '#d5b399', child: true, hair: 'puffs' },
  slim_adult: { height: 1.8, shoulder: 0.245, hip: 0.20, build: 0.72, shirt: '#95a58d', skin: '#c8a287' },
  strong_adult: { height: 1.82, shoulder: 0.31, hip: 0.235, build: 1.3, shirt: '#b49b6c', skin: '#bf987f' },
};
const DOWN = new THREE.Vector3(0, -1, 0);
const RAD = Math.PI / 180;
const FINGERS = ['Thumb', 'Index', 'Middle', 'Ring', 'Pinky'];
const round = value => Math.round(value * 1000) / 1000;
const clone = value => JSON.parse(JSON.stringify(value));
const finite = (value, fallback) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const vec = value => new THREE.Vector3(...value);

function context(root, color) {
  const geometries = new Map(), materials = new Map();
  function geometry(key, create) {
    if (!geometries.has(key)) geometries.set(key, create());
    return geometries.get(key);
  }
  function material(value = color || '#a5aaa6', options = {}) {
    const key = value + JSON.stringify(options);
    if (!materials.has(key)) materials.set(key, new THREE.MeshStandardMaterial({ color: value, roughness: 0.78, ...options }));
    return materials.get(key);
  }
  function mesh(parent, shape, dimensions, position, mat = material(), rotation = null) {
    const g = shape === 'sphere'
      ? geometry('sphere', () => new THREE.SphereGeometry(1, 18, 12))
      : shape === 'cylinder'
        ? geometry('cylinder', () => new THREE.CylinderGeometry(1, 1, 1, 16))
        : shape === 'cone'
          ? geometry('cone', () => new THREE.ConeGeometry(1, 1, 16))
          : geometry('box', () => new THREE.BoxGeometry(1, 1, 1));
    const m = new THREE.Mesh(g, mat);
    m.position.fromArray(position); m.scale.fromArray(dimensions);
    if (rotation) m.rotation.set(...rotation);
    m.castShadow = true; m.receiveShadow = true;
    parent.add(m);
    return m;
  }
  function rod(parent, start, end, radius, mat) {
    const a = vec(start), b = vec(end), d = b.clone().sub(a);
    const m = mesh(parent, 'cylinder', [radius, d.length(), radius], a.clone().add(b).multiplyScalar(0.5).toArray(), mat);
    m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.normalize());
    return m;
  }
  function ring(parent, radius, tube, position, mat, rotation = [0, 0, 0]) {
    const key = `torus:${radius}:${tube}`;
    const m = new THREE.Mesh(geometry(key, () => new THREE.TorusGeometry(radius, tube, 8, 28)), mat);
    m.position.fromArray(position); m.rotation.set(...rotation); m.castShadow = true; m.receiveShadow = true; parent.add(m);
    return m;
  }
  return { root, geometry, material, mesh, rod, ring };
}

function bodyValues(type, supplied = {}) {
  const profile = PROFILES[type], result = {};
  for (const field of BODY_FIELDS) {
    const fallback = field.id === 'height' ? profile.height : field.id === 'build' ? profile.build : field.default;
    result[field.id] = round(THREE.MathUtils.clamp(finite(supplied[field.id], fallback), field.min, field.max));
  }
  return result;
}

function joint(rig, id, parent, position, rest = [0, 0, 0]) {
  const node = new THREE.Group(); node.name = id; node.position.fromArray(position);
  const restQuaternion = new THREE.Quaternion().setFromEuler(new THREE.Euler(...rest));
  node.quaternion.copy(restQuaternion); parent.add(node);
  rig.joints[id] = { node, restQuaternion, restPosition: node.position.clone() };
  return node;
}

function buildHuman(root, type, body, color) {
  const profile = PROFILES[type], c = context(root, color || profile.shirt), H = body.height;
  const skin = c.material(profile.skin), shirt = c.material(color || profile.shirt), pants = c.material('#48515b');
  const shoe = c.material('#343941'), hair = c.material('#40332e');
  shirt.userData.layoutTint = true;
  const hipWidth = H * profile.hip * body.hipWidth, shoulderWidth = H * profile.shoulder * body.shoulderWidth;
  const upperLeg = H * (profile.child ? 0.21 : 0.255), lowerLeg = H * (profile.child ? 0.20 : 0.23), ankleHeight = H * 0.05;
  const hipY = upperLeg + lowerLeg + ankleHeight, torso = H * (profile.child ? 0.285 : 0.295);
  const upperArm = H * 0.165, lowerArm = H * 0.145, handLength = H * 0.105;
  const rig = { joints: {}, chains: {}, handles: {}, pose: {}, hands: { left: 'relaxed', right: 'relaxed' }, body: clone(body), type, color: color || profile.shirt, context: c };
  root.userData.rig = rig; root.userData.body = clone(body);
  const pelvis = joint(rig, 'pelvis', root, [0, hipY, 0]);
  const spine = joint(rig, 'spine', pelvis, [0, H * 0.05, 0]);
  const chest = joint(rig, 'chest', spine, [0, torso - H * 0.05, 0]);
  const neck = joint(rig, 'neck', chest, [0, H * 0.035, 0]);
  const head = joint(rig, 'head', neck, [0, 0, 0]);
  c.mesh(pelvis, 'sphere', [hipWidth * 0.55, H * 0.072, H * 0.065 * body.build], [0, -H * 0.015, 0], pants);
  c.mesh(spine, 'sphere', [shoulderWidth * 0.39 * Math.sqrt(body.build), torso * 0.48, H * 0.073 * body.build], [0, torso * 0.34, 0], shirt);
  c.mesh(chest, 'sphere', [shoulderWidth * 0.49, H * 0.085, H * 0.078 * body.build], [0, -H * 0.035, 0], shirt);
  c.mesh(neck, 'cylinder', [H * 0.025, H * 0.05, H * 0.025], [0, -H * 0.018, 0], skin);
  const headH = H * (profile.child ? 0.22 : 0.135) * body.headScale;
  const headW = headH * 0.69, headD = headH * 0.65;
  const skull = new THREE.Mesh(c.geometry('head', () => new THREE.SphereGeometry(1, 32, 24)), skin);
  skull.scale.set(headW / 2, headH / 2, headD / 2); skull.position.y = headH / 2; skull.castShadow = true; head.add(skull);
  for (const s of [-1, 1]) {
    c.mesh(head, 'sphere', [headW * 0.085, headH * 0.12, headD * 0.09], [s * headW * 0.48, headH * 0.50, 0], skin);
  }
  rig.faceRig = buildFace(c, head, headW, headH, headD, skin);
  rig.face = normalizeFace(); updateFace(rig, rig.face);
  const scalp = new THREE.Mesh(c.geometry('scalp', () => new THREE.SphereGeometry(1, 24, 16, 0, Math.PI * 2, 0, Math.PI * 0.32)), hair);
  scalp.scale.set(headW * 0.515, headH * 0.52, headD * 0.52); scalp.position.y = headH * 0.5; scalp.castShadow = true; head.add(scalp);
  if (profile.hair === 'long')
    c.mesh(head, 'sphere', [headW * 0.47, headH * 0.48, headD * 0.20], [0, headH * 0.40, -headD * 0.35], hair);
  if (profile.hair === 'puffs')
    for (const s of [-1, 1]) c.mesh(head, 'sphere', [headW * 0.22, headH * 0.17, headD * 0.23], [s * headW * 0.55, headH * 0.65, -headD * 0.15], hair);

  function limb(parent, length, radius, mat) {
    c.mesh(parent, 'sphere', [radius, radius, radius], [0, 0, 0], mat);
    c.mesh(parent, 'sphere', [radius * 0.94, length * 0.56, radius * 0.92], [0, -length * 0.48, 0], mat);
  }
  for (const [side, sign] of [['left', 1], ['right', -1]]) {
    const shoulder = joint(rig, side + 'Shoulder', chest, [sign * shoulderWidth * 0.5, -H * 0.012, 0]);
    const elbow = joint(rig, side + 'Elbow', shoulder, [0, -upperArm, 0]);
    const wrist = joint(rig, side + 'Wrist', elbow, [0, -lowerArm, 0]);
    limb(shoulder, upperArm, H * 0.031 * body.build, skin);
    c.mesh(shoulder, 'sphere', [H * 0.042 * body.build, upperArm * 0.26, H * 0.038 * body.build], [0, -upperArm * 0.15, 0], shirt);
    limb(elbow, lowerArm, H * 0.025 * body.build, skin);
    c.mesh(wrist, 'sphere', [H * 0.018 * body.build, H * 0.018 * body.build, H * 0.018 * body.build], [0, 0, 0], skin);
    buildHand(rig, c, side, sign, wrist, handLength, skin);
    const hip = joint(rig, side + 'Hip', pelvis, [sign * hipWidth * 0.28, -H * 0.005, 0]);
    const knee = joint(rig, side + 'Knee', hip, [0, -upperLeg, 0]);
    const ankle = joint(rig, side + 'Ankle', knee, [0, -lowerLeg, 0]);
    limb(hip, upperLeg, H * 0.047 * body.build, pants);
    limb(knee, lowerLeg, H * 0.034 * body.build, pants);
    c.mesh(ankle, 'sphere', [H * 0.035, H * 0.027, H * 0.073], [0, -H * 0.020, H * 0.028], shoe);
    c.mesh(ankle, 'box', [H * 0.069, H * 0.015, H * 0.13], [0, -H * 0.041, H * 0.028], c.material('#24282b'));
    rig.chains[side + 'Hand'] = { upper: shoulder, lower: elbow, end: wrist, lengths: [upperArm, lowerArm], poleDefault: [sign * shoulderWidth * 1.1, hipY + torso - upperArm * 0.7, H * 0.32] };
    rig.chains[side + 'Foot'] = { upper: hip, lower: knee, end: ankle, lengths: [upperLeg, lowerLeg], poleDefault: [sign * hipWidth * 0.4, hipY - upperLeg * 0.8, H * 0.55] };
  }
  for (const [id, chain] of Object.entries(rig.chains)) {
    const target = new THREE.Object3D(), pole = new THREE.Object3D();
    target.name = id + 'Target'; pole.name = id + 'Pole';
    target.userData.editorOnly = pole.userData.editorOnly = true;
    pole.position.fromArray(chain.poleDefault);
    root.add(target, pole); rig.handles[id] = target; rig.handles[id + 'Pole'] = pole;
  }
  return rig;
}

function buildHand(rig, c, side, sign, wrist, length, skin) {
  const palmL = length * 0.48, palmW = length * 0.48, palmD = length * 0.19;
  c.mesh(wrist, 'sphere', [palmW * 0.5, palmL * 0.58, palmD * 0.5], [0, -palmL * 0.42, 0], skin);
  const fingerLengths = [0.37, 0.51, 0.56, 0.52, 0.41];
  FINGERS.forEach((finger, i) => {
    const thumb = i === 0, total = length * fingerLengths[i];
    const x = thumb ? -sign * palmW * 0.43 : sign * palmW * (-0.31 + (i - 1) * 0.205);
    const base = [x, thumb ? -palmL * 0.29 : -palmL * 0.87, thumb ? palmD * 0.12 : 0];
    const pieces = [total * 0.43, total * 0.33, total * 0.24];
    let parent = wrist;
    for (let n = 0; n < 3; n++) {
      const bone = joint(rig, `${side}${finger}${n + 1}`, parent, n ? [0, -pieces[n - 1], 0] : base,
        thumb && n === 0 ? [0, 0, -sign * 48 * RAD] : [0, 0, 0]);
      const radius = length * (thumb ? 0.066 : 0.052) * (1 - n * 0.13);
      c.mesh(bone, 'sphere', [radius, radius, radius], [0, 0, 0], skin);
      c.mesh(bone, 'cylinder', [radius * 0.92, pieces[n], radius * 0.92], [0, -pieces[n] / 2, 0], skin);
      c.mesh(bone, 'sphere', [radius * 0.92, radius * 0.92, radius * 0.92], [0, -pieces[n], 0], skin);
      parent = bone;
    }
  });
}

function standingPose() {
  return { leftShoulder: [0, 0, 7], rightShoulder: [0, 0, -7], leftElbow: [-7, 0, 0], rightElbow: [-7, 0, 0] };
}
function poseDefinition(id) {
  const p = standingPose();
  const additional = extraPose(id);
  if (additional) return { ...p, ...additional };
  const pair = (part, left, right = left) => { p['left' + part] = left; p['right' + part] = right; };
  if (id === 'a_pose') pair('Shoulder', [0, 0, 38], [0, 0, -38]);
  if (id === 't_pose') { pair('Shoulder', [0, 0, 90], [0, 0, -90]); pair('Elbow', [0, 0, 0]); }
  if (id === 'sitting' || id === 'relaxed_sit') {
    pair('Hip', [-90, 0, 0]); pair('Knee', [90, 0, 0]); pair('Shoulder', [-20, 0, 5], [-20, 0, -5]); pair('Elbow', [-70, 0, 0]);
    if (id === 'relaxed_sit') { p.spine = [12, 0, 0]; pair('Hip', [-100, 0, -7], [-100, 0, 7]); pair('Knee', [80, 0, 0]); pair('Elbow', [-30, 0, 0]); }
  }
  if (id === 'walking' || id === 'running') {
    const run = id === 'running';
    p.spine = [run ? -14 : -3, 0, 0]; pair('Hip', [run ? -60 : -27, 0, 0], [run ? 35 : 22, 0, 0]);
    pair('Knee', [run ? 85 : 12, 0, 0], [run ? 105 : 25, 0, 0]);
    pair('Shoulder', [run ? 36 : 23, 0, 5], [run ? -48 : -23, 0, -5]); pair('Elbow', [run ? -100 : -25, 0, 0]);
  }
  if (id === 'kneeling') { pair('Hip', [-10, 0, 0]); pair('Knee', [110, 0, 0]); pair('Ankle', [-35, 0, 0]); }
  if (id === 'one_knee') { pair('Hip', [-85, 0, 0], [15, 0, 0]); pair('Knee', [90, 0, 0], [110, 0, 0]); p.rightAnkle = [-35, 0, 0]; }
  if (id === 'crouching') { pair('Hip', [-95, 0, -6], [-95, 0, 6]); pair('Knee', [135, 0, 0]); pair('Ankle', [-35, 0, 0]); p.spine = [-25, 0, 0]; pair('Shoulder', [-50, 0, 8], [-50, 0, -8]); }
  if (id === 'hands_up') { pair('Shoulder', [-165, 0, 14], [-165, 0, -14]); pair('Elbow', [-12, 0, 0]); }
  if (id === 'wave') { p.rightShoulder = [-155, 0, -25]; p.rightElbow = [-40, 0, 0]; p.rightWrist = [0, 0, -15]; }
  if (id === 'pointing') { p.rightShoulder = [-90, 0, -8]; p.rightElbow = [-5, 0, 0]; }
  if (id === 'reaching') { pair('Shoulder', [-80, 0, 8], [-80, 0, -8]); pair('Elbow', [-15, 0, 0]); }
  if (id === 'arms_crossed') { pair('Shoulder', [-35, -25, -25], [-35, 25, 25]); pair('Elbow', [-100, 0, -35], [-100, 0, 35]); }
  if (id === 'looking_up') { p.neck = [-25, 0, 0]; p.head = [-20, 0, 0]; }
  return p;
}

function handDefinition(side, id) {
  const curls = {
    relaxed: [[15, 20, 10], [14, 20, 12], [19, 26, 16], [24, 31, 18], [30, 35, 22]],
    fist: [[42, 55, 38], [76, 98, 74], [80, 100, 75], [82, 102, 75], [85, 100, 75]],
    open: [[0, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0]],
    point: [[35, 50, 30], [0, 0, 0], [80, 95, 70], [82, 100, 74], [85, 100, 75]],
    peace: [[35, 50, 30], [0, 0, 0], [0, 0, 0], [80, 95, 72], [85, 100, 75]],
    grip: [[30, 35, 28], [45, 65, 42], [48, 70, 45], [50, 72, 48], [55, 75, 50]],
    pinch: [[30, 45, 25], [45, 80, 45], [25, 35, 20], [30, 40, 22], [35, 45, 25]],
    thumbs_up: [[0, 0, 0], [80, 100, 75], [80, 100, 75], [80, 100, 75], [85, 100, 75]],
  }[id] || null;
  if (!curls) throw new Error('Unknown hand preset: ' + id);
  const pose = {}, sign = side === 'left' ? 1 : -1;
  FINGERS.forEach((finger, i) => {
    for (let n = 0; n < 3; n++) {
      let spread = 0;
      if (n === 0 && i > 0) spread = (i - 2.5) * (id === 'open' ? 10 : id === 'peace' && i < 3 ? 12 : 2.5) * sign;
      pose[`${side}${finger}${n + 1}`] = [-curls[i][n], i === 0 && n === 0 && ['fist', 'pinch', 'grip'].includes(id) ? sign * 35 : 0, spread];
    }
  });
  return pose;
}

function setJointPose(rig, values) {
  const pelvis = rig.joints.pelvis;
  const translation = values.pelvisTranslation || [0, 0, 0];
  pelvis.node.position.copy(pelvis.restPosition).add(new THREE.Vector3(...[0, 1, 2].map(i => THREE.MathUtils.clamp(finite(translation[i], 0), -4, 4))));
  for (const [id, jointInfo] of Object.entries(rig.joints)) {
    const angles = values[id] || [0, 0, 0];
    const euler = new THREE.Euler(...[0, 1, 2].map(i => THREE.MathUtils.clamp(finite(angles[i], 0), -180, 180) * RAD), 'XYZ');
    jointInfo.node.quaternion.copy(jointInfo.restQuaternion).multiply(new THREE.Quaternion().setFromEuler(euler));
  }
}

function syncTargets(root) {
  const rig = root.userData.rig;
  root.updateWorldMatrix(true, true);
  for (const [id, chain] of Object.entries(rig.chains))
    rig.handles[id].position.copy(root.worldToLocal(chain.end.getWorldPosition(new THREE.Vector3())));
  root.updateWorldMatrix(true, true);
}
function currentPose(rig) {
  const pose = { pelvisTranslation: rig.joints.pelvis.node.position.clone().sub(rig.joints.pelvis.restPosition).toArray().map(value => Math.round(value * 1e6) / 1e6) };
  for (const [id, entry] of Object.entries(rig.joints)) {
    const relative = entry.restQuaternion.clone().invert().multiply(entry.node.quaternion);
    const e = new THREE.Euler().setFromQuaternion(relative, 'XYZ');
    pose[id] = [e.x, e.y, e.z].map(value => round(value / RAD));
  }
  return pose;
}

export function applyRig(root, record = {}) {
  if (!PROFILES[root.userData.assetType]) { applyMaterial(root, record.material || (record.color ? { color: record.color } : {})); return root; }
  const type = root.userData.assetType, body = bodyValues(type, record.body || root.userData.body);
  const color = record.material?.color || record.color || root.userData.rig?.color || PROFILES[type].shirt;
  const face = record.face || root.userData.rig?.face;
  const material = { ...(root.userData.material || {}), ...(record.material || {}), color };
  if (!root.userData.rig || JSON.stringify(body) !== JSON.stringify(root.userData.rig.body)) {
    disposeChildren(root); buildHuman(root, type, body, color);
    nameParts(root);
  }
  const rig = root.userData.rig;
  rig.hands = { left: record.hands?.left || 'relaxed', right: record.hands?.right || 'relaxed' };
  const values = { ...standingPose(), ...handDefinition('left', rig.hands.left), ...handDefinition('right', rig.hands.right), ...(record.pose || {}) };
  setJointPose(rig, values);
  if (record.ik)
    for (const [id, point] of Object.entries(record.ik))
      if (id.endsWith('Pole') && rig.handles[id] && Array.isArray(point) && point.length === 3 && point.every(Number.isFinite)) rig.handles[id].position.fromArray(point);
  rig.pose = currentPose(rig); syncTargets(root);
  applyFace(root, face); applyMaterial(root, material);
  return root;
}

export function applyFace(root, face = {}) {
  const rig = root.userData.rig;
  return rig ? updateFace(rig, face) : {};
}

export function applyExpression(root, id) {
  const preset = EXPRESSION_PRESETS.find(value => value.id === id);
  if (!preset) throw new Error('Unknown facial expression: ' + id);
  return applyFace(root, { ...preset.face, style: root.userData.rig?.face?.style ?? preset.face.style });
}

export function applyMaterial(root, values = {}) {
  const previous = root.userData.material || {}, color = values.color || previous.color || root.userData.rig?.color || '#a6aaa1';
  const result = { color: /^#[\da-f]{6}$/i.test(color) ? color : '#a6aaa1' };
  for (const [key, fallback] of [['roughness', 0.78], ['metalness', 0], ['opacity', 1]])
    result[key] = THREE.MathUtils.clamp(finite(values[key] ?? previous[key], fallback), 0, 1);
  const materials = new Set();
  root.traverse(object => {
    for (const material of Array.isArray(object.material) ? object.material : object.material ? [object.material] : []) materials.add(material);
  });
  for (const material of materials) {
    material.userData.baseOpacity ??= material.opacity;
    material.userData.baseTransparent ??= material.transparent;
    if (material.userData.layoutTint || !root.userData.assetType) material.color?.set(result.color);
    if ('roughness' in material) material.roughness = result.roughness;
    if ('metalness' in material) material.metalness = result.metalness;
    material.opacity = material.userData.baseOpacity * result.opacity;
    const transparent = material.userData.baseTransparent || material.opacity < 0.999;
    if (material.transparent !== transparent) { material.transparent = transparent; material.needsUpdate = true; }
  }
  root.userData.material = result;
  if (root.userData.rig) root.userData.rig.color = result.color;
  return { ...result };
}

export function applyPose(root, poseId) {
  const rig = root.userData.rig;
  if (!rig) return {};
  if (!POSES.some(pose => pose.id === poseId)) throw new Error('Unknown body pose: ' + poseId);
  const current = currentPose(rig), fingers = {};
  for (const [id, value] of Object.entries(current)) if (/^(left|right)(Thumb|Index|Middle|Ring|Pinky)/.test(id)) fingers[id] = value;
  applyRig(root, { body: rig.body, color: rig.color, hands: rig.hands, pose: { ...poseDefinition(poseId), ...fingers } });
  // Keep the lowest body surface on the person's ground plane. This is computed
  // in root-local space, so presets also work after rotating/scaling the person.
  const now = root.userData.rig;
  root.updateWorldMatrix(true, true);
  const inverse = root.matrixWorld.clone().invert(), bounds = new THREE.Box3();
  root.traverse(object => {
    if (!object.isMesh) return;
    if (!object.geometry.boundingBox) object.geometry.computeBoundingBox();
    bounds.union(object.geometry.boundingBox.clone().applyMatrix4(new THREE.Matrix4().multiplyMatrices(inverse, object.matrixWorld)));
  });
  if (Number.isFinite(bounds.min.y)) now.joints.pelvis.node.position.y -= bounds.min.y;
  syncTargets(root);
  now.pose = currentPose(now);
  return clone(now.pose);
}

export function applyHand(root, side, handId) {
  const rig = root.userData.rig;
  if (!rig) return { left: 'relaxed', right: 'relaxed' };
  if (!['left', 'right'].includes(side)) throw new Error('Hand side must be left or right');
  handDefinition(side, handId);
  const pose = currentPose(rig);
  for (const id of Object.keys(pose)) if (id.startsWith(side) && /(?:Thumb|Index|Middle|Ring|Pinky)/.test(id)) delete pose[id];
  applyRig(root, { body: rig.body, color: rig.color, hands: { ...rig.hands, [side]: handId }, pose });
  return clone(root.userData.rig.hands);
}

export function getIKTargets(root) {
  const rig = root.userData.rig;
  if (!rig) return [];
  const labels = { leftHand: '左手目标', rightHand: '右手目标', leftFoot: '左脚目标', rightFoot: '右脚目标' };
  return Object.keys(rig.chains).flatMap(id => [
    { id, label: labels[id], kind: 'target', chain: id, object: rig.handles[id] },
    { id: id + 'Pole', label: labels[id].replace('目标', id.endsWith('Hand') ? '肘朝向' : '膝朝向'), kind: 'pole', chain: id, object: rig.handles[id + 'Pole'] },
  ]);
}

export function solveIK(root, id, worldPosition) {
  const rig = root.userData.rig;
  if (!rig) return {};
  const poleEdit = id.endsWith('Pole'), chainId = poleEdit ? id.slice(0, -4) : id, chain = rig.chains[chainId];
  if (!chain) throw new Error('Unknown IK handle: ' + id);
  const point = worldPosition?.isVector3 ? worldPosition.clone() : vec(worldPosition);
  if (![point.x, point.y, point.z].every(Number.isFinite)) throw new Error('IK target must be finite');
  root.updateWorldMatrix(true, true);
  rig.handles[id].position.copy(root.worldToLocal(point));
  root.updateWorldMatrix(true, true);
  const parent = chain.upper.parent, anchor = chain.upper.position.clone();
  const target = parent.worldToLocal(rig.handles[chainId].getWorldPosition(new THREE.Vector3()));
  const pole = parent.worldToLocal(rig.handles[chainId + 'Pole'].getWorldPosition(new THREE.Vector3()));
  const direction = target.clone().sub(anchor), [a, b] = chain.lengths;
  let distance = direction.length();
  if (distance < 1e-8) direction.copy(DOWN); else direction.divideScalar(distance);
  distance = THREE.MathUtils.clamp(distance, Math.abs(a - b) + 1e-6, a + b - 1e-6);
  const bend = pole.clone().sub(anchor); bend.addScaledVector(direction, -bend.dot(direction));
  if (bend.lengthSq() < 1e-10) {
    bend.set(0, 0, 1).addScaledVector(direction, -direction.z);
    if (bend.lengthSq() < 1e-10) bend.set(1, 0, 0).addScaledVector(direction, -direction.x);
  }
  bend.normalize();
  const along = (a * a + distance * distance - b * b) / (2 * distance);
  const elbow = anchor.clone().addScaledVector(direction, along).addScaledVector(bend, Math.sqrt(Math.max(0, a * a - along * along)));
  const reached = anchor.clone().addScaledVector(direction, distance);
  const upperQ = new THREE.Quaternion().setFromUnitVectors(DOWN, elbow.clone().sub(anchor).normalize());
  const lowerDirection = reached.clone().sub(elbow).normalize().applyQuaternion(upperQ.clone().invert());
  chain.upper.quaternion.copy(upperQ);
  chain.lower.quaternion.setFromUnitVectors(DOWN, lowerDirection);
  rig.pose = currentPose(rig); syncTargets(root);
  return clone(rig.pose);
}

export function serializeRig(root) {
  const rig = root.userData.rig;
  if (!rig) return { material: { ...(root.userData.material || {}) } };
  const ik = {};
  for (const [id, handle] of Object.entries(rig.handles)) if (id.endsWith('Pole')) ik[id] = handle.position.toArray().map(round);
  return { pose: currentPose(rig), hands: clone(rig.hands), body: clone(rig.body), ik, face: { ...rig.face }, material: { ...root.userData.material } };
}

function buildProp(root, type, color) {
  const c = context(root, color), main = c.material(color || '#a6aaa1'), wood = c.material(color || '#a78b68');
  const dark = c.material('#42494c'), metal = c.material('#747d81', { metalness: 0.45, roughness: 0.46 });
  const fabric = c.material(color || '#8f9f9a'), light = c.material('#e7e1d3');
  for (const material of [main, wood, fabric]) material.userData.layoutTint = true;
  const box = (w, h, d, x, y, z, mat = main, parent = root) => c.mesh(parent, 'box', [w, h, d], [x, y, z], mat);
  const ball = (x, y, z, rx, ry, rz, mat = main, parent = root) => c.mesh(parent, 'sphere', [rx, ry, rz], [x, y, z], mat);
  const post = (x, z, height, radius = 0.035, mat = wood) => c.mesh(root, 'cylinder', [radius, height, radius], [x, height / 2, z], mat);
  const legs = (w, d, h, mat = wood) => { for (const x of [-w / 2, w / 2]) for (const z of [-d / 2, d / 2]) box(0.055, h, 0.055, x, h / 2, z, mat); };
  const cushion = (w, h, d, x, y, z, mat = fabric) => ball(x, y, z, w / 2, h / 2, d / 2, mat);
  const table = (w, d, h) => { box(w, 0.065, d, 0, h - 0.0325, 0, wood); legs(w - 0.14, d - 0.14, h - 0.06); };
  const bed = (width = 1.05, level = 0) => {
    box(width, 0.16, 2.05, 0, level + 0.27, 0, wood); legs(width - 0.13, 1.89, level + 0.27);
    cushion(width - 0.02, 0.25, 2.0, 0, level + 0.42, 0, light);
    box(width + 0.04, 0.8, 0.07, 0, level + 0.55, -1.0, wood);
    box(width - 0.04, 0.035, 1.25, 0, level + 0.55, 0.33, fabric);
    for (const x of width > 1.3 ? [-width * 0.24, width * 0.24] : [0]) cushion(0.60, 0.14, 0.36, x, level + 0.57, -0.69, light);
  };
  const doorFrame = () => { box(0.12, 2.2, 0.18, -0.55, 1.1, 0, light); box(0.12, 2.2, 0.18, 0.55, 1.1, 0, light); box(1.22, 0.12, 0.18, 0, 2.2, 0, light); };

  if (type === 'box') box(1, 1, 1, 0, 0.5, 0);
  else if (type === 'sphere') ball(0, 0.5, 0, 0.5, 0.5, 0.5);
  else if (type === 'cylinder') c.mesh(root, 'cylinder', [0.5, 1, 0.5], [0, 0.5, 0], main);
  else if (type === 'plane') box(3, 0.04, 3, 0, -0.02, 0);
  else if (['table', 'dining_table', 'desk', 'coffee_table'].includes(type)) {
    const sizes = { table: [1, 1, 0.75], dining_table: [1.9, 0.9, 0.75], desk: [1.4, 0.7, 0.75], coffee_table: [1.15, 0.6, 0.42] };
    table(...sizes[type]);
    if (type === 'coffee_table') box(0.96, 0.04, 0.45, 0, 0.12, 0, wood);
    if (type === 'desk') { box(0.4, 0.60, 0.6, 0.43, 0.35, 0, wood); for (const y of [0.23, 0.43, 0.62]) { box(0.36, 0.16, 0.02, 0.43, y, 0.31, main); box(0.14, 0.018, 0.04, 0.43, y, 0.34, metal); } }
  } else if (['chair', 'armchair', 'office_chair', 'stool'].includes(type)) {
    const office = type === 'office_chair';
    if (office) {
      c.mesh(root, 'cylinder', [0.045, 0.42, 0.045], [0, 0.21, 0], metal);
      for (let n = 0; n < 5; n++) { const a = n * Math.PI * 2 / 5, x = Math.cos(a) * 0.29, z = Math.sin(a) * 0.29; c.rod(root, [0, 0.13, 0], [x, 0.06, z], 0.025, dark); ball(x, 0.04, z, 0.045, 0.04, 0.035, dark); }
    } else legs(0.37, 0.35, 0.42);
    if (type === 'stool') c.mesh(root, 'cylinder', [0.25, 0.06, 0.25], [0, 0.46, 0], wood);
    else {
      cushion(0.52, 0.12, 0.50, 0, 0.46, 0, type === 'chair' ? wood : fabric);
      box(0.04, 0.5, 0.04, -0.21, 0.68, -0.20, office ? metal : wood); box(0.04, 0.5, 0.04, 0.21, 0.68, -0.20, office ? metal : wood);
      cushion(0.50, office ? 0.56 : 0.38, 0.09, 0, office ? 0.79 : 0.77, -0.22, type === 'chair' ? wood : fabric);
      if (type !== 'chair') for (const x of [-0.3, 0.3]) { box(0.04, 0.20, 0.04, x, 0.56, 0.02, metal); cushion(0.10, 0.08, 0.43, x, 0.68, 0, fabric); }
    }
  } else if (['bench', 'long_bench'].includes(type)) {
    const width = type === 'bench' ? 1.25 : 1.85;
    for (const x of [-width * 0.37, width * 0.37]) { box(0.09, 0.44, 0.49, x, 0.22, 0, dark); }
    for (const z of [-0.19, -0.06, 0.07, 0.20]) box(width, 0.055, 0.10, 0, 0.46, z, wood);
    if (type === 'long_bench') {
      for (const x of [-width * 0.43, width * 0.43]) { box(0.055, 0.52, 0.055, x, 0.69, -0.20, dark); box(0.06, 0.06, 0.52, x, 0.65, 0, dark); }
      for (const y of [0.65, 0.78, 0.91]) box(width, 0.09, 0.045, 0, y, -0.22, wood);
    }
  } else if (type === 'sofa') {
    legs(1.7, 0.65, 0.2, dark); box(2.05, 0.25, 0.82, 0, 0.3, 0, fabric);
    for (const x of [-0.64, 0, 0.64]) { cushion(0.64, 0.19, 0.70, x, 0.48, 0.04); cushion(0.64, 0.52, 0.20, x, 0.71, -0.31); }
    for (const x of [-1.03, 1.03]) cushion(0.23, 0.48, 0.88, x, 0.50, 0);
  } else if (['bed', 'double_bed', 'bunk_bed'].includes(type)) {
    bed(type === 'double_bed' ? 1.65 : 1.05);
    if (type === 'bunk_bed') {
      bed(1.05, 1.15);
      for (const x of [-0.49, 0.49]) for (const z of [-0.95, 0.95]) box(0.07, 1.95, 0.07, x, 0.975, z, wood);
      for (const y of [1.83, 1.99]) box(1.05, 0.05, 0.05, 0, y, 0.98, wood);
      for (const x of [0.18, 0.47]) c.rod(root, [x, 0, 1.3], [x, 1.8, 1.02], 0.022, metal);
      for (let n = 1; n <= 5; n++) c.rod(root, [0.18, n * 0.3, 1.3 - n * 0.046], [0.47, n * 0.3, 1.3 - n * 0.046], 0.022, metal);
    }
  } else if (['cabinet', 'wardrobe', 'bookshelf', 'dresser', 'counter'].includes(type)) {
    const height = type === 'wardrobe' ? 1.95 : type === 'bookshelf' ? 1.8 : type === 'counter' ? 1.05 : 0.85;
    const width = type === 'counter' ? 1.8 : type === 'wardrobe' ? 1.25 : 1.0, depth = type === 'bookshelf' ? 0.30 : 0.52;
    box(width, 0.06, depth, 0, 0.06, 0, wood); box(width, 0.06, depth, 0, height, 0, wood);
    for (const x of [-width / 2 + 0.025, width / 2 - 0.025]) box(0.05, height, depth, x, height / 2, 0, wood);
    box(width, height, 0.025, 0, height / 2, -depth / 2, wood);
    if (type === 'bookshelf') {
      for (let row = 0; row < 4; row++) { const y = 0.11 + row * 0.42; box(width, 0.04, depth, 0, y, 0, wood);
        for (let n = 0; n < 6; n++) { const h = 0.24 + (n % 3) * 0.035; box(0.09, h, 0.22, -0.38 + n * 0.125, y + h / 2 + 0.02, 0.015, c.material(['#8f6f5e', '#768d86', '#b2a17e'][n % 3])); }
      }
    } else if (type === 'dresser') {
      for (let row = 0; row < 4; row++) { const y = 0.16 + row * 0.19; box(width - 0.1, 0.16, 0.03, 0, y, depth / 2, main); box(0.22, 0.018, 0.04, 0, y, depth / 2 + 0.025, metal); }
    } else if (type === 'counter') {
      box(width + 0.10, 0.07, depth + 0.12, 0, height + 0.02, 0, dark); c.rod(root, [-0.75, 0.18, 0.37], [0.75, 0.18, 0.37], 0.025, metal);
    } else for (const sign of [-1, 1]) { box(width / 2 - 0.04, height - 0.12, 0.03, sign * width / 4, height / 2 + 0.02, depth / 2, main); box(0.025, 0.17, 0.04, sign * 0.07, height * 0.55, depth / 2 + 0.03, metal); }
  } else if (type === 'doorway' || type === 'door') {
    doorFrame();
    if (type === 'door') { const hinge = new THREE.Group(); hinge.position.set(-0.48, 0, 0); hinge.rotation.y = -Math.PI / 5; root.add(hinge);
      box(0.96, 2.12, 0.045, 0.48, 1.06, 0, wood, hinge); box(0.70, 0.72, 0.02, 0.48, 1.55, 0.031, main, hinge); box(0.70, 0.72, 0.02, 0.48, 0.58, 0.031, main, hinge); ball(0.84, 1.03, 0.07, 0.035, 0.035, 0.035, metal, hinge); }
  } else if (type === 'window') {
    const frame = c.material('#dedbd2');
    for (const x of [-0.65, 0, 0.65]) box(0.065, 1.25, 0.10, x, 1.4, 0, frame);
    for (const y of [0.78, 1.4, 2.02]) box(1.36, 0.065, 0.10, 0, y, 0, frame);
    box(1.30, 1.20, 0.025, 0, 1.4, 0, c.material('#b5d6dc', { transparent: true, opacity: 0.28, depthWrite: false }));
    box(1.50, 0.065, 0.25, 0, 0.74, 0.06, frame);
  } else if (type === 'wall') {
    box(3, 2.7, 0.15, 0, 1.35, 0, main); box(3, 0.12, 0.18, 0, 0.06, 0.015, light);
  } else if (type === 'room') {
    box(4.2, 0.06, 3.6, 0, -0.03, 0, c.material('#b7ac96'));
    box(4.2, 2.7, 0.12, 0, 1.35, -1.8, main);
    for (const x of [-2.1, 2.1]) { box(0.12, 2.7, 3.6, x, 1.35, 0, main); box(0.14, 0.12, 3.6, x, 0.06, 0, light); }
    box(4.2, 0.12, 0.14, 0, 0.06, -1.73, light);
    box(1.2, 1.1, 0.025, 0.5, 1.55, -1.72, c.material('#a9c2c6'));
    for (const x of [-0.12, 1.12]) box(0.07, 1.2, 0.06, x, 1.55, -1.69, light);
    for (const y of [0.95, 2.15]) box(1.31, 0.07, 0.06, 0.5, y, -1.69, light);
  } else if (type === 'stairs') {
    for (let n = 0; n < 6; n++) box(1.2, (n + 1) * 0.17, 0.28, 0, (n + 1) * 0.085, 0.7 - n * 0.28, main);
    for (const x of [-0.56, 0.56]) { c.rod(root, [x, 0.95, 0.80], [x, 1.80, -0.65], 0.025, metal); for (let n = 0; n < 3; n++) c.rod(root, [x, 0.17 + n * 0.34, 0.7 - n * 0.56], [x, 0.99 + n * 0.34, 0.7 - n * 0.56], 0.02, metal); }
  } else if (type === 'crate') {
    box(0.85, 0.75, 0.75, 0, 0.375, 0, wood);
    for (const x of [-0.36, 0.36]) for (const z of [-0.39, 0.39]) box(0.11, 0.79, 0.04, x, 0.395, z, main);
    for (const z of [-0.4, 0.4]) for (const y of [0.08, 0.67]) box(0.85, 0.10, 0.04, 0, y, z, main);
    c.rod(root, [-0.33, 0.14, 0.42], [0.33, 0.61, 0.42], 0.04, main);
  } else if (type === 'tree') {
    post(0, 0, 1.7, 0.12, c.material('#7f6853')); const leaf = c.material(color || '#81977a');
    for (const [x, y, z, radius] of [[0, 2.1, 0, 0.75], [-0.5, 1.8, 0.1, 0.5], [0.45, 1.95, 0.15, 0.53], [0.15, 2.48, -0.1, 0.46]]) {
      c.rod(root, [0, 1.25, 0], [x, y, z], 0.065, c.material('#7f6853')); ball(x, y, z, radius, radius * 0.85, radius, leaf);
    }
  } else if (type === 'streetlamp') {
    post(0, 0, 2.8, 0.045, dark); c.mesh(root, 'cylinder', [0.13, 0.12, 0.13], [0, 0.06, 0], dark);
    c.rod(root, [0, 2.75, 0], [0.5, 2.75, 0], 0.035, dark); c.mesh(root, 'cone', [0.24, 0.13, 0.24], [0.5, 2.69, 0], dark);
    ball(0.5, 2.62, 0, 0.15, 0.06, 0.15, c.material('#f5e6b3', { emissive: '#8b7448', emissiveIntensity: 0.3 }));
  } else if (type === 'car') {
    box(1.68, 0.42, 3.6, 0, 0.50, 0, main); cushion(1.55, 0.65, 1.9, 0, 0.98, -0.15, main);
    box(1.38, 0.46, 1.5, 0, 1.06, -0.12, c.material('#59676a'));
    for (const x of [-0.85, 0.85]) for (const z of [-1.16, 1.16]) c.mesh(root, 'cylinder', [0.32, 0.18, 0.32], [x, 0.32, z], dark, [0, 0, Math.PI / 2]);
    for (const x of [-0.58, 0.58]) { box(0.27, 0.13, 0.04, x, 0.56, 1.82, light); box(0.24, 0.13, 0.04, x, 0.56, -1.82, c.material('#ad7169')); }
  } else if (type === 'bicycle') {
    const tire = c.material('#3b4042'), frame = c.material(color || '#9b7c62');
    for (const z of [-0.66, 0.66]) { c.ring(root, 0.34, 0.026, [0, 0.35, z], tire, [0, Math.PI / 2, 0]);
      for (let n = 0; n < 8; n++) { const a = n * Math.PI / 4; c.rod(root, [0, 0.35, z], [0, 0.35 + Math.sin(a) * 0.32, z + Math.cos(a) * 0.32], 0.005, metal); }
    }
    for (const [a, b] of [ [[0, 0.35, -0.66], [0, 0.4, 0]], [[0, 0.4, 0], [0, 0.88, -0.28]], [[0, 0.88, -0.28], [0, 0.35, -0.66]], [[0, 0.88, -0.28], [0, 0.9, 0.43]], [[0, 0.9, 0.43], [0, 0.4, 0]], [[0, 0.9, 0.43], [0, 0.35, 0.66]], [[0, 0.9, 0.43], [0, 1.03, 0.48]] ]) c.rod(root, a, b, 0.025, frame);
    c.rod(root, [-0.27, 1.03, 0.48], [0.27, 1.03, 0.48], 0.018, dark);
    cushion(0.22, 0.08, 0.32, 0, 0.95, -0.28, dark); c.rod(root, [-0.2, 0.4, 0], [0.2, 0.4, 0], 0.015, metal);
  } else throw new Error('Unknown layout asset: ' + type);
}

export function createAsset(type, record = {}) {
  type = type === 'person' ? 'adult_male' : type;
  if (!ASSETS.some(asset => asset.id === type)) throw new Error('Unknown layout asset: ' + type);
  const root = new THREE.Group();
  root.name = record.label || ASSETS.find(asset => asset.id === type).label;
  root.userData.assetType = type; root.userData.assetId = record.id || type; root.userData.proceduralBlockingModel = true;
  if (PROFILES[type]) {
    buildHuman(root, type, bodyValues(type, record.body), record.color);
    applyRig(root, record);
  } else { buildProp(root, type, record.material?.color || record.color); applyMaterial(root, record.material || (record.color ? { color: record.color } : {})); }
  nameParts(root);
  root.updateWorldMatrix(true, true);
  return root;
}

function nameParts(root) {
  const prefix = String(root.userData.assetId), counters = {};
  root.name = prefix;
  root.traverse(object => {
    if (object === root) return;
    const kind = object.name && !object.name.startsWith(prefix + '__') ? object.name : object.isMesh ? 'mesh' : 'group';
    counters[kind] = (counters[kind] || 0) + 1;
    object.name = prefix + '__' + kind + '_' + counters[kind];
  });
}

function disposeChildren(root) {
  const geometries = new Set(), materials = new Set();
  root.traverse(object => {
    if (object.geometry) geometries.add(object.geometry);
    for (const material of Array.isArray(object.material) ? object.material : object.material ? [object.material] : []) materials.add(material);
  });
  for (const geometry of geometries) geometry.dispose();
  for (const material of materials) material.dispose();
  root.clear();
  delete root.userData.rig;
}
export function disposeAsset(root) { disposeChildren(root); }

// Function aliases make the library usable without editor-specific terminology.
export const catalog = ASSETS;
export const create = createAsset;
