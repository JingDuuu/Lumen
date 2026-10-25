"use strict";
const $ = (id) => document.getElementById(id);
const TEXT_ROLES = {
  scene: "场景",
  char: "人物",
  action: "动作",
  camera: "镜头运动",
  audio: "声音",
  style: "视觉风格",
  extra: "补充描述",
  layout: "构图与布局",
  storyboard: "分镜",
};
const REFERENCE_ROLES = {
  character: "人物",
  scene: "场景",
  action: "动作",
  camera: "镜头",
  style: "风格",
  layout: "构图与布局",
  storyboard: "分镜",
  audio: "声音",
  general: "自由素材",
};
const CHARACTER_VIEWS = {
  general: "整体参考",
  front: "正面",
  side: "侧面",
  back: "背面",
  three_view: "三视图",
  detail: "局部细节",
};
const PURPOSE_TEXT_ROLES = {
  character: "char",
  scene: "scene",
  action: "action",
  camera: "camera",
  style: "style",
  layout: "layout",
  storyboard: "storyboard",
  audio: "audio",
  general: "extra",
};
const IMAGE_ROLES = {
  first_frame: "首帧 · 接入模型",
  last_frame: "尾帧 · 接入模型",
  middle_frame_1: "中间帧 · 25% 位置",
  middle_frame_2: "中间帧 · 50% 位置",
  middle_frame_3: "中间帧 · 75% 位置",
  reference: "多模态参考 · Ref2VA",
  auto: "自动首尾帧",
};
const CONNECTION_LABELS = {
  reference: "参考",
  character_consistency: "人物一致",
  style_inherit: "风格沿用",
  action_reference: "动作借鉴",
  camera: "镜头参考",
  association: "关联",
  continuation: "先后延续",
};
const CLIPBOARD_TYPE = "application/x-lumen-board";
const CLIPBOARD_PREFIX = "LUMEN_BOARD_V1\n";
const MAX_ITEMS = 100;
const MAX_ZONES = 100;
const STATUS = {
  submitting: "正在提交",
  cancelling: "正在取消",
  queued: "等待生成",
  connecting: "正在连接",
  running: "生成中",
  done: "已完成",
  failed: "失败",
  cancelled: "已取消",
  interrupted: "已中断",
  stalled: "长时间无进展",
};
const ACTIVE = new Set([
  "submitting",
  "cancelling",
  "queued",
  "running",
  "connecting",
  "stalled",
]);
const DEFAULT_PARAMS = {
  resolution: "608,352",
  duration: 2,
  steps: 8,
  seed: 888,
  model_mode: "auto",
};
const LOCAL_KEY = "lumen-board-v2";
const state = {
  items: [],
  connections: [],
  zones: [],
  focusedZone: null,
  selectedIds: new Set(),
  selectedConnection: null,
  linkSource: null,
  linkMode: false,
  future: [],
  params: { ...DEFAULT_PARAMS },
  viewport: { zoom: 1, panX: 0, panY: 0 },
  selected: null,
  page: "board",
  history: [],
  tasks: [],
  records: [],
  system: null,
  estimate: null,
  estimateSignature: null,
  busy: false,
  loaded: false,
  starOnly: false,
  asset: null,
  presets: [],
  dirty: false,
  saveRevision: 0,
  boardRevision: null,
  saveConflict: false,
  boardSaving: false,
  checkingRemote: false,
};
const canvas = $("canvas"),
  world = $("world");
let saveTimer,
  toastTimer,
  drag,
  saveChain = Promise.resolve(),
  polling = false,
  spacePressed = false,
  internalClipboard = null,
  pasteCount = 0,
  contextPoint = null,
  clipboardFallback = false;
function node(tag, className, text) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text !== undefined) el.textContent = String(text);
  return el;
}
function button(text, cls, handler) {
  const b = node("button", cls || "btn", text);
  b.type = "button";
  b.addEventListener("click", handler);
  return b;
}
function clone(data) {
  return JSON.parse(JSON.stringify(data));
}
function id() {
  return "c" + crypto.randomUUID().replaceAll("-", "").slice(0, 12);
}
function minimumCardHeight(item) {
  return item.kind === "text" ? 220 : item.kind === "video" ? 310 : 280;
}
function purposeOf(item) {
  if (item.kind === "text")
    return (
      Object.entries(PURPOSE_TEXT_ROLES).find(
        ([, role]) => role === item.role,
      )?.[0] || "general"
    );
  return Object.hasOwn(REFERENCE_ROLES, item.reference_role)
    ? item.reference_role
    : "general";
}
const QUADRANTS = [
  { purpose: "character", name: "人物", caption: "身份 · 造型 · 多视角" },
  { purpose: "scene", name: "场景", caption: "空间 · 环境 · 光线" },
  { purpose: "action", name: "动作与镜头", caption: "动作节奏 · 机位 · 运镜" },
  {
    purpose: "layout",
    name: "分镜与 3D Layout",
    caption: "分镜顺序 · 空间调度 · 镜头预演",
  },
];
function zonePurpose(purpose) {
  return purpose === "camera"
    ? "action"
    : purpose === "storyboard"
      ? "layout"
      : purpose;
}
function defaultZones() {
  return QUADRANTS.map((entry, slot) => ({
    id: id(),
    name: entry.name,
    purpose: entry.purpose,
    slot,
    x: (slot % 2) * 900,
    y: Math.floor(slot / 2) * 820,
    w: 900,
    h: 820,
    collapsed: false,
  }));
}
function zoneOf(item) {
  return state.zones.find((zone) => zone.id === item.zone_id) || null;
}
function itemVisible() {
  return true;
}
function zoneAt(point) {
  return (
    state.zones.find(
      (zone) =>
        point.x >= zone.x &&
        point.x < zone.x + zone.w &&
        point.y >= zone.y &&
        point.y < zone.y + zone.h,
    ) || null
  );
}
function matchingZone(item, zones = state.zones) {
  const purpose = purposeOf(item);
  return (
    zones.find((zone) => zone.purpose === purpose) ||
    zones.find((zone) => zone.purpose === zonePurpose(purpose))
  );
}
function ensurePurposeZone(purpose) {
  const existing =
    state.zones.find((zone) => zone.purpose === purpose) ||
    state.zones.find((zone) => zone.purpose === zonePurpose(purpose));
  if (existing) return existing;
  const used = new Set(state.zones.map((zone) => zone.slot));
  let slot = 4;
  while (used.has(slot)) slot++;
  const w = state.zones[0]?.w || 900,
    h = state.zones[0]?.h || 820;
  const zone = {
    id: id(),
    name: REFERENCE_ROLES[purpose],
    purpose,
    slot,
    x: (slot % 2) * w,
    y: Math.floor(slot / 2) * h,
    w,
    h,
    collapsed: false,
  };
  state.zones.push(zone);
  state.zones.sort((a, b) => a.slot - b.slot);
  return zone;
}
function placeCardInZone(item, zone) {
  const count = state.items.filter(
    (value) => value.id !== item.id && value.zone_id === zone.id,
  ).length;
  item.zone_id = zone.id;
  item.x = Math.max(
    zone.x + 24,
    Math.min(
      zone.x + 40 + (count % 2) * (item.w + 28),
      zone.x + zone.w - item.w - 24,
    ),
  );
  item.y = Math.max(
    zone.y + 130,
    Math.min(
      zone.y + 130 + Math.floor(count / 2) * 48,
      zone.y + zone.h - item.h - 24,
    ),
  );
}
function setPurpose(item, purpose) {
  if (item.kind === "text") item.role = PURPOSE_TEXT_ROLES[purpose] || "extra";
  else
    item.reference_role = Object.hasOwn(REFERENCE_ROLES, purpose)
      ? purpose
      : "general";
}
function assignToZone(item, zone, changePurpose = true) {
  item.zone_id = zone?.id || null;
  if (zone && changePurpose && zonePurpose(purposeOf(item)) !== zone.purpose)
    setPurpose(item, zone.purpose);
}
function assignDroppedCards(items) {
  let changed = false;
  for (const item of items) {
    const zone = zoneAt({ x: item.x + item.w / 2, y: item.y + item.h / 2 });
    const before = [item.zone_id, purposeOf(item)].join(":");
    assignToZone(item, zone);
    changed ||= before !== [item.zone_id, purposeOf(item)].join(":");
  }
  return changed;
}
function arrangeQuadrants(zones, items) {
  const layouts = zones.map((zone) => {
    const members = items.filter((item) => item.zone_id === zone.id),
      rows = [];
    for (let index = 0; index < members.length; index += 2)
      rows.push(members.slice(index, index + 2));
    return {
      zone,
      rows,
      width: Math.max(
        0,
        ...rows.map((row) => row.reduce((sum, item) => sum + item.w, 0) + 28),
      ),
      height: rows.reduce(
        (sum, row) => sum + Math.max(...row.map((item) => item.h)) + 28,
        0,
      ),
    };
  });
  const width = Math.max(900, ...layouts.map((layout) => layout.width + 80));
  const height = Math.max(820, ...layouts.map((layout) => layout.height + 160));
  for (const { zone, rows } of layouts) {
    Object.assign(zone, {
      x: (zone.slot % 2) * width,
      y: Math.floor(zone.slot / 2) * height,
      w: width,
      h: height,
      collapsed: false,
    });
    let y = zone.y + 130;
    for (const row of rows) {
      let x = zone.x + 40;
      for (const item of row) {
        item.x = x;
        item.y = y;
        x += item.w + 28;
      }
      y += Math.max(...row.map((item) => item.h)) + 28;
    }
  }
}
function prepareQuadrants(board) {
  const legacy =
    !board.zones.length ||
    board.zones.some((zone) => !Number.isInteger(zone.slot));
  if (!legacy) {
    const width = Math.max(900, ...board.zones.map((zone) => zone.w));
    const height = Math.max(820, ...board.zones.map((zone) => zone.h));
    for (let slot = 0; slot < 4; slot++) {
      if (!board.zones.some((zone) => zone.slot === slot))
        board.zones.push({
          ...QUADRANTS[slot],
          id: id(),
          slot,
          w: width,
          h: height,
        });
    }
    board.zones.sort((a, b) => a.slot - b.slot);
    board.zones.forEach((zone) =>
      Object.assign(zone, {
        x: (zone.slot % 2) * width,
        y: Math.floor(zone.slot / 2) * height,
        w: width,
        h: height,
        collapsed: false,
      }),
    );
    return board;
  }
  const original = board.zones,
    result = [],
    mapping = new Map();
  for (let slot = 0; slot < QUADRANTS.length; slot++) {
    const definition = QUADRANTS[slot];
    const candidates = original.filter(
      (zone) => zonePurpose(zone.purpose) === definition.purpose,
    );
    const selected =
      candidates.find((zone) => zone.purpose === definition.purpose) ||
      candidates[0];
    const zone = {
      ...(selected || {}),
      id: selected?.id || id(),
      name:
        selected && !Object.values(REFERENCE_ROLES).includes(selected.name)
          ? selected.name
          : definition.name,
      purpose: definition.purpose,
      slot,
      w: 900,
      h: 820,
    };
    result.push(zone);
    if (selected) mapping.set(selected.id, zone.id);
    for (const candidate of candidates) {
      if (candidate === selected) continue;
      const generic =
        Object.values(REFERENCE_ROLES).includes(candidate.name) ||
        QUADRANTS.some((value) => value.name === candidate.name);
      if (!generic) continue;
      mapping.set(candidate.id, zone.id);
      for (const field of ["notes", "description"])
        if (candidate[field])
          zone[field] = [zone[field], candidate[field]]
            .filter(Boolean)
            .join("\n");
    }
  }
  for (const old of original)
    if (!mapping.has(old.id)) {
      const hasCards = board.items.some((item) => item.zone_id === old.id);
      const generic =
        Object.values(REFERENCE_ROLES).includes(old.name) ||
        QUADRANTS.some((value) => value.name === old.name);
      if (!hasCards && generic && !old.notes && !old.description) continue;
      const zone = { ...old, slot: result.length };
      result.push(zone);
      mapping.set(old.id, zone.id);
    }
  for (const item of board.items) {
    const previous = mapping.get(item.zone_id);
    let zone =
      result.find((value) => value.id === previous) ||
      matchingZone(item, result);
    if (!zone) {
      zone = {
        id: id(),
        name: REFERENCE_ROLES[purposeOf(item)],
        purpose: purposeOf(item),
        slot: result.length,
      };
      result.push(zone);
    }
    item.zone_id = zone.id;
  }
  board.zones = result;
  arrangeQuadrants(result, board.items);
  board.migrated = true;
  return board;
}

function selectOptions(select, choices, value) {
  if (!select) return;
  select.replaceChildren();
  for (const [key, label] of Object.entries(choices)) {
    const option = node("option", "", label);
    option.value = key;
    select.append(option);
  }
  select.value = Object.hasOwn(choices, value)
    ? value
    : Object.keys(choices)[0];
}
function editCard(itemId, fields) {
  const item = state.items.find((value) => value.id === itemId);
  if (!item) return;
  checkpoint();
  if (Object.hasOwn(fields, "role") && item.kind === "image")
    setImageRole(item, fields.role);
  else Object.assign(item, fields);
  if (
    Object.hasOwn(fields, "reference_role") ||
    (item.kind === "text" && Object.hasOwn(fields, "role"))
  ) {
    const zone = zoneOf(item);
    if (!zone || zone.purpose !== zonePurpose(purposeOf(item)))
      placeCardInZone(item, ensurePurposeZone(purposeOf(item)));
  }
  renderBoard();
  markChanged();
}
function addZone(purpose = "general") {
  if (state.zones.length >= MAX_ZONES) {
    toast("最多可创建 100 个固定区域", true);
    return;
  }
  checkpoint();
  const occupied = new Set(state.zones.map((zone) => zone.slot));
  let slot = 4;
  while (occupied.has(slot)) slot++;
  const width = state.zones[0]?.w || 900,
    height = state.zones[0]?.h || 820;
  const zone = {
    id: id(),
    name: REFERENCE_ROLES[purpose],
    purpose,
    slot,
    x: (slot % 2) * width,
    y: Math.floor(slot / 2) * height,
    w: width,
    h: height,
    collapsed: false,
  };
  state.zones.push(zone);
  state.zones.sort((a, b) => a.slot - b.slot);
  renderBoard();
  fitZone(zone.id);
  markChanged();
  editZone(zone.id);
}
function deleteZone(zoneId) {
  const zone = state.zones.find((value) => value.id === zoneId);
  if (!zone || zone.slot < 4) return;
  checkpoint();
  state.zones = state.zones.filter((value) => value.id !== zoneId);
  for (const item of state.items)
    if (item.zone_id === zoneId) item.zone_id = null;
  renderBoard();
  markChanged();
  toast("自定义区域已移除，卡片保留在原位置；可撤销");
}
function organizeBoard() {
  checkpoint();
  for (const item of state.items) {
    const current = zoneOf(item);
    let zone =
      current &&
      (current.purpose === purposeOf(item) ||
        current.purpose === zonePurpose(purposeOf(item)))
        ? current
        : matchingZone(item);
    if (!zone) {
      const occupied = new Set(state.zones.map((value) => value.slot));
      let slot = 4;
      while (occupied.has(slot)) slot++;
      zone = {
        id: id(),
        name: REFERENCE_ROLES[purposeOf(item)],
        purpose: purposeOf(item),
        slot,
      };
      state.zones.push(zone);
    }
    item.zone_id = zone.id;
  }
  state.zones.sort((a, b) => a.slot - b.slot);
  arrangeQuadrants(state.zones, state.items);
  renderBoard();
  const readingZone = state.zones.find((zone) =>
    state.items.some((item) => item.zone_id === zone.id),
  );
  if (readingZone) fitZone(readingZone.id);
  else fitBoard();
  markChanged();
  toast("已按用途在固定象限内排卡，可撤销；Home 查看全部象限");
}
function editZone(zoneId) {
  const zone = state.zones.find((value) => value.id === zoneId);
  if (!zone) return;
  const content = node("div", "quadrant-settings"),
    name = node("input"),
    purpose = node("select");
  name.id = "quadrant-name";
  name.value = zone.name;
  name.maxLength = 2000;
  purpose.id = "quadrant-purpose";
  selectOptions(purpose, REFERENCE_ROLES, zone.purpose);
  const nameLabel = node("label", "field-label", "区域名称");
  nameLabel.htmlFor = name.id;
  const purposeLabel = node("label", "field-label", "落入此区域的默认用途");
  purposeLabel.htmlFor = purpose.id;
  content.append(
    nameLabel,
    name,
    purposeLabel,
    purpose,
    node(
      "p",
      "field-help",
      "区域位置由系统固定。修改用途会同步修改区域内卡片的用途，首尾帧等生成用法保持。",
    ),
  );
  content.append(
    button("保存区域设置", "btn primary", () => {
      checkpoint();
      zone.name = name.value.trim() || REFERENCE_ROLES[purpose.value];
      zone.purpose = purpose.value;
      for (const item of state.items)
        if (item.zone_id === zone.id) setPurpose(item, zone.purpose);
      renderBoard();
      markChanged();
      $("info-dialog").close();
    }),
  );
  if (zone.slot >= 4)
    content.append(
      button("移除此自定义区域", "btn danger", () => {
        deleteZone(zone.id);
        $("info-dialog").close();
      }),
    );
  openInfo("编辑固定区域", content);
}
function renderZones() {
  const nav = $("quadrant-nav");
  nav?.replaceChildren();
  for (const zone of state.zones) {
    const element = node("section", "board-zone fixed-quadrant");
    element.dataset.zoneId = zone.id;
    element.dataset.purpose = zone.purpose;
    element.dataset.slot = zone.slot;
    Object.assign(element.style, {
      left: zone.x + "px",
      top: zone.y + "px",
      width: zone.w + "px",
      height: zone.h + "px",
    });
    const header = node("div", "quadrant-heading");
    header.addEventListener("dblclick", (event) => {
      if (event.target.closest("button")) return;
      event.preventDefault();
      event.stopPropagation();
      fitZone(zone.id);
    });
    const caption = QUADRANTS[zone.slot]?.caption || "自定义素材区域";
    header.append(
      node(
        "span",
        "quadrant-coordinate",
        String(zone.slot + 1).padStart(2, "0"),
      ),
      node("h2", "quadrant-title", zone.name),
      node("span", "quadrant-caption", caption),
    );
    const count = state.items.filter((item) => item.zone_id === zone.id).length;
    header.append(
      node("span", "zone-count", count + " 张素材"),
      iconButton(
        "info",
        "编辑「" + zone.name + "」",
        () => editZone(zone.id),
        "quadrant-edit icon-btn",
      ),
    );
    element.append(header);
    if (!count)
      element.append(
        node("p", "quadrant-empty", "拖入素材，或在这里双击添加文字"),
      );
    world.append(element);
    if (nav) {
      const chip = button(
        "",
        "quadrant-chip" + (state.focusedZone === zone.id ? " active" : ""),
        () => fitZone(zone.id),
      );
      chip.dataset.zoneId = zone.id;
      chip.dataset.purpose = zone.purpose;
      chip.title = "聚焦「" + zone.name + "」；双击编辑区域";
      chip.append(
        node("span", "quadrant-chip-dot"),
        node("span", "", zone.name),
        node("small", "", count),
      );
      chip.addEventListener("dblclick", () => editZone(zone.id));
      nav.append(chip);
    }
  }
}

