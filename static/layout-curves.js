/* Serializable numeric channels and weighted cubic Bezier evaluation. No DOM. */
export const CURVE_MODES = ['auto', 'user', 'break', 'linear', 'constant'];
const clone = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
const clamp = (value, lo, hi) => Math.max(lo, Math.min(hi, value));
const finite = value => typeof value === 'number' && Number.isFinite(value);
const forbidden = new Set(['__proto__', 'prototype', 'constructor']);

export function channelValue(value, path = '') {
  return path === '' ? value : path.split('.').reduce((current, part) => current?.[part], value);
}
export function setChannelValue(value, path, next) {
  if (!finite(next)) throw new Error('曲线数值必须有限');
  if (path === '') return next;
  const result = clone(value), parts = path.split('.');
  if (parts.some(part => forbidden.has(part) || !/^[\w-]+$/.test(part))) throw new Error('曲线分量路径无效');
  let current = result;
  for (const part of parts.slice(0, -1)) current = current[part];
  current[parts.at(-1)] = next;
  return result;
}
export function discreteProperty(path) {
  return /(^|\.)(parentId|visible|hands|hdri|background|enabled|clip)(\.|$)/.test(path);
}
function supportedProperty(path) {
  return !discreteProperty(path) && !/(^|\.)quaternion(\.|$)/.test(path);
}
export function numericChannels(track) {
  if (!track?.keys?.length || !supportedProperty(track.property)) return [];
  const paths = [];
  function visit(value, path) {
    if (finite(value)) { if (supportedProperty(track.property + (path ? '.' + path : ''))) paths.push(path); }
    else if (value && typeof value === 'object') {
      for (const [name, child] of Object.entries(value)) if (!forbidden.has(name)) visit(child, path ? path + '.' + name : name);
    }
  }
  visit(track.keys[0].value, '');
  return paths.filter(path => track.keys.every(key => finite(channelValue(key.value, path))));
}
export function normalizeCurves(raw, property, value) {
  if (raw === undefined) return undefined;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('曲线切线须为对象');
  const result = {};
  for (const [path, spec] of Object.entries(raw)) {
    if (path && path.split('.').some(part => forbidden.has(part) || !/^[\w-]+$/.test(part))) throw new Error('曲线分量路径无效');
    if (!supportedProperty(property + (path ? '.' + path : '')) || !finite(channelValue(value, path))) throw new Error('此属性不支持数值曲线');
    if (!spec || !CURVE_MODES.includes(spec.mode)) throw new Error('曲线切线模式无效');
    result[path] = { mode: spec.mode };
    for (const side of ['in', 'out']) if (spec[side] !== undefined) {
      const handle = spec[side];
      if (!handle || !finite(handle.dt) || !finite(handle.dv) || handle.dt < 0 || handle.dt > 1e6 || Math.abs(handle.dv) > 1e12) throw new Error('切线须包含有效 dt/dv，dt 不得为负');
      result[path][side] = { dt: handle.dt, dv: handle.dv };
    }
  }
  return result;
}
const deltaAngle = (a, b) => (((b - a + 180) % 360 + 360) % 360) - 180;
function legacyValue(track, a, b, time, path) {
  const from = channelValue(a.value, path), to = channelValue(b.value, path);
  const mode = a.interpolation || track.interpolation;
  if (mode === 'step') return from;
  const t = clamp((time - a.time) / (b.time - a.time), 0, 1), mix = mode === 'smooth' ? t * t * (3 - 2 * t) : t;
  const full = track.property + (path ? '.' + path : '');
  const angle = full.startsWith('rotation') || (full.startsWith('pose.') && !full.includes('pelvisTranslation'));
  return from + (angle ? deltaAngle(from, to) : to - from) * mix;
}
function autoSlope(track, index, path) {
  const keys = track.keys, key = keys[index], previous = keys[index - 1], next = keys[index + 1];
  const value = channelValue(key.value, path);
  if (!previous && !next) return 0;
  if (!previous) return (channelValue(next.value, path) - value) / (next.time - key.time);
  if (!next) return (value - channelValue(previous.value, path)) / (key.time - previous.time);
  const left = (value - channelValue(previous.value, path)) / (key.time - previous.time);
  const right = (channelValue(next.value, path) - value) / (next.time - key.time);
  if (left * right <= 0) return 0;
  // Monotone auto tangent: no accidental overshoot around extrema or plateaus.
  const slope = (channelValue(next.value, path) - channelValue(previous.value, path)) / (next.time - previous.time);
  return Math.sign(slope) * Math.min(Math.abs(slope), 3 * Math.abs(left), 3 * Math.abs(right));
}
export function tangentHandle(track, index, path, side) {
  const keys = track.keys, key = keys[index], spec = key.curves?.[path], neighbour = keys[index + (side === 'in' ? -1 : 1)];
  const dt = neighbour ? Math.abs(neighbour.time - key.time) / 3 : .25;
  if (spec && ['user', 'break'].includes(spec.mode) && spec[side]) return clone(spec[side]);
  const slope = spec?.mode === 'constant' ? 0 : autoSlope(track, index, path);
  return { dt, dv: slope * dt };
}
export function segmentHandles(track, index, path) {
  const a = track.keys[index], b = track.keys[index + 1], span = b.time - a.time;
  const out = tangentHandle(track, index, path, 'out'), incoming = tangentHandle(track, index + 1, path, 'in');
  // Keep time monotonic, even after keys move closer together. Values/slopes stay meaningful.
  const sum = out.dt + incoming.dt;
  if (sum > span) for (const handle of [out, incoming]) { handle.dt *= span / sum; handle.dv *= span / sum; }
  return { out, in: incoming };
}
const bezier = (a, b, c, d, t) => (1 - t) ** 3 * a + 3 * (1 - t) ** 2 * t * b + 3 * (1 - t) * t * t * c + t ** 3 * d;
export function sampleChannel(track, time, path = '') {
  const keys = track.keys;
  if (!keys.length) return undefined;
  if (time <= keys[0].time) return channelValue(keys[0].value, path);
  if (time >= keys.at(-1).time) return channelValue(keys.at(-1).value, path);
  const index = keys.findIndex(key => key.time > time) - 1, a = keys[index], b = keys[index + 1];
  const from = channelValue(a.value, path), to = channelValue(b.value, path), mode = a.curves?.[path]?.mode;
  if (!mode) return legacyValue(track, a, b, time, path);
  if (mode === 'constant') return from;
  if (mode === 'linear') return from + (to - from) * (time - a.time) / (b.time - a.time);
  const handles = segmentHandles(track, index, path);
  const x1 = a.time + handles.out.dt, x2 = b.time - handles.in.dt;
  // Weighted handles make x non-linear: solve x(u)=time, not u=(time-a)/(b-a).
  let lo = 0, hi = 1;
  for (let iteration = 0; iteration < 38; iteration++) {
    const u = (lo + hi) / 2;
    if (bezier(a.time, x1, x2, b.time, u) < time) lo = u; else hi = u;
  }
  return bezier(from, from + handles.out.dv, to - handles.in.dv, to, (lo + hi) / 2);
}
export function applyNumericCurves(track, time, value) {
  const index = track.keys.findIndex(key => key.time > time) - 1;
  if (index < 0 || !supportedProperty(track.property)) return value;
  let result = value;
  for (const path of Object.keys(track.keys[index].curves || {})) result = setChannelValue(result, path, sampleChannel(track, time, path));
  return result;
}
export function editTangent(track, index, path, side, handle, broken = false) {
  const key = track.keys[index], spec = clone(key.curves?.[path] || { mode: 'user' });
  spec.mode = broken ? 'break' : spec.mode === 'break' ? 'break' : 'user';
  spec[side] = { dt: Math.max(.000001, handle.dt), dv: handle.dv };
  if (spec.mode === 'user') {
    const other = side === 'in' ? 'out' : 'in', old = spec[other] || tangentHandle(track, index, path, other);
    spec[other] = { dt: old.dt, dv: spec[side].dv / spec[side].dt * old.dt };
  }
  return { ...clone(key.curves || {}), [path]: spec };
}