function toast(message, error = false) {
  $("toast").textContent = message;
  $("toast").className = "toast show" + (error ? " error" : "");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => $("toast").classList.remove("show"), 5000);
}
async function api(path, options = {}) {
  const controller = new AbortController(),
    timer = setTimeout(() => controller.abort(), options.timeout || 30000);
  try {
    const config = { ...options, signal: controller.signal };
    delete config.timeout;
    if (config.body && !(config.body instanceof FormData)) {
      config.headers = {
        "Content-Type": "application/json",
        ...config.headers,
      };
      config.body = JSON.stringify(config.body);
    }
    const res = await fetch(path, config);
    let data;
    try {
      data = await res.json();
    } catch {
      throw new Error("服务未返回有效数据，请稍后重试");
    }
    if (!res.ok || data.ok === false) {
      const error = new Error(data.error || `请求失败（${res.status}）`);
      error.status = res.status;
      error.details = data;
      throw error;
    }
    return data;
  } catch (error) {
    if (error.name === "AbortError")
      throw new Error("服务暂未响应，请稍后刷新确认状态");
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
function report(error) {
  toast(error.message || "操作未完成，请重试", true);
}
function durationText(seconds) {
  if (
    seconds === null ||
    seconds === undefined ||
    !Number.isFinite(Number(seconds))
  )
    return "暂无可靠数据";
  const value = Math.max(0, Math.round(Number(seconds)));
  if (value < 60) return `${value} 秒`;
  if (value < 3600) return `${Math.floor(value / 60)} 分 ${value % 60} 秒`;
  return `${Math.floor(value / 3600)} 小时 ${Math.floor((value % 3600) / 60)} 分`;
}
function fileUrl(file) {
  return "/input/" + String(file).split("/").map(encodeURIComponent).join("/");
}
function outputUrl(output) {
  return (
    "/output/" +
    [output.sub || "", output.name]
      .filter(Boolean)
      .join("/")
      .split("/")
      .map(encodeURIComponent)
      .join("/")
  );
}
function thumbUrl(thumb) {
  return (
    "/library/" + String(thumb).split("/").map(encodeURIComponent).join("/")
  );
}
function recordTitle(record) {
  return (
    record.fields?.scene ||
    record.fields?.extra ||
    record.prompt ||
    "未命名镜头"
  )
    .split("\n")[0]
    .slice(0, 100);
}
function recordDuration(record) {
  const frames = Number(record.frames);
  return Number.isFinite(frames) && frames > 0
    ? `${Number((frames / 24).toFixed(2))} 秒`
    : `${record.duration ?? "—"} 秒`;
}
function recordResolution(record) {
  return Array.isArray(record.resolution)
    ? record.resolution.join(" × ")
    : String(record.resolution || "—").replace(",", " × ");
}
function snapshot() {
  return {
    items: clone(state.items),
    connections: clone(state.connections),
    zones: clone(state.zones),
    params: clone(state.params),
    viewport: { ...state.viewport },
  };
}
function historySnapshot() {
  return {
    board: snapshot(),
    selected: [...state.selectedIds],
    connection: state.selectedConnection,
  };
}
function updateHistoryButtons() {
  $("undo-board").disabled = !state.history.length;
  if ($("redo-board")) $("redo-board").disabled = !state.future.length;
}
function checkpoint(before = historySnapshot()) {
  // Commit an active gesture before starting a separate edit; finishInteraction clears drag first.
  if (drag) finishInteraction(false);
  state.history.push(before);
  if (state.history.length > 80) state.history.shift();
  state.future = [];
  updateHistoryButtons();
}
function restoreHistory(entry) {
  restoreBoard(entry.board);
  state.selectedIds = new Set(
    entry.selected.filter((key) => state.items.some((item) => item.id === key)),
  );
  state.selected = [...state.selectedIds].at(-1) || null;
  state.selectedConnection = state.connections.some(
    (edge) => edge.id === entry.connection,
  )
    ? entry.connection
    : null;
  updateSelection();
  markChanged();
}
function invalidateEstimate() {
  state.estimate = null;
  state.estimateSignature = null;
  $("confirm-expensive").checked = false;
  renderEstimate();
}
function cacheDraft(payload = snapshot(), dirty = state.dirty) {
  localStorage.setItem(
    LOCAL_KEY,
    JSON.stringify({
      ...payload,
      dirty,
      baseRevision: state.boardRevision,
      savedAt: Date.now(),
    }),
  );
}
function flagBoardConflict() {
  state.saveConflict = true;
  $("save-state").textContent = "草稿冲突 · 本地修改已保留";
  if ($("board-conflict")) $("board-conflict").hidden = false;
  try {
    cacheDraft();
  } catch {}
}
function showBoardConflict() {
  const content = node("div");
  content.append(
    node(
      "p",
      "warning",
      "画板已被命令行或其他窗口更新。当前修改仍保留在本机，自动保存已暂停，避免覆盖另一份内容。",
    ),
  );
  content.append(
    button("另存当前草稿 JSON", "btn", () => {
      const url = URL.createObjectURL(
        new Blob([JSON.stringify(snapshot(), null, 2)], {
          type: "application/json",
        }),
      );
      const link = document.createElement("a");
      link.href = url;
      link.download = "lumen-local-draft-" + Date.now() + ".json";
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }),
  );
  content.append(
    button("载入最新画板（当前版本仍可撤销）", "btn primary", async () => {
      try {
        await saveChain.catch(() => {});
        const remote = await api("/api/agent/board");
        checkpoint();
        state.boardRevision = remote.revision;
        state.saveConflict = false;
        state.dirty = false;
        restoreBoard(remote.board);
        $("board-conflict").hidden = true;
        $("save-state").textContent = "草稿已保存";
        cacheDraft(snapshot(), false);
        $("info-dialog").close();
        toast("已载入最新画板；撤销可取回刚才的本地版本");
      } catch (error) {
        report(error);
      }
    }),
  );
  openInfo("画板版本冲突", content);
}
async function refreshBoardRevision() {
  if (
    !state.loaded ||
    state.boardSaving ||
    state.checkingRemote ||
    state.saveConflict ||
    drag
  )
    return;
  state.checkingRemote = true;
  const base = state.boardRevision;
  try {
    const remote = await api("/api/agent/board");
    if (state.boardRevision !== base || state.boardSaving || drag) return;
    if (remote.revision === base) return;
    if (state.dirty) {
      flagBoardConflict();
      toast("检测到另一处画板更新，本地修改已保留", true);
      return;
    }
    state.boardRevision = remote.revision;
    restoreBoard(remote.board);
    cacheDraft(snapshot(), false);
    $("save-state").textContent = "草稿已保存";
    toast("已载入其他操作更新的画板");
  } catch {
  } finally {
    state.checkingRemote = false;
  }
}
function markChanged(invalidate = true) {
  if (!state.loaded) return;
  state.dirty = true;
  state.saveRevision++;
  if (invalidate) invalidateEstimate();
  $("save-state").textContent = state.saveConflict
    ? "草稿冲突 · 本地修改已保留"
    : "正在保存…";
  try {
    cacheDraft();
  } catch {
    $("save-state").textContent = "本机缓存不可用";
  }
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveBoard, 450);
}
async function saveBoard() {
  clearTimeout(saveTimer);
  if (!state.loaded || !state.dirty || state.saveConflict) return saveChain;
  const payload = snapshot(),
    revision = state.saveRevision;
  saveChain = saveChain
    .catch(() => {})
    .then(async () => {
      if (state.saveConflict) return;
      state.boardSaving = true;
      try {
        if (!state.boardRevision) {
          flagBoardConflict();
          return;
        }
        const result = await api("/api/agent/board", {
          method: "PUT",
          body: {
            expected_revision: state.boardRevision,
            request_id: crypto.randomUUID(),
            board: payload,
          },
          keepalive:
            new TextEncoder().encode(JSON.stringify(payload)).byteLength <
            60000,
        });
        state.boardRevision = result.revision;
        // A newer local edit is based on our successful write, even before its
        // own queued save runs. Preserve that base in the recovery draft.
        if (revision !== state.saveRevision) {
          try {
            cacheDraft();
          } catch {}
        }
        if (revision === state.saveRevision) {
          state.dirty = false;
          $("save-state").textContent = "草稿已保存";
          try {
            cacheDraft(payload, false);
          } catch {}
        }
      } catch (error) {
        if (error.status === 409 || error.status === 428) flagBoardConflict();
        else $("save-state").textContent = "离线草稿 · 待同步";
      } finally {
        state.boardSaving = false;
      }
    });
  return saveChain;
}
function normalizeBoard(data, migrate = true) {
  const zoneIds = new Set();
  const zones = (Array.isArray(data.zones) ? data.zones : [])
    .filter((zone) => {
      if (!zone || typeof zone.id !== "string" || zoneIds.has(zone.id))
        return false;
      zoneIds.add(zone.id);
      return true;
    })
    .slice(0, MAX_ZONES)
    .map((zone) => ({
      ...zone,
      id: zone.id,
      name: String(zone.name || "分区"),
      purpose: Object.hasOwn(REFERENCE_ROLES, zone.purpose)
        ? zone.purpose
        : "general",
      x: Number(zone.x) || 0,
      y: Number(zone.y) || 0,
      w: Math.max(380, Number(zone.w) || 420),
      h: Math.max(200, Number(zone.h) || 490),
      collapsed: !!zone.collapsed,
    }));
  const items = (Array.isArray(data.items) ? data.items : [])
    .filter((it) => it && ["text", "image", "video"].includes(it.kind))
    .map((it, index) => ({
      ...it,
      id: typeof it.id === "string" ? it.id : id(),
      role: it.role || (it.kind === "text" ? "scene" : "reference"),
      zone_id: zoneIds.has(it.zone_id) ? it.zone_id : null,
      reference_role: Object.hasOwn(REFERENCE_ROLES, it.reference_role)
        ? it.reference_role
        : "general",
      character_view: Object.hasOwn(CHARACTER_VIEWS, it.character_view)
        ? it.character_view
        : "general",
      notes: typeof it.notes === "string" ? it.notes : "",
      enabled: it.enabled !== false,
      x: Number.isFinite(Number(it.x)) ? Number(it.x) : 40 + (index % 3) * 320,
      y: Number.isFinite(Number(it.y))
        ? Number(it.y)
        : 40 + Math.floor(index / 3) * 250,
      w: Math.max(220, Math.min(900, Number(it.w) || 330)),
      h: Math.max(
        minimumCardHeight(it),
        Math.min(950, Number(it.h) || (it.kind === "text" ? 235 : 280)),
      ),
    }));
  const source = data.viewport || data.view || {};
  const itemIds = new Set(items.map((item) => item.id));
  const edgeIds = new Set();
  const connections = (Array.isArray(data.connections) ? data.connections : [])
    .filter((edge) => {
      if (
        !edge ||
        typeof edge.id !== "string" ||
        edgeIds.has(edge.id) ||
        !itemIds.has(edge.from) ||
        !itemIds.has(edge.to) ||
        edge.from === edge.to
      )
        return false;
      edgeIds.add(edge.id);
      return true;
    })
    .map((edge) => ({
      id: edge.id,
      from: edge.from,
      to: edge.to,
      label: typeof edge.label === "string" ? edge.label : "association",
    }));
  const normal = {
    items,
    connections,
    zones,
    params: {
      ...DEFAULT_PARAMS,
      ...data.params,
      resolution: Array.isArray(data.params?.resolution)
        ? data.params.resolution.join(",")
        : data.params?.resolution || DEFAULT_PARAMS.resolution,
    },
    viewport: {
      zoom: Math.max(0.05, Math.min(2.5, Number(source.zoom) || 1)),
      panX: Number(source.panX) || 0,
      panY: Number(source.panY) || 0,
    },
  };
  return migrate ? prepareQuadrants(normal) : normal;
}

function restoreBoard(data, fit = false) {
  const normal = normalizeBoard(data);
  state.items = normal.items;
  state.connections = normal.connections;
  state.zones = normal.zones;
  state.migrated = !!normal.migrated;
  state.params = normal.params;
  state.viewport = normal.viewport;
  state.selected = null;
  state.selectedIds.clear();
  state.selectedConnection = null;
  state.linkSource = null;
  state.linkMode = false;
  renderParams();
  renderBoard();
  applyView();
  renderSelection();
  requestAnimationFrame(() => {
    if (fit) fitBoard();
    else clearToolbarOverlap();
  });
  invalidateEstimate();
}
async function loadBoard() {
  let data = null,
    local = null;
  try {
    const cached = localStorage.getItem(LOCAL_KEY);
    if (cached) local = JSON.parse(cached);
    if (!local) {
      for (const key of [
        "lumen-board",
        "lumen_board",
        "lumen-board-v1",
        "lumen-board-state",
      ]) {
        const value = localStorage.getItem(key);
        if (value) {
          const previous = JSON.parse(value);
          if (Array.isArray(previous.items)) {
            local = previous;
            break;
          }
        }
      }
    }
  } catch {}
  try {
    const remote = await api("/api/agent/board");
    state.boardRevision = remote.revision;
    data = remote.board;
    if (local?.dirty) {
      if (local.baseRevision !== remote.revision) state.saveConflict = true;
      state.boardRevision = local.baseRevision || null;
      data = local;
      toast("已恢复上次关闭前尚未同步的草稿");
    } else if ((!data || !Array.isArray(data.items)) && local) data = local;
    $("save-state").textContent = "草稿已保存";
  } catch {
    data = local || { items: [], params: DEFAULT_PARAMS };
    state.boardRevision = local?.baseRevision || null;
    $("save-state").textContent = "离线草稿 · 待同步";
  }
  restoreBoard(data || { items: [] });
  state.loaded = true;
  if (state.migrated) {
    markChanged();
    toast("旧画板已迁入固定象限，素材用途与连线已保留");
  }
  if (!state.items.length && !state.zones.length) {
    state.zones = defaultZones();
    renderBoard();
    fitBoard();
    markChanged();
  }
  requestAnimationFrame(() => {
    if (state.migrated) {
      const first = state.zones.find((zone) =>
        state.items.some((item) => item.zone_id === zone.id),
      );
      if (first) fitZone(first.id);
      else fitBoard();
      return;
    }
    const area = canvas.getBoundingClientRect();
    const visible = [...world.querySelectorAll(".board-card")].some((card) => {
      const box = card.getBoundingClientRect();
      return (
        Math.min(box.right, area.right) - Math.max(box.left, area.left) > 80 &&
        Math.min(box.bottom, area.bottom) - Math.max(box.top, area.top) > 80
      );
    });
    if (
      state.items.length &&
      (!Number((data.viewport || data.view || {}).zoom) || !visible)
    )
      fitBoard();
    else clearToolbarOverlap();
  });
  if (local?.dirty || !Array.isArray(data?.items)) {
    state.dirty = true;
    saveBoard();
  }
  if (state.saveConflict) flagBoardConflict();
}
function setPage(page) {
  closeContextMenu();
  cancelInteraction();
  state.page = page;
  document
    .querySelectorAll(".page")
    .forEach((el) => (el.hidden = el.id !== "page-" + page));
  document.querySelectorAll("[data-page]").forEach((el) => {
    const active = el.dataset.page === page;
    el.classList.toggle("active", active);
    if (active) el.setAttribute("aria-current", "page");
    else el.removeAttribute("aria-current");
  });
  if (page === "library") renderLibrary();
  if (page === "tasks") renderTasks();
}
function screenToWorld(clientX, clientY) {
  const rect = canvas.getBoundingClientRect();
  return {
    x: (clientX - rect.left - state.viewport.panX) / state.viewport.zoom,
    y: (clientY - rect.top - state.viewport.panY) / state.viewport.zoom,
  };
}
function applyView() {
  const view = state.viewport;
  world.classList.toggle("quadrant-map", view.zoom < 0.45);
  world.style.setProperty("--inverse-zoom", String(1 / view.zoom));
  world.style.transform = `translate(${view.panX}px,${view.panY}px) scale(${view.zoom})`;
  $("zoom-label").textContent = Math.round(view.zoom * 100) + "%";
  // Keep overview dots legible instead of collapsing into a dense texture.
  let gridSpacing = 28 * view.zoom;
  while (gridSpacing < 18) gridSpacing *= 2;
  canvas.style.backgroundSize = `${gridSpacing}px ${gridSpacing}px`;
  canvas.style.backgroundPosition = `${view.panX}px ${view.panY}px`;
}
function clearToolbarOverlap() {
  if (!state.loaded || state.page !== "board" || drag) return;
  const toolbar = document
    .querySelector(".board-toolbar")
    ?.getBoundingClientRect();
  const area = canvas.getBoundingClientRect();
  if (!toolbar || !area.width) return;
  const obscured = [...world.querySelectorAll(".card-head,.quadrant-heading")]
    .map((element) => element.getBoundingClientRect())
    .filter(
      (box) =>
        box.bottom > Math.max(area.top, toolbar.top) &&
        box.top < toolbar.bottom + 12 &&
        box.right > toolbar.left &&
        box.left < toolbar.right,
    );
  if (!obscured.length) return;
  state.viewport.panY +=
    toolbar.bottom + 24 - Math.min(...obscured.map((box) => box.top));
  applyView();
  markChanged(false);
}
function zoomTo(value, clientX, clientY) {
  const rect = canvas.getBoundingClientRect(),
    x = clientX ?? rect.left + rect.width / 2,
    y = clientY ?? rect.top + rect.height / 2,
    point = screenToWorld(x, y);
  state.viewport.zoom = Math.max(0.05, Math.min(2.5, value));
  state.viewport.panX = x - rect.left - point.x * state.viewport.zoom;
  state.viewport.panY = y - rect.top - point.y * state.viewport.zoom;
  applyView();
  markChanged(false);
}
function fitZone(zoneId) {
  const zone = state.zones.find((value) => value.id === zoneId);
  if (!zone) return;
  finishInteraction(false);
  const members = state.items.filter((item) => item.zone_id === zone.id);
  fitBoard(
    false,
    members.length
      ? members
      : [{ x: zone.x + 24, y: zone.y + 24, w: 760, h: 550 }],
  );
  state.focusedZone = zone.id;
  document
    .querySelectorAll(".quadrant-chip")
    .forEach((chip) =>
      chip.classList.toggle("active", chip.dataset.zoneId === zone.id),
    );
}

function fitBoard(selectedOnly = false, bounds = null) {
  state.focusedZone = null;
  let unfolded = false;
  if (selectedOnly)
    for (const item of state.items.filter((value) =>
      state.selectedIds.has(value.id),
    )) {
      const zone = zoneOf(item);
      if (zone?.collapsed) {
        zone.collapsed = false;
        unfolded = true;
      }
    }
  if (unfolded) renderBoard();
  const items =
    bounds ||
    (selectedOnly
      ? state.items.filter((item) => state.selectedIds.has(item.id))
      : [
          ...state.items.filter(itemVisible),
          ...state.zones.map((zone) => ({
            ...zone,
            h: zone.collapsed ? 72 : zone.h,
          })),
        ]);
  if (!items.length) {
    if (selectedOnly) {
      toast("先选中需要聚焦的卡片");
      return;
    }
    state.viewport = { zoom: 1, panX: 0, panY: 0 };
    applyView();
    markChanged(false);
    return;
  }
  const left = Math.min(...items.map((item) => item.x)),
    top = Math.min(...items.map((item) => item.y));
  const right = Math.max(...items.map((item) => item.x + item.w)),
    bottom = Math.max(...items.map((item) => item.y + item.h));
  const rect = canvas.getBoundingClientRect();
  const toolbar = document
    .querySelector(".board-toolbar")
    ?.getBoundingClientRect();
  const topInset = Math.max(40, (toolbar?.bottom || rect.top) - rect.top + 24);
  const zoom = Math.max(
    0.05,
    Math.min(
      1,
      Math.max(80, rect.width - 90) / (right - left),
      Math.max(80, rect.height - topInset - 55) / (bottom - top),
    ),
  );
  state.viewport = {
    zoom,
    panX: (rect.width - (right - left) * zoom) / 2 - left * zoom,
    panY:
      topInset +
      (rect.height - topInset - 45 - (bottom - top) * zoom) / 2 -
      top * zoom,
  };
  applyView();
  markChanged(false);
}
function newPosition() {
  const rect = canvas.getBoundingClientRect(),
    point = screenToWorld(
      rect.left + rect.width / 2,
      Math.max(
        rect.top + rect.height / 2,
        (document.querySelector(".board-toolbar")?.getBoundingClientRect()
          .bottom || rect.top) + 160,
      ),
    );
  return { x: Math.round(point.x - 160), y: Math.round(point.y - 110) };
}
function icon(name) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.classList.add("icon");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  const use = document.createElementNS(svg.namespaceURI, "use");
  use.setAttribute("href", "#icon-" + name);
  svg.append(use);
  return svg;
}
function iconButton(name, label, handler, className = "icon-btn") {
  const control = button("", className, handler);
  control.append(icon(name));
  control.title = label;
  control.setAttribute("aria-label", label);
  return control;
}
function editable(target) {
  return (
    target instanceof Element &&
    !!target.closest(
      "input,textarea,select,[contenteditable=true],[contenteditable='']",
    )
  );
}
function editorAvailable(target) {
  return (
    state.page === "board" &&
    !editable(target) &&
    !document.querySelector("dialog[open]")
  );
}
function addText(role = "scene", content = "", position = null) {
  if (state.items.length >= MAX_ITEMS) {
    toast("画板最多支持 100 张卡片", true);
    return;
  }
  checkpoint();
  const item = {
    id: id(),
    kind: "text",
    role,
    content,
    ...(position || newPosition()),
    w: 330,
    h: 235,
  };
  state.items.push(item);
  assignToZone(
    item,
    zoneAt({ x: item.x + item.w / 2, y: item.y + item.h / 2 }),
  );
  state.selectedIds = new Set([item.id]);
  state.selected = item.id;
  state.selectedConnection = null;
  renderBoard();
  renderSelection();
  markChanged();
  world.querySelector(`[data-id="${CSS.escape(item.id)}"] textarea`)?.focus();
}
function effectiveImageRole(item) {
  if (item.kind !== "image") return "reference";
  if (
    [
      "first_frame",
      "last_frame",
      "middle_frame_1",
      "middle_frame_2",
      "middle_frame_3",
    ].includes(item.role)
  )
    return item.role;
  if (item.role !== "auto") return "reference";
  const missing = ["first_frame", "last_frame"].filter(
    (role) =>
      !state.items.some(
        (card) =>
          card.kind === "image" && card.enabled !== false && card.role === role,
      ),
  );
  const index = state.items
    .filter(
      (card) =>
        card.kind === "image" && card.enabled !== false && card.role === "auto",
    )
    .findIndex((card) => card.id === item.id);
  return missing[index] || "reference";
}
function roleLabel(item) {
  if (item.kind === "text") return TEXT_ROLES[item.role] || "补充描述";
  if (item.kind === "video") return "参考视频";
  const labels = {
    first_frame: "首帧",
    last_frame: "尾帧",
    reference: "参考图片",
    middle_frame_1: "中间帧 · 25%",
    middle_frame_2: "中间帧 · 50%",
    middle_frame_3: "中间帧 · 75%",
  };
  return item.role === "auto"
    ? "自动 · " + (labels[effectiveImageRole(item)] || "参考资料")
    : labels[item.role] || "参考图片";
}
function updateSelection() {
  state.selected = state.selectedIds.has(state.selected)
    ? state.selected
    : [...state.selectedIds].at(-1) || null;
  world.querySelectorAll(".board-card").forEach((card) => {
    const selected = state.selectedIds.has(card.dataset.id);
    card.classList.toggle("selected", selected);
    card.setAttribute("aria-selected", String(selected));
  });
  canvas.classList.toggle("linking", state.linkMode || !!state.linkSource);
  if ($("connect-cards")) {
    $("connect-cards").classList.toggle(
      "active",
      state.linkMode || !!state.linkSource,
    );
    $("connect-cards").setAttribute(
      "aria-pressed",
      String(state.linkMode || !!state.linkSource),
    );
  }
  if ($("selection-count")) {
    $("selection-count").hidden =
      !state.selectedIds.size && !state.selectedConnection;
    $("selection-count").textContent = state.selectedConnection
      ? "已选中 1 条连线"
      : `已选中 ${state.selectedIds.size} 张`;
  }
  renderConnections();
  renderSelection();
}
function selectCard(itemId, toggle = false) {
  state.selectedConnection = null;
  if (!itemId) state.selectedIds.clear();
  else if (toggle) {
    if (state.selectedIds.has(itemId)) state.selectedIds.delete(itemId);
    else state.selectedIds.add(itemId);
  } else state.selectedIds = new Set([itemId]);
  state.selected = state.selectedIds.has(itemId)
    ? itemId
    : [...state.selectedIds].at(-1) || null;
  updateSelection();
}
function selectConnection(edgeId) {
  state.selectedIds.clear();
  state.selected = null;
  state.selectedConnection = edgeId;
  state.linkSource = null;
  state.linkMode = false;
  updateSelection();
  canvas.focus({ preventScroll: true });
}
function removeCards(ids) {
  const targets = new Set(ids);
  if (!state.items.some((item) => targets.has(item.id))) return;
  checkpoint();
  state.items = state.items.filter((item) => !targets.has(item.id));
  state.connections = state.connections.filter(
    (edge) => !targets.has(edge.from) && !targets.has(edge.to),
  );
  state.selectedIds.clear();
  state.selected = null;
  state.selectedConnection = null;
  state.linkSource = null;
  renderBoard();
  renderSelection();
  markChanged();
}
function removeCard(itemId) {
  removeCards([itemId]);
}
function deleteSelection() {
  if (state.selectedConnection) deleteConnection(state.selectedConnection);
  else removeCards([...state.selectedIds]);
}
function setImageRole(item, role) {
  if (
    [
      "first_frame",
      "last_frame",
      "middle_frame_1",
      "middle_frame_2",
      "middle_frame_3",
    ].includes(role)
  )
    state.items.forEach((other) => {
      if (other.id !== item.id && other.kind === "image" && other.role === role)
        other.role = "reference";
    });
  item.role = role;
}
function moveCardElements() {
  for (const item of state.items) {
    const card = world.querySelector(`[data-id="${CSS.escape(item.id)}"]`);
    if (card)
      Object.assign(card.style, {
        left: item.x + "px",
        top: item.y + "px",
        width: item.w + "px",
        height: item.h + "px",
      });
  }
  renderConnections();
}
function cardClassification(item) {
  const fields = node("div", "card-classification");
  const purpose = node(
    "select",
    item.kind === "text" ? "card-role-select" : "card-reference-role",
  );
  purpose.setAttribute(
    "aria-label",
    item.kind === "text" ? "文字用途" : "参考用途",
  );
  selectOptions(
    purpose,
    item.kind === "text" ? TEXT_ROLES : REFERENCE_ROLES,
    item.kind === "text" ? item.role : purposeOf(item),
  );
  purpose.addEventListener("change", () => {
    selectCard(item.id);
    editCard(item.id, {
      [item.kind === "text" ? "role" : "reference_role"]: purpose.value,
    });
  });
  fields.append(purpose);
  if (item.kind === "image") {
    const usage = node("select", "card-generation-role");
    usage.setAttribute("aria-label", "生成用法");
    selectOptions(usage, IMAGE_ROLES, item.role);
    usage.addEventListener("change", () => {
      selectCard(item.id);
      editCard(item.id, { role: usage.value });
    });
    fields.append(usage);
  }
  if (item.kind !== "text" && purposeOf(item) === "character") {
    const view = node("select", "card-character-view");
    view.setAttribute("aria-label", "人物视角");
    selectOptions(view, CHARACTER_VIEWS, item.character_view || "general");
    view.addEventListener("change", () => {
      selectCard(item.id);
      editCard(item.id, { character_view: view.value });
    });
    fields.append(view);
  }
  const zone = zoneOf(item);
  fields.append(
    node("span", "card-zone-name", zone ? "分区 · " + zone.name : "未分区"),
  );
  const enabled = node("label", "card-enabled"),
    toggle = node("input");
  toggle.type = "checkbox";
  toggle.checked = item.enabled !== false;
  toggle.setAttribute("aria-label", "参与生成");
  toggle.addEventListener("change", () => {
    selectCard(item.id);
    editCard(item.id, { enabled: toggle.checked });
  });
  enabled.append(toggle, document.createTextNode("参与生成"));
  fields.append(enabled);
  return fields;
}
function renderBoard() {
  world.replaceChildren();
  renderZones();
  renderConnections();
  state.items.forEach((item, index) => {
    if (!itemVisible(item)) return;
    const card = node(
      "article",
      "board-card" +
        (state.selectedIds.has(item.id) ? " selected" : "") +
        (item.enabled === false ? " disabled-input" : ""),
    );
    card.dataset.id = item.id;
    card.tabIndex = 0;
    card.setAttribute("aria-label", `${roleLabel(item)}卡片 ${index + 1}`);
    card.setAttribute("aria-selected", String(state.selectedIds.has(item.id)));
    Object.assign(card.style, {
      left: item.x + "px",
      top: item.y + "px",
      width: item.w + "px",
      height: item.h + "px",
    });
    const head = node("div", "card-head");
    head.append(
      node("span", "card-index", String(index + 1).padStart(2, "0")),
      node("span", "card-role", item.preset_name || roleLabel(item)),
      node(
        "span",
        "card-kind",
        item.kind === "text" ? "文字" : item.kind === "image" ? "图片" : "视频",
      ),
      iconButton("close", "移除此卡片", () => removeCard(item.id)),
    );
    card.append(head, cardClassification(item));
    if (item.kind === "text") {
      const input = node("textarea");
      input.value = item.content || "";
      input.placeholder =
        item.role === "scene"
          ? "描述主体、场景和动作…\n例如：海边灯塔，黄昏中海浪缓缓翻涌。"
          : "写下" + (TEXT_ROLES[item.role] || "补充描述") + "…";
      input.setAttribute("aria-label", roleLabel(item));
      let editingSnapshot = null;
      input.addEventListener("focus", () => {
        if (!state.selectedIds.has(item.id)) selectCard(item.id);
        editingSnapshot = historySnapshot();
      });
      input.addEventListener("input", () => {
        if (editingSnapshot) {
          checkpoint(editingSnapshot);
          editingSnapshot = null;
        } else {
          state.future = [];
          updateHistoryButtons();
        }
        item.content = input.value;
        markChanged();
      });
      card.append(input);
    } else {
      const media = node(item.kind === "image" ? "img" : "video", "card-media");
      media.src = fileUrl(item.file);
      if (item.kind === "image") {
        media.alt = roleLabel(item);
        media.draggable = false;
        media.addEventListener("dblclick", (event) => {
          event.preventDefault();
          event.stopPropagation();
          finishInteraction(false);
          selectCard(item.id);
          showImagePreview(item);
        });
      } else {
        media.controls = true;
        media.preload = "metadata";
        media.muted = true;
      }
      card.append(media);
      card.append(
        node(
          "div",
          "card-caption",
          effectiveImageRole(item) === "reference" || item.kind === "video"
            ? "Ref2VA 参考 · " + REFERENCE_ROLES[purposeOf(item)]
            : "FL2VA 帧引导 · " + roleLabel(item),
        ),
      );
      if (item.kind === "video")
        card.append(
          node(
            "div",
            "card-video-range",
            `选用 ${Number(item.video_start || 0).toFixed(1)} 秒起 · ${Number(item.video_duration ?? 2).toFixed(1)} 秒 · ${item.include_audio === false ? "不使用音轨" : "包含音轨（如有）"}`,
          ),
        );
      if (item.notes) card.append(node("p", "card-notes", item.notes));
    }
    const resize = node("div", "resize-handle");
    resize.title = "拖动调整卡片大小";
    resize.setAttribute("aria-hidden", "true");
    card.append(resize);
    for (const side of ["in", "out"]) {
      const port = button("", "card-port " + side, (event) => {
        event.stopPropagation();
        if (port._ignoreClick) {
          port._ignoreClick = false;
          return;
        }
        connectionClick(item.id);
      });
      port.title =
        side === "out" ? "拖动连接，或点击后选择目标卡片" : "连接到此卡片";
      port.setAttribute("aria-label", `${roleLabel(item)}：${port.title}`);
      port.dataset.cardId = item.id;
      port.append(node("span", "port-handle"));
      port.addEventListener("pointerdown", (event) => {
        if (event.button !== 0 || spacePressed) return;
        event.preventDefault();
        event.stopPropagation();
        if (state.linkSource && state.linkSource !== item.id) {
          createConnection(state.linkSource, item.id);
          port._ignoreClick = true;
          setTimeout(() => {
            port._ignoreClick = false;
          }, 0);
          return;
        }
        state.linkSource = item.id;
        state.linkMode = true;
        drag = {
          kind: "connection",
          source: item.id,
          pointerId: event.pointerId,
          startClientX: event.clientX,
          startClientY: event.clientY,
          x: item.x + item.w,
          y: item.y + item.h / 2,
          moved: false,
          port,
        };
        canvas.setPointerCapture(event.pointerId);
        updateSelection();
      });
      card.append(port);
    }
    card.addEventListener("focus", () => {
      if (!state.selectedIds.has(item.id)) selectCard(item.id);
    });
    card.addEventListener("pointerdown", (event) => {
      if (
        event.button !== 0 ||
        spacePressed ||
        event.target.closest("button,input,select,textarea,video")
      )
        return;
      event.stopPropagation();
      event.preventDefault();
      closeContextMenu();
      if (state.linkMode) {
        connectionClick(item.id);
        return;
      }
      if (event.shiftKey) selectCard(item.id, true);
      else if (!state.selectedIds.has(item.id)) selectCard(item.id);
      if (!state.selectedIds.has(item.id)) {
        canvas.focus({ preventScroll: true });
        return;
      }
      card.focus({ preventScroll: true });
      const point = screenToWorld(event.clientX, event.clientY);
      drag = {
        kind: event.target === resize ? "resize" : "cards",
        pointerId: event.pointerId,
        before: historySnapshot(),
        itemId: item.id,
        startX: point.x,
        startY: point.y,
        originals: state.items
          .filter((value) => state.selectedIds.has(value.id))
          .map((value) => ({
            id: value.id,
            x: value.x,
            y: value.y,
            w: value.w,
            h: value.h,
          })),
        moved: false,
      };
      // Capture only after movement. Capturing a click retargets dblclick to
      // the canvas and would create a text card instead of opening the image.
    });
    world.append(card);
  });
  $("board-empty").hidden = state.items.length > 0;
  $("board-item-count").textContent =
    `${state.items.length} 张卡片 · ${state.zones.length} 个分区 · ${state.connections.length} 条连线`;
  updateSelection();
}
function renderSelection() {
  const item = state.items.find((value) => value.id === state.selected);
  const edge = state.connections.find(
    (value) => value.id === state.selectedConnection,
  );
  const multiple = state.selectedIds.size > 1;
  document.querySelector(".selection-block").hidden = !item;
  $("selection-empty").hidden = !!item;
  $("selection-tools").hidden = !item;
  $("selected-kind").textContent = multiple
    ? `${state.selectedIds.size} 张卡片`
    : item
      ? roleLabel(item)
      : "—";
  if ($("connection-tools")) $("connection-tools").hidden = !edge;
  if ($("save-reference-preset"))
    $("save-reference-preset").disabled = !state.selectedIds.size;
  if (edge && $("connection-label"))
    selectOptions(
      $("connection-label"),
      {
        ...CONNECTION_LABELS,
        ...(Object.hasOwn(CONNECTION_LABELS, edge.label)
          ? {}
          : { [edge.label]: edge.label }),
      },
      edge.label,
    );
  if (!item) return;
  if ($("storyboard-fields"))
    $("storyboard-fields").hidden = purposeOf(item) !== "storyboard";
  if ($("selected-shot-order")) {
    $("selected-shot-order").value = item.shot_order ?? "";
    $("selected-shot-order").disabled = multiple;
  }
  if ($("selected-enabled")) {
    $("selected-enabled").checked = item.enabled !== false;
    $("selected-enabled").indeterminate =
      multiple &&
      state.items
        .filter((value) => state.selectedIds.has(value.id))
        .some(
          (value) => (value.enabled !== false) !== (item.enabled !== false),
        );
  }
  const choices =
    item.kind === "text"
      ? TEXT_ROLES
      : item.kind === "image"
        ? IMAGE_ROLES
        : { reference: "多模态参考 · Ref2VA" };
  selectOptions($("selected-role"), choices, item.role);
  $("selected-role").disabled = multiple;
  selectOptions(
    $("selected-zone"),
    {
      "": "未分区",
      ...Object.fromEntries(
        state.zones.map((zone) => [
          zone.id,
          zone.name + " · " + REFERENCE_ROLES[zone.purpose],
        ]),
      ),
    },
    item.zone_id || "",
  );
  if ($("selected-zone")) $("selected-zone").disabled = multiple;
  if ($("reference-fields"))
    $("reference-fields").hidden = item.kind === "text";
  selectOptions($("selected-reference-role"), REFERENCE_ROLES, purposeOf(item));
  if ($("selected-reference-role"))
    $("selected-reference-role").disabled = multiple;
  if ($("character-view-field"))
    $("character-view-field").hidden =
      item.kind === "text" || purposeOf(item) !== "character";
  selectOptions(
    $("selected-character-view"),
    CHARACTER_VIEWS,
    item.character_view || "general",
  );
  if ($("selected-character-view"))
    $("selected-character-view").disabled = multiple;
  if ($("selected-notes")) {
    $("selected-notes").value = item.notes || "";
    $("selected-notes").disabled = multiple;
  }
  if ($("video-fields")) $("video-fields").hidden = item.kind !== "video";
  if (item.kind === "video") {
    if ($("video-start")) $("video-start").value = item.video_start || 0;
    if ($("video-duration"))
      $("video-duration").value = item.video_duration ?? 2;
    if ($("video-include-audio"))
      $("video-include-audio").checked = item.include_audio !== false;
  }
  for (const key of ["video-start", "video-duration", "video-include-audio"])
    if ($(key)) $(key).disabled = multiple;
  $("selected-help").textContent = multiple
    ? "可一起移动、复制、剪切或删除；复制保留内部连线、用途和分区。单选后可修改素材属性。"
    : item.kind === "text"
      ? "文字用途决定提示词中的位置。分区和关系线会编入生成描述，可在「实际送入 H3」中检查。"
      : purposeOf(item) === "character"
        ? "标记此素材实际包含的人物视角，并在说明中写明身份与需要保持的特征。不会自动补齐缺少的视角。"
        : item.kind === "video"
          ? "参考视频由 Ref2VA 读取。截取范围、有效帧数和是否包含音频以生成前预览为准。"
          : effectiveImageRole(item) === "reference"
            ? "此图作为 Ref2VA 参考输入。用途与说明会编入提示词；需本地对应模型就绪。"
            : "此图用于 FL2VA 帧引导；首尾与中间帧不能和 Ref2VA 参考混合。实际帧位置以生成前预览为准。";
}

function svgNode(tag, attributes = {}) {
  const element = document.createElementNS("http://www.w3.org/2000/svg", tag);
  Object.entries(attributes).forEach(([key, value]) =>
    element.setAttribute(key, String(value)),
  );
  return element;
}
function connectionGeometry(from, to) {
  const forward = to.x + to.w / 2 >= from.x + from.w / 2;
  const start = {
      x: forward ? from.x + from.w : from.x,
      y: from.y + from.h / 2,
    },
    end = { x: forward ? to.x : to.x + to.w, y: to.y + to.h / 2 };
  const bend = Math.max(65, Math.abs(end.x - start.x) * 0.45),
    direction = forward ? 1 : -1;
  return {
    d: `M ${start.x} ${start.y} C ${start.x + bend * direction} ${start.y}, ${end.x - bend * direction} ${end.y}, ${end.x} ${end.y}`,
    x: (start.x + end.x) / 2,
    y: (start.y + end.y) / 2 - 9,
  };
}
function renderConnections() {
  let layer = $("connections-layer");
  if (!layer) {
    layer = svgNode("svg", {
      id: "connections-layer",
      class: "connections-layer",
      width: "1",
      height: "1",
      "aria-label": "卡片生成关系",
    });
    world.prepend(layer);
  }
  layer.replaceChildren();
  const defs = svgNode("defs"),
    marker = svgNode("marker", {
      id: "connection-arrow",
      viewBox: "0 0 10 10",
      refX: 9,
      refY: 5,
      markerWidth: 6,
      markerHeight: 6,
      orient: "auto-start-reverse",
    });
  marker.append(
    svgNode("path", { d: "M 0 0 L 10 5 L 0 10 z", fill: "context-stroke" }),
  );
  defs.append(marker);
  layer.append(defs);
  const items = new Map(state.items.map((item) => [item.id, item]));
  state.connections.forEach((edge) => {
    const from = items.get(edge.from),
      to = items.get(edge.to);
    if (!from || !to || !itemVisible(from) || !itemVisible(to)) return;
    const label = CONNECTION_LABELS[edge.label] || edge.label || "关联",
      geometry = connectionGeometry(from, to);
    const group = svgNode("g", {
      class:
        "connection" +
        (state.selectedConnection === edge.id ? " selected" : ""),
      "data-connection-id": edge.id,
      tabindex: 0,
      role: "button",
      "aria-label": `${roleLabel(from)} → ${roleLabel(to)}：${label}，生成关系`,
    });
    const title = svgNode("title");
    title.textContent = label;
    group.append(
      title,
      svgNode("path", {
        class: "connection-hit",
        d: geometry.d,
        fill: "none",
        stroke: "transparent",
        "stroke-width": 18,
        "pointer-events": "stroke",
      }),
      svgNode("path", {
        class: "connection-path",
        d: geometry.d,
        fill: "none",
        "vector-effect": "non-scaling-stroke",
        "marker-end": "url(#connection-arrow)",
      }),
    );
    const text = svgNode("text", {
      class: "connection-label",
      x: geometry.x,
      y: geometry.y,
      "text-anchor": "middle",
    });
    text.textContent = label.length > 20 ? label.slice(0, 19) + "…" : label;
    group.append(text);
    group.addEventListener("pointerdown", (event) => {
      if (spacePressed || event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();
      selectConnection(edge.id);
      canvas.focus({ preventScroll: true });
    });
    group.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        event.stopPropagation();
        selectConnection(edge.id);
        $("connection-label")?.focus();
      }
    });
    layer.append(group);
  });
  if (drag?.kind === "connection") {
    const source = items.get(drag.source);
    if (source)
      layer.append(
        svgNode("path", {
          class: "connection-preview",
          d: connectionGeometry(source, { x: drag.x, y: drag.y, w: 0, h: 0 }).d,
          fill: "none",
          "vector-effect": "non-scaling-stroke",
          "pointer-events": "none",
        }),
      );
  }
}
function createConnection(from, to, label = "association") {
  if (state.connections.length >= 1000) {
    toast("画板最多支持 1000 条连线", true);
    return false;
  }
  if (
    from === to ||
    !state.items.some((item) => item.id === from) ||
    !state.items.some((item) => item.id === to)
  )
    return false;
  const existing = state.connections.find(
    (edge) => edge.from === from && edge.to === to && edge.label === label,
  );
  if (existing) {
    selectConnection(existing.id);
    toast("这两张卡片已有相同连线");
    return false;
  }
  checkpoint();
  const edge = { id: id(), from, to, label };
  state.connections.push(edge);
  state.linkSource = null;
  state.linkMode = false;
  selectConnection(edge.id);
  markChanged();
  $("board-item-count").textContent =
    `${state.items.length} 张卡片 · ${state.zones.length} 个分区 · ${state.connections.length} 条连线`;
  return true;
}
function deleteConnection(edgeId) {
  if (!state.connections.some((edge) => edge.id === edgeId)) return;
  checkpoint();
  state.connections = state.connections.filter((edge) => edge.id !== edgeId);
  state.selectedConnection = null;
  updateSelection();
  markChanged();
  $("board-item-count").textContent =
    `${state.items.length} 张卡片 · ${state.zones.length} 个分区 · ${state.connections.length} 条连线`;
}
function connectionClick(itemId) {
  canvas.focus({ preventScroll: true });
  if (state.linkSource && state.linkSource !== itemId) {
    createConnection(state.linkSource, itemId);
    return;
  }
  state.linkSource = itemId;
  state.linkMode = true;
  updateSelection();
  toast("选择另一张卡片建立生成关系；Esc 退出");
}
function toggleConnectionMode() {
  if (state.linkMode || state.linkSource) {
    state.linkMode = false;
    state.linkSource = null;
    updateSelection();
    return;
  }
  if (state.selectedIds.size === 2) {
    const [from, to] = [...state.selectedIds];
    createConnection(from, to);
    return;
  }
  state.linkSource =
    state.selectedIds.size === 1 ? [...state.selectedIds][0] : null;
  state.linkMode = true;
  updateSelection();
  toast(
    state.linkSource
      ? "选择目标卡片；连线关系会写入提示词"
      : "依次选择两张卡片；Esc 退出",
  );
}
function clipboardPayload() {
  const items = state.items.filter((item) => state.selectedIds.has(item.id));
  if (items.length)
    return {
      type: "lumen-board",
      version: 1,
      items: clone(items),
      zones: clone(
        state.zones.filter((zone) =>
          items.some((item) => item.zone_id === zone.id),
        ),
      ),
      connections: clone(
        state.connections.filter(
          (edge) =>
            state.selectedIds.has(edge.from) && state.selectedIds.has(edge.to),
        ),
      ),
    };
  const edge = state.connections.find(
    (value) => value.id === state.selectedConnection,
  );
  return edge
    ? { type: "lumen-board", version: 1, items: [], connections: [clone(edge)] }
    : null;
}
function parseClipboard(text) {
  if (!text?.startsWith(CLIPBOARD_PREFIX)) return null;
  try {
    const data = JSON.parse(text.slice(CLIPBOARD_PREFIX.length));
    return data?.type === "lumen-board" &&
      data.version === 1 &&
      Array.isArray(data.items) &&
      Array.isArray(data.connections)
      ? data
      : null;
  } catch {
    return null;
  }
}
async function copySelection(cut = false) {
  const payload = clipboardPayload();
  if (!payload) {
    toast("先选中卡片或连线");
    return;
  }
  internalClipboard = payload;
  pasteCount = 0;
  const cutIds = [...state.selectedIds],
    cutEdge = state.selectedConnection;
  let systemCopied = true;
  try {
    await navigator.clipboard.writeText(
      CLIPBOARD_PREFIX + JSON.stringify(payload),
    );
  } catch {
    systemCopied = false;
  }
  clipboardFallback = !systemCopied;
  if (cut) {
    if (cutEdge) deleteConnection(cutEdge);
    else removeCards(cutIds);
  }
  toast(
    systemCopied
      ? cut
        ? "已剪切，可粘贴到画板"
        : "已复制，内部连线一起保留"
      : "已复制到画板剪贴板，请右键选择粘贴",
  );
}
function pastePayload(payload, position = null) {
  if (
    !payload ||
    !Array.isArray(payload.items) ||
    !Array.isArray(payload.connections)
  )
    return false;
  const rawItems = payload.items.filter(
    (item) => item && ["text", "image", "video"].includes(item.kind),
  );
  if (!rawItems.length) {
    const valid = payload.connections.filter(
      (edge) =>
        edge &&
        state.items.some((item) => item.id === edge.from) &&
        state.items.some((item) => item.id === edge.to) &&
        edge.from !== edge.to &&
        !state.connections.some(
          (existing) =>
            existing.from === edge.from &&
            existing.to === edge.to &&
            existing.label === edge.label,
        ),
    );
    if (!valid.length) {
      toast("连线端点不存在，或相同连线已经存在");
      return false;
    }
    if (valid.length + state.connections.length > 1000) {
      toast("画板最多支持 1000 条连线", true);
      return false;
    }
    checkpoint();
    const edges = valid.map((edge) => ({
      id: id(),
      from: edge.from,
      to: edge.to,
      label: String(edge.label || "association"),
    }));
    state.connections.push(...edges);
    selectConnection(edges.at(-1).id);
    markChanged();
    return true;
  }
  if (rawItems.length + state.items.length > MAX_ITEMS) {
    toast("粘贴后会超过 100 张卡片，请减少选中内容", true);
    return false;
  }
  const normalized = normalizeBoard(
    {
      items: rawItems,
      connections: payload.connections,
      zones: Array.isArray(payload.zones) ? payload.zones : state.zones,
    },
    false,
  );
  const left = Math.min(...normalized.items.map((item) => item.x)),
    top = Math.min(...normalized.items.map((item) => item.y)),
    offset = 40 * ++pasteCount;
  const dx = position ? position.x - left : offset,
    dy = position ? position.y - top : offset,
    mapping = new Map();
  const zoneMapping = new Map(),
    zoneOffsets = new Map(),
    addedZones = [];
  const occupiedSlots = new Set(state.zones.map((zone) => zone.slot));
  for (const zone of normalized.zones) {
    const existing = state.zones.find((value) => value.id === zone.id);
    if (existing) zoneMapping.set(zone.id, existing.id);
    else {
      let slot = 4;
      while (occupiedSlots.has(slot)) slot++;
      occupiedSlots.add(slot);
      const width = state.zones[0]?.w || 900,
        height = state.zones[0]?.h || 820;
      const copy = {
        ...zone,
        id: id(),
        slot,
        x: (slot % 2) * width,
        y: Math.floor(slot / 2) * height,
        w: width,
        h: height,
        collapsed: false,
      };
      zoneOffsets.set(zone.id, { x: copy.x - zone.x, y: copy.y - zone.y });
      addedZones.push(copy);
      zoneMapping.set(zone.id, copy.id);
    }
  }
  if (addedZones.length + state.zones.length > MAX_ZONES) {
    toast("粘贴后超过 100 个分区，请减少选中内容", true);
    return false;
  }
  const occupied = new Set(
    state.items
      .filter((item) => item.kind === "image")
      .map((item) => item.role),
  );
  const copied = normalized.items.map((item) => {
    const copy = { ...clone(item), id: id(), x: item.x + dx, y: item.y + dy };
    mapping.set(item.id, copy.id);
    copy.zone_id = zoneMapping.get(item.zone_id) || null;
    const shift = zoneOffsets.get(item.zone_id);
    if (shift && !position) {
      copy.x = item.x + shift.x;
      copy.y = item.y + shift.y;
    }
    if (
      copy.kind === "image" &&
      [
        "first_frame",
        "last_frame",
        "middle_frame_1",
        "middle_frame_2",
        "middle_frame_3",
      ].includes(copy.role)
    ) {
      if (occupied.has(copy.role)) copy.role = "reference";
      else occupied.add(copy.role);
    }
    return copy;
  });
  const edges = normalized.connections
    .filter((edge) => mapping.has(edge.from) && mapping.has(edge.to))
    .map((edge) => ({
      id: id(),
      from: mapping.get(edge.from),
      to: mapping.get(edge.to),
      label: edge.label,
    }));
  if (edges.length + state.connections.length > 1000) {
    toast("粘贴后超过 1000 条连线，请减少选中内容", true);
    return false;
  }
  checkpoint();
  state.zones.push(...addedZones);
  for (const item of copied) {
    const target = position
      ? zoneAt({ x: item.x + item.w / 2, y: item.y + item.h / 2 })
      : zoneOf(item);
    if (position) assignToZone(item, target);
    if (target && !position) {
      item.x = Math.max(
        target.x + 20,
        Math.min(item.x, target.x + target.w - item.w - 20),
      );
      item.y = Math.max(
        target.y + 120,
        Math.min(item.y, target.y + target.h - item.h - 20),
      );
    }
  }
  state.items.push(...copied);
  state.connections.push(...edges);
  state.selectedIds = new Set(copied.map((item) => item.id));
  state.selected = copied.at(-1).id;
  state.selectedConnection = null;
  renderBoard();
  markChanged();
  canvas.focus({ preventScroll: true });
  toast(`已粘贴 ${copied.length} 张卡片和 ${edges.length} 条内部连线`);
  return true;
}
async function pasteFromClipboard(position = null) {
  if (clipboardFallback && internalClipboard) {
    pastePayload(internalClipboard, position);
    return;
  }
  try {
    const text = await navigator.clipboard.readText(),
      payload = parseClipboard(text);
    if (payload) {
      pastePayload(payload, position);
      return;
    }
    if (text.trim()) {
      addText("extra", text.trim(), position);
      return;
    }
  } catch {}
  if (internalClipboard) pastePayload(internalClipboard, position);
  else toast("剪贴板为空，或无法读取。可直接按 Ctrl+V 粘贴图片或文字。");
}
function duplicateSelection() {
  const payload = clipboardPayload();
  if (!payload?.items.length) {
    toast("先选中要复制的卡片");
    return;
  }
  pasteCount = 0;
  pastePayload(payload);
}
function closeContextMenu() {
  const menu = $("context-menu");
  if (menu) menu.hidden = true;
}
function showContextMenu(event) {
  if (editable(event.target) || event.target.closest("video")) return;
  event.preventDefault();
  const card = event.target.closest(".board-card"),
    connection = event.target.closest(".connection");
  if (card && !state.selectedIds.has(card.dataset.id))
    selectCard(card.dataset.id);
  else if (connection) selectConnection(connection.dataset.connectionId);
  else if (!card && !connection) selectCard(null);
  contextPoint = screenToWorld(event.clientX, event.clientY);
  let menu = $("context-menu");
  if (!menu) {
    menu = node("div", "context-menu");
    menu.id = "context-menu";
    menu.setAttribute("role", "menu");
    document.body.append(menu);
  }
  menu.replaceChildren();
  const selected = state.selectedIds.size > 0 || !!state.selectedConnection;
  const add = (label, key, handler, disabled = false) => {
    const control = button("", "", () => {
      closeContextMenu();
      Promise.resolve(handler()).catch(report);
    });
    control.setAttribute("role", "menuitem");
    control.disabled = disabled;
    control.append(node("span", "", label));
    if (key) control.append(node("kbd", "", key));
    menu.append(control);
  };
  const separator = () => {
    const line = node("div", "menu-separator");
    line.setAttribute("role", "separator");
    menu.append(line);
  };
  add("撤销", "Ctrl+Z", undoBoard, !state.history.length);
  add("重做", "Ctrl+Shift+Z", redoBoard, !state.future.length);
  separator();
  add("复制", "Ctrl+C", () => copySelection(), !selected);
  add("剪切", "Ctrl+X", () => copySelection(true), !selected);
  add("粘贴", "Ctrl+V", () => pasteFromClipboard(contextPoint));
  add("创建副本", "Ctrl+D", duplicateSelection, !state.selectedIds.size);
  add("删除选中内容", "Delete", deleteSelection, !selected);
  separator();
  if (state.selectedConnection)
    for (const [value, label] of Object.entries(CONNECTION_LABELS))
      add("标为「" + label + "」", "", () => changeConnectionLabel(value));
  else {
    add("建立生成关系", "", toggleConnectionMode, !state.items.length);
    add("添加文字卡片", "", () => addText("scene", "", contextPoint));
  }
  separator();
  add("聚焦选中", "F", () => fitBoard(true), !state.selectedIds.size);
  add("显示全部", "Home", () => fitBoard());
  menu.hidden = false;
  menu.style.left =
    Math.max(
      8,
      Math.min(event.clientX, window.innerWidth - menu.offsetWidth - 8),
    ) + "px";
  menu.style.top =
    Math.max(
      8,
      Math.min(event.clientY, window.innerHeight - menu.offsetHeight - 8),
    ) + "px";
  menu.querySelector("button:not(:disabled)")?.focus();
  menu.onkeydown = (keyEvent) => {
    if (keyEvent.key === "Escape") {
      keyEvent.preventDefault();
      keyEvent.stopPropagation();
      closeContextMenu();
      canvas.focus();
      return;
    }
    const controls = [...menu.querySelectorAll("button:not(:disabled)")],
      index = controls.indexOf(document.activeElement);
    if (["ArrowDown", "ArrowUp", "Home", "End"].includes(keyEvent.key)) {
      keyEvent.preventDefault();
      keyEvent.stopPropagation();
      const next =
        keyEvent.key === "Home"
          ? 0
          : keyEvent.key === "End"
            ? controls.length - 1
            : (index +
                (keyEvent.key === "ArrowDown" ? 1 : -1) +
                controls.length) %
              controls.length;
      controls[next]?.focus();
    }
  };
}
function changeConnectionLabel(label) {
  const edge = state.connections.find(
    (value) => value.id === state.selectedConnection,
  );
  if (!edge || edge.label === label) return;
  checkpoint();
  edge.label = label;
  renderConnections();
  renderSelection();
  markChanged();
}
function beginPan(event) {
  event.preventDefault();
  closeContextMenu();
  drag = {
    kind: "pan",
    pointerId: event.pointerId,
    clientX: event.clientX,
    clientY: event.clientY,
    viewport: { ...state.viewport },
    moved: false,
  };
  canvas.classList.add("grabbing");
  canvas.setPointerCapture(event.pointerId);
}
function finishInteraction(cancel = false, event = null) {
  if (!drag) return;
  const ended = drag;
  drag = null;
  if (canvas.hasPointerCapture?.(ended.pointerId))
    canvas.releasePointerCapture(ended.pointerId);
  canvas.classList.remove("grabbing");
  world
    .querySelectorAll(".dragging")
    .forEach((card) => card.classList.remove("dragging"));
  if ($("selection-marquee")) $("selection-marquee").hidden = true;
  if (["cards", "resize"].includes(ended.kind)) {
    if (cancel) restoreHistory(ended.before);
    else if (ended.moved) {
      checkpoint(ended.before);
      const changed =
        ended.kind === "cards" &&
        assignDroppedCards(
          state.items.filter((item) =>
            ended.originals.some((original) => original.id === item.id),
          ),
        );
      if (ended.kind === "cards") renderBoard();
      markChanged(changed);
    }
  } else if (ended.kind === "pan") {
    if (cancel) {
      state.viewport = ended.viewport;
      applyView();
    } else if (ended.moved) markChanged(false);
  } else if (ended.kind === "marquee" && cancel) {
    state.selectedIds = new Set(ended.selected);
    updateSelection();
  } else if (ended.kind === "connection") {
    ended.port._ignoreClick = true;
    setTimeout(() => {
      ended.port._ignoreClick = false;
    }, 0);
    if (cancel) {
      state.linkSource = null;
      state.linkMode = false;
    } else if (ended.moved && event) {
      const target = document
        .elementFromPoint(event.clientX, event.clientY)
        ?.closest(".board-card");
      if (target && target.dataset.id !== ended.source)
        createConnection(ended.source, target.dataset.id);
      else {
        state.linkSource = null;
        state.linkMode = false;
        toast("拖到另一张卡片再松开即可连线");
      }
    }
    updateSelection();
  }
  renderConnections();
}
function cancelInteraction() {
  finishInteraction(true);
  state.linkSource = null;
  state.linkMode = false;
  spacePressed = false;
  canvas.classList.remove("space-pan", "linking");
  closeContextMenu();
  updateSelection();
}
function bindCanvasEvents() {
  const marquee = node("div", "selection-marquee");
  marquee.id = "selection-marquee";
  marquee.hidden = true;
  canvas.append(marquee);
  canvas.addEventListener(
    "wheel",
    (event) => {
      if (event.target.closest("textarea,video")) return;
      event.preventDefault();
      closeContextMenu();
      zoomTo(
        state.viewport.zoom * (event.deltaY < 0 ? 1.1 : 1 / 1.1),
        event.clientX,
        event.clientY,
      );
    },
    { passive: false },
  );
  canvas.addEventListener("pointerdown", (event) => {
    if (editable(event.target)) return;
    if (event.button === 1 || (event.button === 0 && spacePressed)) {
      beginPan(event);
      return;
    }
    if (
      event.button !== 0 ||
      event.target.closest(".board-card,button,.connection")
    )
      return;
    event.preventDefault();
    closeContextMenu();
    if (state.linkMode) {
      state.linkSource = null;
      state.linkMode = false;
    }
    canvas.focus({ preventScroll: true });
    const start = screenToWorld(event.clientX, event.clientY);
    drag = {
      kind: "marquee",
      pointerId: event.pointerId,
      start,
      selected: [...state.selectedIds],
      additive: event.shiftKey,
      moved: false,
    };
    if (!event.shiftKey) selectCard(null);
    canvas.setPointerCapture(event.pointerId);
  });
  canvas.addEventListener("pointermove", (event) => {
    if (!drag) return;
    if (drag.kind === "pan") {
      const dx = event.clientX - drag.clientX,
        dy = event.clientY - drag.clientY;
      if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
      state.viewport.panX = drag.viewport.panX + dx;
      state.viewport.panY = drag.viewport.panY + dy;
      applyView();
      return;
    }
    const point = screenToWorld(event.clientX, event.clientY);
    if (drag.kind === "connection") {
      drag.x = point.x;
      drag.y = point.y;
      if (
        Math.abs(event.clientX - drag.startClientX) +
          Math.abs(event.clientY - drag.startClientY) >
        5
      )
        drag.moved = true;
      renderConnections();
      return;
    }
    if (drag.kind === "marquee") {
      const x = Math.min(drag.start.x, point.x),
        y = Math.min(drag.start.y, point.y),
        right = Math.max(drag.start.x, point.x),
        bottom = Math.max(drag.start.y, point.y);
      if ((right - x + bottom - y) * state.viewport.zoom < 4) return;
      drag.moved = true;
      marquee.hidden = false;
      Object.assign(marquee.style, {
        left: x * state.viewport.zoom + state.viewport.panX + "px",
        top: y * state.viewport.zoom + state.viewport.panY + "px",
        width: (right - x) * state.viewport.zoom + "px",
        height: (bottom - y) * state.viewport.zoom + "px",
      });
      state.selectedIds = new Set(drag.additive ? drag.selected : []);
      state.items.forEach((item) => {
        if (!itemVisible(item)) return;
        if (
          item.x <= right &&
          item.x + item.w >= x &&
          item.y <= bottom &&
          item.y + item.h >= y
        )
          state.selectedIds.add(item.id);
      });
      state.selectedConnection = null;
      updateSelection();
      return;
    }
    const dx = point.x - drag.startX,
      dy = point.y - drag.startY;
    if ((Math.abs(dx) + Math.abs(dy)) * state.viewport.zoom < 3 && !drag.moved)
      return;
    if (!drag.moved) canvas.setPointerCapture(event.pointerId);
    drag.moved = true;
    if (drag.kind === "cards")
      drag.originals.forEach((original) => {
        const item = state.items.find((value) => value.id === original.id);
        if (!item) return;
        item.x = Math.round(original.x + dx);
        item.y = Math.round(original.y + dy);
        world
          .querySelector(`[data-id="${CSS.escape(item.id)}"]`)
          ?.classList.add("dragging");
      });
    else {
      const original = drag.originals.find((item) => item.id === drag.itemId),
        item = state.items.find((value) => value.id === drag.itemId);
      if (!original || !item) {
        finishInteraction(false);
        return;
      }
      item.w = Math.round(Math.max(220, Math.min(900, original.w + dx)));
      item.h = Math.round(
        Math.max(minimumCardHeight(item), Math.min(950, original.h + dy)),
      );
    }
    moveCardElements();
  });
  canvas.addEventListener("pointerup", (event) =>
    finishInteraction(false, event),
  );
  canvas.addEventListener("pointercancel", () => finishInteraction(true));
  canvas.addEventListener("dblclick", (event) => {
    if (
      !event.target.closest(
        ".board-card,button,.connection,.quadrant-heading,input,select",
      )
    )
      addText("scene", "", screenToWorld(event.clientX, event.clientY));
  });
  canvas.addEventListener("contextmenu", showContextMenu);
  canvas.addEventListener("dragover", (event) => {
    event.preventDefault();
    canvas.classList.add("drop-active");
  });
  canvas.addEventListener("dragleave", (event) => {
    if (!canvas.contains(event.relatedTarget))
      canvas.classList.remove("drop-active");
  });
  canvas.addEventListener("drop", (event) => {
    event.preventDefault();
    canvas.classList.remove("drop-active");
    uploadFiles(
      event.dataTransfer.files,
      screenToWorld(event.clientX, event.clientY),
    );
  });
  document.addEventListener("pointerdown", (event) => {
    if (!event.target.closest("#context-menu")) closeContextMenu();
  });
  window.addEventListener("blur", () => {
    if (state.loaded) cancelInteraction();
  });
}
async function uploadFiles(files, position = null) {
  const media = [...files].filter(
    (file) => file.type.startsWith("image/") || file.type.startsWith("video/"),
  );
  if (!media.length) {
    toast("请选择图片或视频文件", true);
    return;
  }
  if (media.length + state.items.length > MAX_ITEMS) {
    toast("画板最多支持 100 张卡片", true);
    return;
  }
  toast(`正在导入 ${media.length} 个素材…`);
  const imported = [],
    place = position || newPosition();
  for (const file of media) {
    try {
      const body = new FormData();
      body.append("file", file);
      const result = await api("/api/upload", {
        method: "POST",
        body,
        timeout: 120000,
      });
      imported.push({
        id: id(),
        kind: file.type.startsWith("image/") ? "image" : "video",
        role: "reference",
        file: result.name,
        x: place.x + imported.length * 40,
        y: place.y + imported.length * 40,
        w: 330,
        h: file.type.startsWith("video/") ? 310 : 280,
      });
    } catch (error) {
      report(error);
    }
  }
  if (!imported.length) return;
  const accepted = imported.slice(0, MAX_ITEMS - state.items.length);
  if (!accepted.length) {
    toast("画板已达到 100 张，请移除部分卡片后重新导入", true);
    return;
  }
  checkpoint();
  for (const item of accepted)
    assignToZone(
      item,
      zoneAt({ x: item.x + item.w / 2, y: item.y + item.h / 2 }),
    );
  state.items.push(...accepted);
  state.selectedIds = new Set(accepted.map((item) => item.id));
  state.selected = accepted.at(-1).id;
  state.selectedConnection = null;
  renderBoard();
  markChanged();
  toast(
    `已导入 ${accepted.length} 个素材。选中图片可设置参考用途、人物视角或首尾/中间帧引导。`,
  );
}
function bindClipboardEvents() {
  for (const type of ["copy", "cut"])
    window.addEventListener(type, (event) => {
      if (!editorAvailable(event.target)) return;
      const payload = clipboardPayload();
      if (!payload || !event.clipboardData) return;
      event.preventDefault();
      internalClipboard = payload;
      clipboardFallback = false;
      pasteCount = 0;
      event.clipboardData.setData(CLIPBOARD_TYPE, JSON.stringify(payload));
      event.clipboardData.setData(
        "text/plain",
        CLIPBOARD_PREFIX + JSON.stringify(payload),
      );
      if (type === "cut") deleteSelection();
      toast(type === "cut" ? "已剪切选中内容" : "已复制选中内容和内部连线");
    });
  window.addEventListener("paste", (event) => {
    if (!editorAvailable(event.target)) return;
    const clipboard = event.clipboardData;
    if (!clipboard) return;
    const text = clipboard.getData("text/plain"),
      payload = parseClipboard(text);
    if (payload) {
      event.preventDefault();
      pastePayload(payload);
      return;
    }
    if (clipboard.files.length) {
      event.preventDefault();
      uploadFiles(clipboard.files);
      return;
    }
    if (text.trim()) {
      event.preventDefault();
      addText("extra", text.trim());
    }
  });
}

function renderParams() {
  const res = $("resolution");
  if (
    ![...res.options].some((option) => option.value === state.params.resolution)
  ) {
    const option = node(
      "option",
      "",
      state.params.resolution.replace(",", " × ") + " · 历史配置",
    );
    option.value = state.params.resolution;
    res.append(option);
  }
  res.value = state.params.resolution;
  if ($("model-mode"))
    $("model-mode").value = state.params.model_mode || "auto";
  for (const key of ["duration", "steps", "seed"])
    $(key).value = state.params[key];
  updateMode();
}
function updateMode() {
  const quick =
    ["608,352", "352,608"].includes(state.params.resolution) &&
    Number(state.params.duration) === 2 &&
    Number(state.params.steps) === 8;
  const quality =
    state.params.resolution === "608,352" &&
    Number(state.params.duration) === 5 &&
    Number(state.params.steps) === 20;
  $("quick-preset").classList.toggle("active", quick);
  $("quality-preset").classList.toggle("active", quality);
}
function paramsValid() {
  for (const key of ["duration", "steps", "seed"]) {
    if (!$(key).reportValidity()) return false;
  }
  return true;
}
function generationSignature() {
  return JSON.stringify({
    items: state.items.map(({ x, y, w, h, ...input }) => input),
    connections: state.connections,
    zones: state.zones.map(({ id, name, purpose }) => ({ id, name, purpose })),
    params: state.params,
  });
}

function renderEstimate() {
  $("estimate-detail").replaceChildren();
  const result = state.estimate;
  if (!result) {
    $("estimate-detail").append(
      node("p", "muted", "先检查输入和计算规模，再开始生成。"),
    );
    $("estimate-badge").textContent = "尚未检查";
    $("expensive-confirm").hidden = true;
  } else {
    $("estimate-badge").textContent = result.requires_confirmation
      ? "高计算成本"
      : "检查完成";
    $("estimate-detail").append(
      node(
        "p",
        "estimate-main",
        result.estimate_seconds != null
          ? "预计 " + durationText(result.estimate_seconds)
          : result.estimate_label || "耗时暂无法可靠预估",
      ),
    );
    const facts = [];
    if (result.frames) facts.push(result.frames + " 帧");
    if (result.actual_duration != null)
      facts.push("实际约 " + Number(result.actual_duration).toFixed(2) + " 秒");
    facts.push(state.params.steps + " 步");
    $("estimate-detail").append(node("p", "estimate-facts", facts.join(" · ")));
    if (result.model_mode)
      $("estimate-detail").append(
        node(
          "p",
          "estimate-facts",
          String(result.model_mode).toUpperCase() +
            (result.model_available === false
              ? " · 模型尚未就绪"
              : " · 模型已就绪"),
        ),
      );
    if (result.estimate_seconds != null && result.estimate_label)
      $("estimate-detail").append(node("p", "muted", result.estimate_label));
    (result.warnings || []).forEach((warning) =>
      $("estimate-detail").append(
        node(
          "p",
          "warning",
          typeof warning === "string"
            ? warning
            : warning.message || JSON.stringify(warning),
        ),
      ),
    );
    $("expensive-confirm").hidden = !result.requires_confirmation;
  }
  $("generate").textContent = state.busy
    ? "正在处理…"
    : result?.model_available === false
      ? "重新检查模型"
      : result
        ? "开始生成镜头"
        : "检查并预估";
  $("generate").disabled =
    state.busy ||
    (result?.model_available !== false &&
      !!result?.requires_confirmation &&
      !$("confirm-expensive").checked);
}
async function generate() {
  if (state.busy || !paramsValid() || !commitParameterInputs()) return;
  const signature = generationSignature();
  state.busy = true;
  renderEstimate();
  try {
    if (
      !state.estimate ||
      state.estimateSignature !== signature ||
      state.estimate.model_available === false
    ) {
      const estimate = await api("/api/estimate", {
        method: "POST",
        body: snapshot(),
      });
      if (generationSignature() !== signature) {
        toast("画板已变化，请重新检查");
        return;
      }
      state.estimate = estimate;
      state.estimateSignature = signature;
      $("confirm-expensive").checked = false;
      toast(
        estimate.model_available === false
          ? "输入检查完成，但对应模型尚未就绪。可查看实际输入预览。"
          : "检查完成。确认配置后点击「开始生成镜头」。",
      );
    } else {
      const payload = {
        ...snapshot(),
        confirm_expensive: $("confirm-expensive").checked,
      };
      await saveBoard();
      await api("/api/generate", {
        method: "POST",
        body: payload,
        timeout: 150000,
      });
      toast("镜头已提交，进度将显示在生成任务中");
      invalidateEstimate();
      await refreshTasks();
    }
  } catch (error) {
    report(error);
  } finally {
    state.busy = false;
    renderEstimate();
  }
}
async function loadPresets() {
  try {
    const results = await Promise.allSettled([
      api("/api/presets"),
      api("/api/memory"),
    ]);
    const presets = results[0].status === "fulfilled" ? results[0].value : {};
    const memory = results[1].status === "fulfilled" ? results[1].value : {};
    Object.entries(presets).forEach(([role, entries]) => {
      if (!Array.isArray(entries)) return;
      const group = node("optgroup");
      group.label = role === "prompt" ? "镜头模板" : TEXT_ROLES[role] || role;
      entries.forEach((entry) => {
        if (!entry.text) return;
        const value = state.presets.length;
        state.presets.push({
          role: role === "prompt" ? "scene" : role,
          content: entry.text,
        });
        const option = node(
          "option",
          "",
          entry.name || entry.text.slice(0, 20),
        );
        option.value = String(value);
        group.append(option);
      });
      $("preset-select").append(group);
    });
    const recent = node("optgroup");
    recent.label = "最近用过";
    Object.entries(memory).forEach(([role, values]) => {
      if (!Array.isArray(values)) return;
      values.slice(0, 3).forEach((value) => {
        if (typeof value !== "string") return;
        const index = state.presets.length;
        state.presets.push({ role, content: value });
        const option = node(
          "option",
          "",
          (TEXT_ROLES[role] || "描述") + " · " + value.slice(0, 30),
        );
        option.value = String(index);
        recent.append(option);
      });
    });
    if (recent.children.length) $("preset-select").append(recent);
  } catch (error) {
    report(error);
  }
}
async function refreshSystem() {
  try {
    state.system = await api("/api/system", { timeout: 15000 });
    const online = state.system.comfyui_running,
      engine = state.system.engine || {};
    $("system-info").title = engine.error || "查看本地模型与设备";
    $("engine-dot").className = "status-dot " + (online ? "online" : "offline");
    $("engine-text").textContent = online
      ? "本地引擎已连接"
      : engine.error
        ? "引擎异常 · 点击查看"
        : engine.owned
          ? "本地引擎正在启动"
          : "本地引擎未连接";
  } catch {
    $("engine-dot").className = "status-dot offline";
    $("engine-text").textContent = "工作室连接中断";
  }
}
let originalImageFile = null;
function showImagePreview(item) {
  if (!item || item.kind !== "image") return;
  originalImageFile = item.file;
  $("image-preview-title").textContent =
    REFERENCE_ROLES[purposeOf(item)] + " · 原图";
  const preview = $("image-preview");
  preview.src = fileUrl(item.file);
  preview.alt = item.notes || roleLabel(item);
  preview.onload = () => {
    $("image-preview-meta").textContent =
      `${preview.naturalWidth} × ${preview.naturalHeight} · ${item.file}`;
  };
  $("download-original-image").href = fileUrl(item.file);
  $("download-original-image").download = item.file.split("/").at(-1);
  $("image-copy-status").textContent =
    "复制的是原尺寸图片像素，可粘贴到其他软件；下载保留原文件格式。";
  $("image-copy-status").className = "";
  if (!$("image-dialog").open) $("image-dialog").showModal();
}
async function originalImagePng(file) {
  const response = await fetch(fileUrl(file));
  if (!response.ok) throw new Error("无法读取原图");
  const blob = await response.blob();
  if (blob.type === "image/png") return blob;
  const bitmap = await createImageBitmap(blob);
  const surface = document.createElement("canvas");
  surface.width = bitmap.width;
  surface.height = bitmap.height;
  surface.getContext("2d").drawImage(bitmap, 0, 0);
  bitmap.close();
  return new Promise((resolve, reject) =>
    surface.toBlob(
      (value) => (value ? resolve(value) : reject(new Error("无法转换原图"))),
      "image/png",
    ),
  );
}
async function copyOriginalImage() {
  const status = $("image-copy-status"),
    control = $("copy-original-image");
  control.disabled = true;
  status.className = "";
  status.textContent = "正在复制原尺寸图片…";
  try {
    if (
      !originalImageFile ||
      !window.ClipboardItem ||
      !navigator.clipboard?.write
    )
      throw new Error("此环境不支持图片剪贴板");
    await navigator.clipboard.write([
      new ClipboardItem({ "image/png": originalImagePng(originalImageFile) }),
    ]);
    status.textContent = "原图已复制。可直接粘贴到其他软件，没有复制画板卡片。";
  } catch (error) {
    status.className = "error";
    status.textContent =
      "无法复制原图：" +
      (error.message || "剪贴板权限受限") +
      "。请使用右侧「下载原图」。";
  } finally {
    control.disabled = false;
  }
}
function openInfo(title, content) {
  $("info-title").textContent = title;
  $("info-content").replaceChildren(content);
  if (!$("info-dialog").open) $("info-dialog").showModal();
}
let inputPreviewRequest = 0;
async function showInputs() {
  if (!commitParameterInputs()) return;
  const request = ++inputPreviewRequest;
  const content = node("div", "input-preview");
  content.append(node("p", "muted", "正在编译当前画板，核对实际模型输入…"));
  openInfo("实际送入 H3", content);
  try {
    const signature = generationSignature();
    const result = await api("/api/estimate", {
      method: "POST",
      body: snapshot(),
    });
    if (request !== inputPreviewRequest || !$("info-dialog").open) return;
    content.replaceChildren();
    if (signature !== generationSignature()) {
      content.append(
        node("p", "warning", "画板在检查期间发生变化，请重新打开预览。"),
      );
      return;
    }
    state.estimate = result;
    state.estimateSignature = signature;
    renderEstimate();
    const mode = String(
      result.model_mode || state.params.model_mode || "auto",
    ).toUpperCase();
    content.append(
      node(
        "h3",
        "",
        mode +
          " · " +
          (result.model_available === false
            ? "本地模型尚未就绪"
            : "输入检查完成"),
      ),
    );
    content.append(
      node(
        "p",
        "field-help",
        "Ref2VA：最多 9 张图片、3 段视频；首尾与中间帧使用 FL2VA。",
      ),
    );
    const generationNotes = [];
    for (const warning of result.warnings || []) {
      const message =
        typeof warning === "string"
          ? warning
          : warning.message || JSON.stringify(warning);
      const explicitError =
        typeof warning === "object" &&
        ["error", "critical", "incompatible"].includes(
          warning.severity || warning.level || warning.type,
        );
      // Only known informational guidance is folded. New/unknown warnings and
      // explicit errors stay prominent so a model incompatibility is never hidden.
      const informational =
        /^(Ref2VA在每个采样步|此配置显著高于试片负载|2[–—-]4秒用于验证|中间帧1\/2\/3分别约束|视频时长和画幅以右侧参数为准)/.test(
          message,
        ) || /实际截取 \d+(?:\.\d+)?–\d+(?:\.\d+)? 秒，\d+帧/.test(message);
      if (informational && !explicitError) generationNotes.push(message);
      else content.append(node("p", "warning", message));
    }
    const entries = result.input_manifest || [];
    const counts = node("div", "input-audit-summary");
    for (const [kind, label] of [
      ["text", "段文字"],
      ["image", "张图片"],
      ["video", "段视频"],
    ])
      counts.append(
        node(
          "span",
          "",
          entries.filter(
            (entry) => entry.kind === kind && entry.included !== false,
          ).length +
            " " +
            label,
        ),
      );
    counts.append(
      node(
        "span",
        "",
        entries.filter((entry) => entry.included === false).length +
          " 项暂不参与",
      ),
    );
    content.append(counts);
    const list = node("div", "input-manifest");
    entries.forEach((entry, index) => {
      const original = state.items.find((item) => item.id === entry.item_id);
      const row = node(
        "article",
        "manifest-item" + (entry.included === false ? " excluded" : ""),
      );
      row.dataset.itemId = entry.item_id || "";
      const body = node("div", "manifest-body");
      if (entry.kind === "image" && entry.file) {
        const picture = node("img", "manifest-preview");
        picture.src = fileUrl(entry.file);
        picture.alt = REFERENCE_ROLES[entry.reference_role] || "图片输入";
        picture.addEventListener("click", () =>
          showImagePreview(
            original || {
              kind: "image",
              file: entry.file,
              reference_role: entry.reference_role,
            },
          ),
        );
        row.append(picture);
      } else if (entry.kind === "video" && entry.file) {
        const mediaBox = node("div", "manifest-media"),
          media = node("video", "manifest-preview");
        media.src = fileUrl(entry.file);
        media.preload = "metadata";
        media.muted = !entry.video?.include_audio;
        const start = Number(entry.video?.start_seconds || 0),
          end = start + Number(entry.video?.effective_duration || 0);
        media.addEventListener("loadedmetadata", () => {
          media.currentTime = start;
        });
        media.addEventListener("timeupdate", () => {
          if (end > start && media.currentTime >= end) {
            media.pause();
            media.currentTime = end;
          }
        });
        mediaBox.append(
          media,
          button("播放选用片段", "text-btn", () => {
            media.currentTime = start;
            media.play().catch((error) => toast(error.message, true));
          }),
        );
        row.append(mediaBox);
      } else row.append(node("div", "manifest-text-icon", "Aa"));
      body.append(
        node(
          "span",
          "manifest-order",
          `输入 ${String(index + 1).padStart(2, "0")} · ${entry.included === false ? "暂不参与" : "本次实际输入"}`,
        ),
      );
      body.append(
        node(
          "h4",
          "",
          `${entry.tag || "—"} · ${original?.kind === "text" ? TEXT_ROLES[original.role] || "文字" : REFERENCE_ROLES[entry.reference_role] || entry.kind || "输入"}`,
        ),
      );
      if (entry.included === false)
        body.append(node("p", "", entry.reason || "已停用"));
      if (entry.content || original?.kind === "text")
        body.append(
          node(
            "p",
            "manifest-content",
            entry.content || original?.content || "（空白文字）",
          ),
        );
      const zone = state.zones.find((value) => value.id === entry.zone_id);
      if (zone) body.append(node("p", "", "所属象限：" + zone.name));
      if (entry.reference_role === "storyboard")
        body.append(
          node(
            "p",
            "",
            "分镜顺序：" +
              (entry.shot_order ?? original?.shot_order ?? "按卡片顺序"),
          ),
        );
      if (entry.frame_index != null)
        body.append(
          node("p", "", "实际引导位置：第 " + entry.frame_index + " 帧"),
        );
      if (entry.reference_role === "character")
        body.append(
          node(
            "p",
            "",
            "人物视角：" +
              (CHARACTER_VIEWS[entry.character_view] || "整体参考"),
          ),
        );
      if (entry.video) {
        const video = entry.video;
        body.append(
          node(
            "p",
            "manifest-video-plan",
            `原片 ${Number(video.source_duration || 0).toFixed(2)} 秒；${Number(video.start_seconds || 0).toFixed(2)} 秒起，申请 ${Number(video.requested_duration || 0).toFixed(2)} 秒 → 实际选用 ${Number(video.effective_duration || 0).toFixed(2)} 秒`,
          ),
        );
        body.append(
          node(
            "p",
            "",
            `${video.frames ?? "—"} 帧 · ${video.fps ?? "—"} FPS · ${video.width ?? "—"} × ${video.height ?? "—"} · ${video.include_audio && video.has_audio ? "包含同期音轨" : "无音轨输入"}`,
          ),
        );
      }
      if (entry.description || entry.notes)
        body.append(
          node(
            "p",
            "",
            [entry.description, entry.notes].filter(Boolean).join("\n"),
          ),
        );
      if (original?.layout)
        body.append(
          node(
            "p",
            "field-help",
            "H3 读取这份布局的 RGB 图像/视频及文字说明；3D 场景 JSON 只用于回到编辑器继续编辑。",
          ),
        );
      if (entry.file) body.append(node("p", "manifest-file", entry.file));
      row.append(body);
      list.append(row);
    });
    if (!list.childNodes.length)
      list.append(
        node("p", "muted", "当前没有媒体输入；文字仍会进入下方提示词。"),
      );
    content.append(list);
    if (result.connection_manifest?.length) {
      content.append(node("h3", "", "关系线的实际作用"));
      for (const relation of result.connection_manifest) {
        content.append(
          node(
            "p",
            relation.included ? "manifest-relation" : "muted",
            relation.included
              ? `${relation.from_tag} → ${relation.to_tag}：${relation.instruction}`
              : `不参与生成：${relation.reason || "端点未参与"}`,
          ),
        );
      }
    }
    content.append(node("h3", "", "编译后的完整提示词"));
    content.append(
      node(
        "pre",
        "compiled-prompt",
        result.compiled_prompt || "（无文字提示）",
      ),
    );
    content.append(
      button("复制完整提示词", "btn", async () => {
        try {
          await navigator.clipboard.writeText(result.compiled_prompt || "");
          toast("完整提示词已复制");
        } catch {
          toast("无法访问文字剪贴板，请选择上方提示词手动复制", true);
        }
      }),
    );
    if (generationNotes.length) {
      const notes = node("details", "input-packet generation-notes");
      notes.append(node("summary", "", "生成约束与耗时说明"));
      for (const message of generationNotes)
        notes.append(node("p", "field-help", message));
      content.append(notes);
    }
    if (result.input_packet) {
      const advanced = node("details", "input-packet");
      advanced.append(
        node("summary", "", "查看实际输入数据（高级）"),
        node("pre", "", JSON.stringify(result.input_packet, null, 2)),
      );
      content.append(advanced);
    }
    content.append(
      node(
        "p",
        "field-help",
        "人物一致、风格沿用等连线会写入提示词，属于生成指导，不保证精确复现。人物视角只描述已提供素材，不自动补齐缺失视图。",
      ),
    );
  } catch (error) {
    if (request !== inputPreviewRequest || !$("info-dialog").open) return;
    content.replaceChildren(
      node("h3", "", "输入尚未通过检查"),
      node("p", "warning", error.message),
    );
    content.append(
      node(
        "p",
        "field-help",
        "检查参与生成的参考数量、帧引导与多模态参考是否混用，以及本地对应模型是否就绪。画板素材仍然保留。",
      ),
    );
  }
}

function showSystem() {
  const content = node("div"),
    grid = node("dl", "info-grid"),
    sys = state.system || {},
    gpu = sys.gpu || {};
  [
    ["模型", sys.model || "MiniMax H3"],
    ["设备", gpu.name || "等待引擎返回设备信息"],
    [
      "显存",
      gpu.vram_total_gb
        ? `${gpu.vram_used_gb ?? "—"} / ${gpu.vram_total_gb} GB`
        : "暂无数据",
    ],
    ["版本", sys.version || "Lumen 本地工作室"],
    [
      "运行状态",
      sys.comfyui_running
        ? "引擎已连接"
        : sys.engine?.owned
          ? "正在启动，请稍候"
          : "引擎未连接",
    ],
  ].forEach(([label, value]) =>
    grid.append(node("dt", "", label), node("dd", "", value)),
  );
  content.append(grid);
  if (sys.engine?.error) content.append(node("p", "warning", sys.engine.error));
  if (!sys.comfyui_running && !sys.engine?.owned) {
    const retry = button("重新启动本地引擎", "btn", async () => {
      retry.disabled = true;
      retry.textContent = "正在启动…";
      try {
        await api("/api/comfyui/start", { method: "POST", timeout: 120000 });
        await refreshSystem();
        retry.textContent = "启动请求已发送";
        toast("正在启动本地引擎，请留意右上角连接状态");
      } catch (error) {
        retry.disabled = false;
        retry.textContent = "重新启动本地引擎";
        report(error);
      }
    });
    content.append(retry);
  }
  content.append(
    node("h3", "", "输入能力"),
    node(
      "p",
      "",
      "FL2VA 使用首尾与中间帧引导；Ref2VA 读取参考图片和视频。用途、人物视角与关系线会编入提示词。所需模型是否已就绪，以及本次实际输入，以生成前检查为准。",
    ),
    node("h3", "", "关闭工作室"),
    node(
      "p",
      "",
      "使用桌面 Lumen 图标启动。关闭应用窗口后，由桌面程序结束本次启动的服务；进行中的任务会停止，草稿与已有成片保留。",
    ),
  );
  openInfo("本地模型与设备", content);
}
function statusPill(status) {
  return node(
    "span",
    "status-pill " + (Object.hasOwn(STATUS, status) ? status : ""),
    STATUS[status] || status || "状态未知",
  );
}
function stageTimeline(task) {
  const groups = [
    ["queued", "排队"],
    ["loading", "加载"],
    ["encoding", "编码"],
    ["sampling", "采样"],
    ["decoding", "解码"],
    ["saving", "保存"],
  ];
  const stage = task.stage || task.status;
  let current = groups.findIndex(([key]) => key === stage);
  if (stage === "connecting" || stage === "submitting") current = 0;
  const list = node("ol", "task-stages");
  groups.forEach(([key, label], index) => {
    const cls =
      task.status === "done"
        ? "passed"
        : index === current
          ? "current"
          : current >= 0 && index < current
            ? "passed"
            : "";
    const item = node("li", cls, label);
    if (index === current) item.setAttribute("aria-current", "step");
    list.append(item);
  });
  return list;
}
function buildTask(task, compact = false) {
  const fragment = document.createDocumentFragment(),
    heading = node("div", "task-heading"),
    titleBox = node("div");
  titleBox.append(
    node("h2", "", recordTitle(task)),
    node("p", "task-date", `${task.created || ""} · ${task.id || ""}`),
  );
  heading.append(titleBox, statusPill(task.status));
  fragment.append(heading);
  const progress = task.progress || {},
    hasProgress =
      Number.isFinite(Number(progress.percent)) &&
      progress.percent !== null &&
      progress.percent !== undefined,
    percent = hasProgress
      ? Math.max(0, Math.min(100, Number(progress.percent)))
      : null,
    stage = node("div", "stage-row");
  stage.append(
    node("span", "", task.stage_label || STATUS[task.status] || "等待状态反馈"),
  );
  const stepText =
    progress.step != null && progress.total
      ? `采样 ${progress.step} / ${progress.total} 步`
      : task.status === "done"
        ? "完成"
        : !ACTIVE.has(task.status)
          ? "未出片"
          : hasProgress
            ? `${Math.round(percent)}%`
            : "等待有效进度";
  stage.append(node("span", "muted", stepText));
  fragment.append(stage);
  const bar = node(
      "div",
      "task-progress" +
        (ACTIVE.has(task.status) && !hasProgress ? " unknown" : ""),
    ),
    fill = node("span");
  fill.style.width = (task.status === "done" ? 100 : percent || 0) + "%";
  bar.setAttribute("role", "progressbar");
  bar.setAttribute(
    "aria-label",
    task.status === "done" ? "已完成" : "采样进度",
  );
  if (hasProgress || task.status === "done")
    bar.setAttribute(
      "aria-valuenow",
      String(task.status === "done" ? 100 : Math.round(percent)),
    );
  bar.append(fill);
  fragment.append(bar, stageTimeline(task));
  const metrics = node("div", "task-metrics");
  const activity = task.last_activity_at
    ? typeof task.last_activity_at === "number"
      ? new Date(task.last_activity_at * 1000).toLocaleTimeString("zh-CN", {
          hour12: false,
        })
      : String(task.last_activity_at).replace("T", " ")
    : "尚无反馈";
  [
    ["已用时", durationText(task.elapsed_seconds)],
    [
      task.eta_label ? "采样预计剩余" : "预计剩余",
      ACTIVE.has(task.status) ? durationText(task.eta_seconds) : "—",
    ],
    ["最近有效进展", activity],
  ].forEach(([label, value]) => {
    const cell = node("span", "", label);
    cell.append(node("strong", "", value));
    metrics.append(cell);
  });
  fragment.append(metrics);
  if (task.eta_label && ACTIVE.has(task.status))
    fragment.append(node("p", "task-message", task.eta_label));
  if (task.warning) fragment.append(node("p", "warning", task.warning));
  if (task.error) fragment.append(node("p", "task-message error", task.error));
  if (task.status === "interrupted" && !task.error)
    fragment.append(
      node(
        "p",
        "task-message",
        "任务已中断。配置仍然保留，可回填并调整后重新生成。",
      ),
    );
  const actions = node("div", "task-actions");
  if (ACTIVE.has(task.status)) {
    const cancel = button("取消此任务", "btn danger", async () => {
      cancel.disabled = true;
      cancel.textContent = "正在取消…";
      try {
        await api(`/api/tasks/${encodeURIComponent(task.id)}/cancel`, {
          method: "POST",
        });
        toast("已发送取消请求，正在更新任务状态");
        await refreshTasks();
      } catch (error) {
        cancel.disabled = false;
        cancel.textContent = "取消此任务";
        report(error);
      }
    });
    if (task.status === "cancelling") {
      cancel.disabled = true;
      cancel.textContent = "正在取消，请稍候…";
      fragment.append(
        node(
          "p",
          "task-message",
          "正在等待引擎停止。如需立即停止计算，可关闭 Lumen 应用窗口。",
        ),
      );
    }
    actions.append(cancel);
  } else if (!compact) {
    actions.append(button("回填配置", "btn", () => refillRecord(task.id)));
    if (task.status === "done")
      actions.append(button("查看成片", "btn", () => openAsset(task)));
  }
  fragment.append(actions);
  return fragment;
}
function renderTasks() {
  const active = state.tasks.filter((task) => ACTIVE.has(task.status));
  $("task-count").textContent = active.length ? String(active.length) : "";
  $("task-summary").replaceChildren();
  [
    [active.length, "进行中"],
    [state.tasks.filter((task) => task.status === "done").length, "已完成"],
    [
      state.tasks.filter((task) =>
        ["failed", "cancelled", "interrupted"].includes(task.status),
      ).length,
      "已结束但未出片",
    ],
  ].forEach(([count, label]) => {
    const span = node("span");
    span.append(node("b", "", count), document.createTextNode(label));
    $("task-summary").append(span);
  });
  $("task-list").replaceChildren();
  if (!state.tasks.length) {
    const empty = node("div", "empty-state", "还没有生成任务");
    empty.append(node("small", "", "在画板准备镜头，完成生成前检查后开始。"));
    $("task-list").append(empty);
  }
  state.tasks.forEach((task) => {
    const card = node(
      "article",
      "task-card" + (ACTIVE.has(task.status) ? " active" : ""),
    );
    card.append(buildTask(task));
    $("task-list").append(card);
  });
  const current = active[0] || state.tasks[0];
  $("current-task-section").hidden = !current;
  $("current-task").replaceChildren();
  if (current) $("current-task").append(buildTask(current, true));
}
async function refreshTasks() {
  if (polling) return;
  polling = true;
  try {
    const result = await api("/api/tasks", { timeout: 20000 }),
      previous = new Map(state.tasks.map((task) => [task.id, task.status]));
    state.tasks = Array.isArray(result) ? result : result.tasks || [];
    renderTasks();
    if (
      state.tasks.some(
        (task) =>
          task.status === "done" &&
          previous.has(task.id) &&
          previous.get(task.id) !== "done",
      )
    ) {
      toast("镜头已完成，已保存到素材库");
      await refreshLibrary();
    }
  } catch (error) {
    $("task-summary").textContent =
      "暂时无法读取任务状态。连接恢复后会自动刷新。";
  } finally {
    polling = false;
  }
}
async function refreshLibrary() {
  try {
    const result = await api("/api/library");
    state.records = Array.isArray(result) ? result : result.records || [];
    renderLibrary();
  } catch (error) {
    $("library-summary").textContent = "素材库暂时无法连接";
  }
}
function filteredRecords() {
  const query = $("library-search").value.toLowerCase().trim(),
    status = $("library-status").value;
  return state.records.filter(
    (record) =>
      (!state.starOnly || record.star) &&
      (status === "all" ||
        (status === "done"
          ? record.status === "done"
          : record.status !== "done")) &&
      (!query ||
        [record.id, record.prompt, ...(record.tags || [])]
          .join(" ")
          .toLowerCase()
          .includes(query)),
  );
}
function renderLibrary() {
  $("library-count").textContent = String(
    state.records.filter((record) => record.status === "done").length,
  );
  const records = filteredRecords(),
    grid = $("library-grid");
  grid.replaceChildren();
  $("library-summary").textContent = `${records.length} 条记录`;
  if (!records.length) {
    const empty = node(
      "div",
      "empty-state",
      state.records.length
        ? "没有符合条件的素材"
        : "你的第一个镜头，会留在这里",
    );
    empty.append(
      node(
        "small",
        "",
        state.records.length
          ? "换一个关键词，或取消筛选。"
          : "生成记录、视频与原始配置都会保留，方便继续创作。",
      ),
    );
    grid.append(empty);
    return;
  }
  records.forEach((record) => {
    const card = node("article", "asset-card"),
      thumb = button("", "asset-thumb", () => openAsset(record));
    thumb.setAttribute("aria-label", "查看素材：" + recordTitle(record));
    if (record.thumb) {
      const image = node("img");
      image.src = thumbUrl(record.thumb);
      image.alt = "";
      image.loading = "lazy";
      thumb.append(image);
    } else {
      const placeholder = node("span", "no-thumb");
      placeholder.append(icon("video"));
      thumb.append(placeholder);
    }
    if (record.outputs?.length) {
      const play = node("span", "play-mark");
      play.append(icon("play"));
      thumb.append(play);
    }
    thumb.append(
      node("span", "asset-badge", STATUS[record.status] || record.status),
    );
    if (record.star) {
      const star = node("span", "asset-star");
      star.append(icon("star"));
      thumb.append(star);
    }
    const content = node("div", "asset-card-content"),
      title = button(recordTitle(record), "asset-card-title", () =>
        openAsset(record),
      );
    title.title = recordTitle(record);
    content.append(title);
    const meta = node("div", "asset-card-meta");
    meta.append(
      node(
        "span",
        "",
        `${recordResolution(record)} · ${recordDuration(record)}`,
      ),
      node("span", "", String(record.created || "").slice(0, 10)),
    );
    content.append(meta);
    if (record.tags?.length) {
      const tags = node("div", "tag-row");
      record.tags
        .slice(0, 5)
        .forEach((tag) => tags.append(node("span", "tag-pill", tag)));
      content.append(tags);
    }
    card.append(thumb, content);
    grid.append(card);
  });
}
function openAsset(record) {
  state.asset = record;
  $("asset-title").textContent = recordTitle(record);
  $("asset-meta").replaceChildren();
  [
    STATUS[record.status] || record.status,
    recordResolution(record),
    `${record.status === "done" ? "成片" : "计划"} ${recordDuration(record)}`,
    ...(record.frames && record.duration != null
      ? [`原始输入 ${record.duration} 秒`]
      : []),
    `${record.steps ?? "—"} 步`,
    `种子 ${record.seed ?? "—"}`,
    record.created || "",
  ]
    .filter(Boolean)
    .forEach((value) => $("asset-meta").append(node("span", "", value)));
  $("asset-prompt").textContent = record.prompt || "这条记录没有保存提示词。";
  $("asset-tags").value = (record.tags || []).join("，");
  $("asset-error").hidden = !record.error;
  $("asset-error").textContent = record.error || "";
  $("star-asset").replaceChildren(
    icon("star"),
    document.createTextNode(record.star ? "已星标" : "星标"),
  );
  const video = $("asset-video"),
    output = (record.outputs || []).find((file) =>
      /\.(mp4|webm|mov|mkv)$/i.test(file.name),
    );
  video.pause();
  if (output) {
    video.src = outputUrl(output);
    video.hidden = false;
    $("asset-no-video").hidden = true;
  } else {
    video.removeAttribute("src");
    video.load();
    video.hidden = true;
    $("asset-no-video").hidden = false;
  }
  if (!$("asset-dialog").open) $("asset-dialog").showModal();
}
async function refillRecord(recordId) {
  try {
    await saveBoard();
    const data = await api(
      `/api/library/${encodeURIComponent(recordId)}/refill`,
    );
    checkpoint();
    restoreBoard(data, !Number(data.viewport?.zoom));
    setPage("board");
    markChanged();
    $("asset-dialog").close();
    toast("已回填画板与完整配置。可撤销回到之前的草稿。");
  } catch (error) {
    report(error);
  }
}
function undoBoard() {
  if (!state.history.length) return;
  cancelInteraction();
  const previous = state.history.pop();
  state.future.push(historySnapshot());
  restoreHistory(previous);
  updateHistoryButtons();
  toast("已撤销上一步");
}
function redoBoard() {
  if (!state.future.length) return;
  cancelInteraction();
  const next = state.future.pop();
  state.history.push(historySnapshot());
  restoreHistory(next);
  updateHistoryButtons();
  toast("已重做上一步");
}
function showShortcuts() {
  const content = node("div", "shortcuts-content");
  const pairs = [
    ["Ctrl + Z / Ctrl + Shift + Z 或 Ctrl + Y", "撤销 / 重做"],
    ["Ctrl + C / X / V", "复制 / 剪切 / 粘贴卡片及内部连线"],
    ["Ctrl + D / Delete", "创建副本 / 删除选中内容"],
    ["Ctrl + A / Shift + 单击", "全选 / 追加或取消选择"],
    ["拖动空白 / Shift + 框选", "框选 / 追加框选"],
    ["Ctrl + S", "保存画板，并显示全部卡片"],
    ["F / Home", "聚焦选中卡片 / 显示全部"],
    ["空格 + 拖动 / 中键拖动", "平移画板"],
    ["方向键 / Shift + 方向键", "移动选中卡片 10 / 40 像素"],
    ["Esc", "取消拖动、退出连线、关闭菜单"],
  ];
  for (const [key, description] of pairs) {
    const row = node("p", "shortcut-row");
    row.append(node("kbd", "", key), node("span", "", description));
    content.append(row);
  }
  content.append(
    node(
      "p",
      "field-help",
      "编辑文字或参数时，复制、粘贴、全选与撤销保留输入框原生行为。首尾与中间帧用于帧引导，关系线写入提示词；以「实际送入 H3」预览为准。",
    ),
  );
  openInfo("画板操作与快捷键", content);
}
function commitParameterInputs() {
  const item = state.items.find((value) => value.id === state.selected);
  if (
    item?.kind === "video" &&
    state.selectedIds.size === 1 &&
    ["video-start", "video-duration"].includes(document.activeElement?.id)
  ) {
    const input = document.activeElement;
    if (!input.value || !input.checkValidity()) {
      input.reportValidity();
      return false;
    }
    const key = input.id === "video-start" ? "video_start" : "video_duration";
    if (Number(input.value) !== item[key]) {
      checkpoint();
      item[key] = Number(input.value);
      markChanged();
    }
  }
  const next = { ...state.params };
  if ($("model-mode")) next.model_mode = $("model-mode").value;
  for (const key of ["resolution", "duration", "steps", "seed"]) {
    const input = $(key);
    if (!input.value || !input.checkValidity()) {
      input.reportValidity();
      toast("请先填写有效的生成参数", true);
      return false;
    }
    next[key] = key === "resolution" ? input.value : Number(input.value);
  }
  if (Object.keys(next).some((key) => next[key] !== state.params[key])) {
    checkpoint();
    state.params = next;
    updateMode();
    markChanged();
  }
  return true;
}
function bindEditorKeyboard() {
  document.addEventListener("keydown", (event) => {
    const command = event.ctrlKey || event.metaKey,
      key = event.key.toLowerCase();
    if (
      state.page !== "board" ||
      document.querySelector("dialog[open]") ||
      event.isComposing
    )
      return;
    if (command && key === "s") {
      event.preventDefault();
      finishInteraction(false);
      if (!commitParameterInputs()) return;
      fitBoard();
      if (state.saveConflict) {
        showBoardConflict();
        return;
      }
      saveBoard().then(() =>
        toast(
          state.dirty
            ? "已保留本机草稿，连接恢复后同步"
            : "画板已保存，已显示全部卡片",
        ),
      );
      return;
    }
    if (editable(event.target)) return;
    if (event.key === "Escape") {
      event.preventDefault();
      const returnToOverview = state.focusedZone && !drag && !state.linkMode;
      cancelInteraction();
      selectCard(null);
      if (returnToOverview) fitBoard();
      canvas.focus();
      return;
    }
    if ($("context-menu") && !$("context-menu").hidden) return;
    if (command && key === "z") {
      event.preventDefault();
      if (event.shiftKey) redoBoard();
      else undoBoard();
      return;
    }
    if (command && key === "y") {
      event.preventDefault();
      redoBoard();
      return;
    }
    if (command && key === "d") {
      event.preventDefault();
      duplicateSelection();
      return;
    }
    if (command && key === "a") {
      event.preventDefault();
      state.selectedIds = new Set(state.items.map((item) => item.id));
      state.selectedConnection = null;
      updateSelection();
      return;
    }
    if (command || event.altKey) return;
    if (event.key === " ") {
      if (!event.target.closest("button")) {
        event.preventDefault();
        spacePressed = true;
        canvas.classList.add("space-pan");
      }
      return;
    }
    if (key === "f") {
      event.preventDefault();
      finishInteraction(false);
      fitBoard(true);
      return;
    }
    if (event.key === "Home") {
      event.preventDefault();
      finishInteraction(false);
      fitBoard();
      return;
    }
    if (event.key === "Delete" || event.key === "Backspace") {
      event.preventDefault();
      deleteSelection();
      return;
    }
    if (
      ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(event.key) &&
      state.selectedIds.size
    ) {
      event.preventDefault();
      if (!event.repeat) checkpoint();
      const distance = event.shiftKey ? 40 : 10;
      state.items
        .filter((item) => state.selectedIds.has(item.id))
        .forEach((item) => {
          item.x +=
            event.key === "ArrowRight"
              ? distance
              : event.key === "ArrowLeft"
                ? -distance
                : 0;
          item.y +=
            event.key === "ArrowDown"
              ? distance
              : event.key === "ArrowUp"
                ? -distance
                : 0;
        });
      moveCardElements();
      markChanged(false);
    }
  });
  document.addEventListener("keyup", (event) => {
    if (event.key === " ") {
      spacePressed = false;
      canvas.classList.remove("space-pan");
    }
  });
}
function bindEvents() {
  let resizeTimer;
  window.addEventListener("resize", () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(clearToolbarOverlap, 120);
  });
  bindCanvasEvents();
  bindClipboardEvents();
  bindEditorKeyboard();
  $("selected-shot-order")?.addEventListener("change", (event) => {
    if (!event.target.checkValidity()) {
      event.target.reportValidity();
      return;
    }
    const item = state.items.find((value) => value.id === state.selected);
    if (!item) return;
    checkpoint();
    if (event.target.value === "") delete item.shot_order;
    else item.shot_order = Number(event.target.value);
    renderBoard();
    markChanged();
  });
  $("copy-original-image").addEventListener("click", copyOriginalImage);
  $("add-zone")?.addEventListener("click", () => addZone());
  $("organize-board")?.addEventListener("click", organizeBoard);
  $("preview-inputs")?.addEventListener("click", showInputs);
  $("model-mode")?.addEventListener("change", (event) => {
    checkpoint();
    state.params.model_mode = event.target.value;
    markChanged();
  });
  $("selected-reference-role")?.addEventListener("change", (event) =>
    editCard(state.selected, { reference_role: event.target.value }),
  );
  $("selected-character-view")?.addEventListener("change", (event) =>
    editCard(state.selected, { character_view: event.target.value }),
  );
  $("selected-enabled")?.addEventListener("change", (event) => {
    checkpoint();
    for (const item of state.items)
      if (state.selectedIds.has(item.id)) item.enabled = event.target.checked;
    renderBoard();
    markChanged();
  });
  $("selected-zone")?.addEventListener("change", (event) => {
    const item = state.items.find((value) => value.id === state.selected);
    if (!item || state.selectedIds.size !== 1) return;
    checkpoint();
    const zone = state.zones.find((value) => value.id === event.target.value);
    assignToZone(item, zone);
    if (zone) placeCardInZone(item, zone);
    renderBoard();
    markChanged();
  });
  let notesSnapshot = null;
  $("selected-notes")?.addEventListener("focus", () => {
    notesSnapshot = historySnapshot();
  });
  $("selected-notes")?.addEventListener("input", (event) => {
    const item = state.items.find((value) => value.id === state.selected);
    if (!item || state.selectedIds.size !== 1) return;
    if (notesSnapshot) {
      checkpoint(notesSnapshot);
      notesSnapshot = null;
    } else {
      state.future = [];
      updateHistoryButtons();
    }
    item.notes = event.target.value;
    const card = world.querySelector(`[data-id="${CSS.escape(item.id)}"]`);
    if (card) {
      let note = card.querySelector(".card-notes");
      if (!note) {
        note = node("p", "card-notes");
        card.append(note);
      }
      note.textContent = item.notes;
    }
    markChanged();
  });
  for (const [controlId, key] of [
    ["video-start", "video_start"],
    ["video-duration", "video_duration"],
    ["video-include-audio", "include_audio"],
  ]) {
    $(controlId)?.addEventListener("change", (event) => {
      const input = event.target;
      if (
        !input.checkValidity() ||
        (input.type !== "checkbox" && input.value === "")
      ) {
        input.reportValidity();
        return;
      }
      editCard(state.selected, {
        [key]: input.type === "checkbox" ? input.checked : Number(input.value),
      });
    });
  }
  document
    .querySelectorAll("[data-page]")
    .forEach((el) =>
      el.addEventListener("click", () => setPage(el.dataset.page)),
    );
  $("add-text").addEventListener("click", () => addText());
  $("empty-add").addEventListener("click", () => addText());
  $("add-image").addEventListener("click", () => {
    $("file-picker").accept = "image/*";
    $("file-picker").click();
  });
  $("add-video").addEventListener("click", () => {
    $("file-picker").accept = "video/*";
    $("file-picker").click();
  });
  $("file-picker").addEventListener("change", (event) => {
    uploadFiles(event.target.files);
    event.target.value = "";
  });
  $("zoom-in").addEventListener("click", () =>
    zoomTo(state.viewport.zoom * 1.2),
  );
  $("zoom-out").addEventListener("click", () =>
    zoomTo(state.viewport.zoom / 1.2),
  );
  $("fit-board").addEventListener("click", () => fitBoard());
  $("arrange-board").addEventListener("click", () => fitBoard());
  $("clear-board").addEventListener("click", () => {
    if (!state.items.length && !state.connections.length) return;
    checkpoint();
    state.items = [];
    state.connections = [];
    state.zones = defaultZones();
    state.selectedIds.clear();
    state.selected = null;
    state.selectedConnection = null;
    state.linkSource = null;
    state.linkMode = false;
    renderBoard();
    fitBoard();
    markChanged();
    toast("画板已清空，可撤销恢复");
  });
  $("undo-board").addEventListener("click", undoBoard);
  $("redo-board")?.addEventListener("click", redoBoard);
  $("connect-cards")?.addEventListener("click", toggleConnectionMode);
  $("connection-label")?.addEventListener("change", (event) =>
    changeConnectionLabel(event.target.value),
  );
  $("delete-connection")?.addEventListener("click", () =>
    deleteConnection(state.selectedConnection),
  );
  $("shortcuts-btn")?.addEventListener("click", showShortcuts);
  $("selected-role").addEventListener("change", (event) => {
    const item = state.items.find((value) => value.id === state.selected);
    if (
      !item ||
      state.selectedIds.size !== 1 ||
      item.role === event.target.value
    )
      return;
    editCard(item.id, { role: event.target.value });
  });
  $("duplicate-card").addEventListener("click", duplicateSelection);
  $("delete-card").addEventListener("click", deleteSelection);
  $("preset-select").addEventListener("change", (event) => {
    if (event.target.value !== "") {
      const preset = state.presets[Number(event.target.value)];
      if (preset) addText(preset.role, preset.content);
      event.target.value = "";
    }
  });
  for (const key of ["resolution", "duration", "steps", "seed"])
    $(key).addEventListener("change", (event) => {
      if (!event.target.value || !event.target.checkValidity()) return;
      const value =
        key === "resolution" ? event.target.value : Number(event.target.value);
      if (state.params[key] === value) return;
      checkpoint();
      state.params[key] = value;
      updateMode();
      markChanged();
    });
  $("quick-preset").addEventListener("click", () => {
    checkpoint();
    state.params = {
      ...DEFAULT_PARAMS,
      seed: state.params.seed,
      model_mode: state.params.model_mode || "auto",
    };
    renderParams();
    markChanged();
  });
  $("quality-preset").addEventListener("click", () => {
    checkpoint();
    state.params = {
      resolution: "608,352",
      duration: 5,
      steps: 20,
      seed: state.params.seed,
      model_mode: state.params.model_mode || "auto",
    };
    renderParams();
    markChanged();
  });
  $("random-seed").addEventListener("click", () => {
    checkpoint();
    state.params.seed = crypto.getRandomValues(new Uint32Array(1))[0];
    $("seed").value = state.params.seed;
    markChanged();
  });
  $("generate").addEventListener("click", generate);
  $("confirm-expensive").addEventListener("change", renderEstimate);
  $("show-inputs").addEventListener("click", showInputs);
  $("system-info").addEventListener("click", showSystem);
  $("all-tasks").addEventListener("click", () => setPage("tasks"));
  $("refresh-tasks").addEventListener("click", refreshTasks);
  $("refresh-library").addEventListener("click", refreshLibrary);
  $("library-search").addEventListener("input", renderLibrary);
  $("library-status").addEventListener("change", renderLibrary);
  $("star-filter").addEventListener("click", () => {
    state.starOnly = !state.starOnly;
    $("star-filter").classList.toggle("filter-active", state.starOnly);
    $("star-filter").setAttribute("aria-pressed", String(state.starOnly));
    $("star-filter").replaceChildren(
      icon("star"),
      document.createTextNode("仅看星标"),
    );
    renderLibrary();
  });
  $("refill-asset").addEventListener(
    "click",
    () => state.asset && refillRecord(state.asset.id),
  );
  $("star-asset").addEventListener("click", async () => {
    if (!state.asset) return;
    const record = state.asset,
      next = !record.star;
    try {
      await api(`/api/library/${encodeURIComponent(record.id)}/star`, {
        method: "POST",
        body: { star: next },
      });
      record.star = next;
      $("star-asset").replaceChildren(
        icon("star"),
        document.createTextNode(next ? "已星标" : "星标"),
      );
      await refreshLibrary();
    } catch (error) {
      report(error);
    }
  });
  $("save-tags").addEventListener("click", async () => {
    if (!state.asset) return;
    const tags = [
      ...new Set(
        $("asset-tags")
          .value.split(/[,，\n]/)
          .map((tag) => tag.trim())
          .filter(Boolean),
      ),
    ];
    try {
      await api(`/api/library/${encodeURIComponent(state.asset.id)}/tags`, {
        method: "POST",
        body: { tags },
      });
      state.asset.tags = tags;
      toast("标签已保存");
      await refreshLibrary();
    } catch (error) {
      report(error);
    }
  });
  $("open-asset").addEventListener("click", async () => {
    if (!state.asset) return;
    try {
      await api(`/api/library/${encodeURIComponent(state.asset.id)}/open`, {
        method: "POST",
      });
    } catch (error) {
      report(error);
    }
  });
  $("copy-prompt").addEventListener("click", async () => {
    if (!state.asset) return;
    try {
      await navigator.clipboard.writeText(state.asset.prompt || "");
      toast("提示词已复制");
    } catch {
      toast("无法访问剪贴板，可在提示词区域选择文字复制", true);
    }
  });
  document
    .querySelectorAll(".close-dialog")
    .forEach((el) =>
      el.addEventListener("click", () => el.closest("dialog").close()),
    );
  $("asset-dialog").addEventListener("close", () => $("asset-video").pause());
  $("info-dialog").addEventListener("close", () => {
    $("info-dialog")
      .querySelectorAll("video")
      .forEach((video) => video.pause());
  });
  document.querySelectorAll("dialog").forEach((dialog) =>
    dialog.addEventListener("click", (event) => {
      if (event.target === dialog) {
        const rect = dialog.getBoundingClientRect();
        if (
          event.clientX < rect.left ||
          event.clientX > rect.right ||
          event.clientY < rect.top ||
          event.clientY > rect.bottom
        )
          dialog.close();
      }
    }),
  );
  let unloading = false;
  window.addEventListener("beforeunload", () => {
    unloading = true;
    if (!state.dirty || !state.loaded) return;
    // Keep the newest draft synchronously. A parallel unload PUT could overtake an older queued save.
    try {
      cacheDraft();
    } catch {}
  });
  document.addEventListener("visibilitychange", () => {
    if (unloading) return;
    if (document.hidden) saveBoard();
    else {
      refreshTasks();
      refreshSystem();
      refreshBoardRevision();
      if (state.dirty) saveBoard();
    }
  });
}

async function addLayoutAsset(
  kind,
  { file, notes = "", layout = {}, itemId = null, duration = 2 } = {},
) {
  if (!state.loaded) throw new Error("画板尚未加载，请稍后再试");
  if (typeof file !== "string" || !file.trim())
    throw new Error("布局素材尚未上传成功");
  let item = itemId
    ? state.items.find(
        (value) => value.id === itemId && purposeOf(value) === "layout",
      )
    : null;
  if (itemId && !item)
    throw new Error("原布局卡片已不存在，请重新打开布局工具");
  // Exporting another medium is a new reference; retain the original image/video.
  if (item && item.kind !== kind) item = null;
  if (!item && state.items.length >= MAX_ITEMS)
    throw new Error("画板已达到 100 张卡片");
  checkpoint();
  let zone =
    state.zones.find((value) => value.purpose === "layout") ||
    state.zones.find((value) => value.slot === 3);
  if (!item) {
    const count = state.items.filter(
      (value) => value.zone_id === zone?.id,
    ).length;
    item = {
      id: id(),
      kind,
      role: "reference",
      reference_role: "layout",
      enabled: true,
      x: (zone?.x || 0) + 40 + (count % 2) * 408,
      y: (zone?.y || 0) + 130 + Math.floor(count / 2) * 40,
      w: 380,
      h: 360,
      zone_id: zone?.id || null,
    };
    state.items.push(item);
  }
  Object.assign(item, {
    kind,
    role: "reference",
    file,
    notes: String(notes),
    layout: clone(layout),
    reference_role: "layout",
  });
  if (kind === "video") {
    item.video_start = 0;
    item.video_duration = Math.max(0.21, Math.min(15, Number(duration) || 2));
    item.include_audio = false;
  }
  state.selectedIds = new Set([item.id]);
  state.selected = item.id;
  state.selectedConnection = null;
  renderBoard();
  fitBoard(true);
  markChanged();
  await saveBoard();
  toast(
    kind === "video" ? "镜头运动已作为视频参考加入画板" : "布局原图已加入画板",
  );
  return clone(item);
}
async function addReferencePreset(payload) {
  if (!state.loaded) throw new Error("画板尚未加载，请稍后再试");
  if (!Array.isArray(payload.items) || !payload.items.length)
    throw new Error("预设中没有卡片");
  if (state.items.length + payload.items.length > MAX_ITEMS)
    throw new Error("调用后会超过 100 张卡片，请先整理画板");
  if (state.connections.length + (payload.connections?.length || 0) > 1000)
    throw new Error("调用后会超过 1000 条连线");
  finishInteraction(false);
  const zones = clone(state.zones),
    occupied = clone(state.items),
    copied = [],
    mapping = new Map(),
    sourceZones = new Map((payload.zones || []).map((zone) => [zone.id, zone])),
    groupTargets = new Map();
  const width = zones[0]?.w || 900,
    height = zones[0]?.h || 820;
  const roleSet = new Set(
    state.items
      .filter((item) => item.kind === "image" && item.enabled !== false)
      .map((item) => item.role),
  );
  function createZone(purpose, name) {
    if (zones.length >= MAX_ZONES)
      throw new Error("调用后会超过 100 个区域，请先整理画板");
    const used = new Set(zones.map((zone) => zone.slot));
    let slot = 4;
    while (used.has(slot)) slot++;
    const zone = {
      id: id(),
      name,
      purpose,
      slot,
      x: (slot % 2) * width,
      y: Math.floor(slot / 2) * height,
      w: width,
      h: height,
      collapsed: false,
    };
    zones.push(zone);
    return zone;
  }
  function findSpace(item, zone) {
    for (let y = zone.y + 130; y + item.h <= zone.y + zone.h - 20; y += 32) {
      for (let x = zone.x + 32; x + item.w <= zone.x + zone.w - 20; x += 32) {
        if (
          !occupied.some(
            (other) =>
              other.zone_id === zone.id &&
              x < other.x + other.w + 20 &&
              x + item.w + 20 > other.x &&
              y < other.y + other.h + 20 &&
              y + item.h + 20 > other.y,
          )
        )
          return { x, y };
      }
    }
    return null;
  }
  for (const original of payload.items) {
    const item = clone(original),
      purpose = purposeOf(item),
      bucket = zonePurpose(purpose),
      source = sourceZones.get(item.zone_id);
    const key = (source?.id || bucket) + ":" + bucket;
    let target = groupTargets.get(key);
    if (!target) {
      const custom =
        source &&
        (source.slot >= 4 ||
          ![
            ...Object.values(REFERENCE_ROLES),
            ...QUADRANTS.map((zone) => zone.name),
          ].includes(source.name));
      target = custom
        ? zones.find(
            (zone) =>
              zone.name === source.name && zone.purpose === source.purpose,
          )
        : zones.find((zone) => zone.purpose === purpose) ||
          zones.find((zone) => zone.purpose === bucket);
      if (!target)
        target = createZone(
          bucket,
          custom ? source.name : REFERENCE_ROLES[bucket] || payload.name,
        );
      groupTargets.set(key, target);
    }
    item.id = id();
    mapping.set(original.id, item.id);
    item.w = Math.max(220, Math.min(Number(item.w) || 330, width - 64));
    item.h = Math.max(
      minimumCardHeight(item),
      Math.min(Number(item.h) || minimumCardHeight(item), height - 160),
    );
    let position = findSpace(item, target);
    if (!position) {
      target = createZone(bucket, payload.name || REFERENCE_ROLES[bucket]);
      groupTargets.set(key, target);
      position = findSpace(item, target);
    }
    if (!position) throw new Error("区域空间不足，无法放入这张卡片");
    Object.assign(item, position, {
      zone_id: target.id,
      preset_name: payload.name || item.preset_name,
    });
    if (
      item.kind === "image" &&
      [
        "first_frame",
        "last_frame",
        "middle_frame_1",
        "middle_frame_2",
        "middle_frame_3",
      ].includes(item.role) &&
      item.enabled !== false
    ) {
      if (roleSet.has(item.role)) item.role = "reference";
      else roleSet.add(item.role);
    }
    occupied.push(item);
    copied.push(item);
  }
  const edges = (payload.connections || [])
    .filter((edge) => mapping.has(edge.from) && mapping.has(edge.to))
    .map((edge) => ({
      ...clone(edge),
      id: id(),
      from: mapping.get(edge.from),
      to: mapping.get(edge.to),
    }));
  checkpoint();
  state.zones = zones;
  state.items.push(...copied);
  state.connections.push(...edges);
  state.selectedIds = new Set(copied.map((item) => item.id));
  state.selected = copied.at(-1).id;
  state.selectedConnection = null;
  setPage("board");
  renderBoard();
  fitBoard(true);
  markChanged();
  await saveBoard();
  toast(`已加入「${payload.name}」· ${copied.length} 张卡片，原画板内容已保留`);
  return {
    ids: copied.map((item) => item.id),
    connections: edges.map((edge) => edge.id),
  };
}
window.LumenBoard = {
  getSelectedReferences() {
    if (!state.loaded) throw new Error("画板尚未加载");
    finishInteraction(false);
    const payload = clipboardPayload();
    if (!payload?.items?.length)
      throw new Error("先选中要保存的画板卡片；Shift 可多选");
    return { ...payload, params: clone(state.params) };
  },
  addReferencePreset,
  getSelectedLayout() {
    const item = state.items.find(
      (value) =>
        value.id === state.selected &&
        ["image", "video"].includes(value.kind) &&
        purposeOf(value) === "layout",
    );
    return item ? clone(item) : null;
  },
  addLayoutReference: (options) => addLayoutAsset("image", options),
  addLayoutVideo: (options) => addLayoutAsset("video", options),
};

bindEvents();
$("board-conflict")?.addEventListener("click", showBoardConflict);
renderEstimate();
Promise.allSettled([
  loadBoard(),
  loadPresets(),
  refreshSystem(),
  refreshTasks(),
  refreshLibrary(),
]).then(() => {
  setInterval(refreshTasks, 4000);
  setInterval(refreshBoardRevision, 4000);
  setInterval(refreshSystem, 15000);
  setInterval(() => {
    if (state.dirty) saveBoard();
    if (state.page === "library") refreshLibrary();
  }, 20000);
});
