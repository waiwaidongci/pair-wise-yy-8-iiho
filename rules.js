// 规则：三班轮换交接
// - 每缸每班只留一张有效观察单，同班重复提交覆盖未签认的草稿
// - 上一班未签认，下一班只能看：不能追加观察单，也不能改缸位阶段
// - 签认后补改原始读数：后续班次的单子连同缸位阶段一起作废，并按有效单重排
// - 断档：从首张单到当前班次，缺有效单的班次都算断档

export const SHIFTS = ["早班", "中班", "夜班"];
export const STAGES = ["入缸", "发酵中", "可抄纸", "异常观察"];

export function newId(prefix) {
  return prefix + "-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

function pad(n) { return String(n).padStart(2, "0"); }
function dateOf(d) { return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()); }

// 早班 08-16，中班 16-24，夜班 00-08；夜班记在它开始的那一天
export function currentSlot(now = new Date()) {
  const hour = now.getHours();
  if (hour < 8) {
    const yesterday = new Date(now);
    yesterday.setDate(yesterday.getDate() - 1);
    return { date: dateOf(yesterday), shift: "夜班" };
  }
  return { date: dateOf(now), shift: hour < 16 ? "早班" : "中班" };
}

// 班次序号：单调递增，跨天连续，用于排序和断档盘点
export function slotIndex(slot) {
  const [y, m, d] = slot.date.split("-").map(Number);
  return Math.floor(Date.UTC(y, m - 1, d) / 86400000) * 3 + SHIFTS.indexOf(slot.shift);
}

export function slotFromIndex(index) {
  const day = new Date(Math.floor(index / 3) * 86400000);
  const date = day.getUTCFullYear() + "-" + pad(day.getUTCMonth() + 1) + "-" + pad(day.getUTCDate());
  return { date, shift: SHIFTS[((index % 3) + 3) % 3] };
}

export function slotLabel(slot) {
  return slot.date.slice(5) + " " + slot.shift;
}

export function parseSlot(input, fallback = currentSlot()) {
  const date = /^\d{4}-\d{2}-\d{2}$/.test((input && input.date) || "") ? input.date : fallback.date;
  const shift = SHIFTS.includes(input && input.shift) ? input.shift : fallback.shift;
  return { date, shift };
}

export function sheetsOf(archive, vatId) {
  return archive.sheets
    .filter(s => s.vatId === vatId)
    .sort((a, b) => slotIndex(a.slot) - slotIndex(b.slot));
}

// 每缸每班只留一张：作废单不算，同槽位只可能有一张有效单
export function activeSheetAt(archive, vatId, slot) {
  const index = slotIndex(slot);
  return sheetsOf(archive, vatId).find(s => s.status !== "void" && slotIndex(s.slot) === index) || null;
}

function fail(status, reason, message, extra) {
  return { ok: false, status, reason, message, ...extra };
}

// 写入门禁：上一班（最近的更早有效单）未签认时，本班只读
export function writeGate(archive, vatId, slot, now = new Date()) {
  const index = slotIndex(slot);
  if (index > slotIndex(currentSlot(now))) {
    return fail(409, "future_slot", "班次还没到，不能提前填");
  }
  const earlier = sheetsOf(archive, vatId).filter(s => s.status !== "void" && slotIndex(s.slot) < index);
  const previous = earlier[earlier.length - 1];
  if (previous && previous.status !== "signed") {
    return fail(409, "previous_unsigned",
      slotLabel(previous.slot) + "的观察单还没签认，本班只能看，不能追加或改阶段",
      { blockedBy: previous.id });
  }
  return { ok: true };
}

function normalizeReadings(input) {
  const water = input.waterChanged;
  return {
    recorder: String(input.recorder || "").trim(),
    temperature: String(input.temperature || "").trim(),
    smell: String(input.smell || "").trim(),
    fiber: String(input.fiber || "").trim(),
    waterChanged: water === true || ["是", "已换", "true", "1"].includes(String(water).trim()),
    stage: STAGES.includes(input.stage) ? input.stage : null,
  };
}

// 交班：每缸每班一张。已有草稿则覆盖草稿；已签认的只能走补改
export function upsertSheet(archive, vatId, slot, input, now = new Date()) {
  const vat = archive.vats.find(v => v.id === vatId);
  if (!vat) return fail(404, "vat_not_found", "缸位不存在");
  const readings = normalizeReadings(input);
  if (!readings.recorder) return fail(400, "recorder_required", "记录人不能为空");
  if (!readings.temperature) return fail(400, "temperature_required", "温度不能为空");
  const gate = writeGate(archive, vatId, slot, now);
  if (!gate.ok) return gate;
  const existing = activeSheetAt(archive, vatId, slot);
  if (existing && existing.status === "signed") {
    return fail(409, "already_signed", slotLabel(slot) + "的观察单已签认，原始读数请走“签认后补改”");
  }
  const at = now.toISOString();
  if (existing) {
    Object.assign(existing, readings, { stage: readings.stage || existing.stage, updatedAt: at });
    resequenceVat(archive, vatId);
    return { ok: true, sheet: existing, created: false };
  }
  const sheet = {
    id: newId("SH"),
    vatId,
    slot,
    ...readings,
    stage: readings.stage || vat.stage || vat.initialStage || STAGES[0],
    status: "draft",
    signedBy: null,
    signedAt: null,
    corrections: [],
    voidReason: null,
    voidedAt: null,
    stageSeq: null,
    createdAt: at,
    updatedAt: at,
  };
  archive.sheets.push(sheet);
  resequenceVat(archive, vatId);
  return { ok: true, sheet, created: true };
}

// 签认：按班次顺序签，签完单子锁定、阶段才生效
export function signSheet(archive, sheetId, signedBy, now = new Date()) {
  const sheet = archive.sheets.find(s => s.id === sheetId);
  if (!sheet || sheet.status === "void") return fail(404, "sheet_not_found", "观察单不存在或已作废");
  if (sheet.status === "signed") return fail(409, "already_signed", "这张观察单已经签认过了");
  const gate = writeGate(archive, sheet.vatId, sheet.slot, now);
  if (!gate.ok) return gate;
  sheet.status = "signed";
  sheet.signedBy = String(signedBy || "").trim() || sheet.recorder;
  sheet.signedAt = now.toISOString();
  sheet.updatedAt = sheet.signedAt;
  resequenceVat(archive, sheet.vatId);
  return { ok: true, sheet };
}

const READING_KEYS = ["temperature", "smell", "fiber", "waterChanged"];

// 签认后补改原始读数：后续班次的单子一起作废，缸位阶段按剩下的有效单重排
export function correctSheet(archive, sheetId, input, now = new Date()) {
  const sheet = archive.sheets.find(s => s.id === sheetId);
  if (!sheet || sheet.status === "void") return fail(404, "sheet_not_found", "观察单不存在或已作废");
  if (sheet.status !== "signed") return fail(409, "not_signed", "未签认的草稿直接重填即可，补改只针对已签认的单子");
  const corrector = String(input.corrector || "").trim();
  const reason = String(input.reason || "").trim();
  if (!corrector) return fail(400, "corrector_required", "补改人不能为空");
  if (!reason) return fail(400, "reason_required", "补改原因不能为空");
  const next = normalizeReadings({ ...sheet, ...input });
  const before = {};
  const after = {};
  for (const key of READING_KEYS) {
    before[key] = sheet[key];
    after[key] = next[key];
  }
  if (JSON.stringify(before) === JSON.stringify(after)) return fail(400, "no_change", "读数没有变化，无需补改");
  const at = now.toISOString();
  Object.assign(sheet, after, { updatedAt: at });
  sheet.corrections.push({ at, corrector, reason, before, after });
  const index = slotIndex(sheet.slot);
  const voided = [];
  for (const later of sheetsOf(archive, sheet.vatId)) {
    if (later.status !== "void" && slotIndex(later.slot) > index) {
      later.status = "void";
      later.voidReason = slotLabel(sheet.slot) + "补改原始读数，本班作废待重填";
      later.voidedAt = at;
      later.updatedAt = at;
      voided.push(later.id);
    }
  }
  resequenceVat(archive, sheet.vatId);
  return { ok: true, sheet, voided };
}

// 重排：按班次顺序回放已签认的有效单，重算每缸当前阶段、阶段序号和阶段沿革
export function resequenceVat(archive, vatId) {
  const vat = archive.vats.find(v => v.id === vatId);
  if (!vat) return;
  let stage = vat.initialStage || STAGES[0];
  let seq = 0;
  const stageLog = [];
  for (const sheet of sheetsOf(archive, vatId)) {
    if (sheet.status !== "signed") {
      sheet.stageSeq = null;
      continue;
    }
    seq += 1;
    sheet.stageSeq = seq;
    if (sheet.stage) stage = sheet.stage;
    stageLog.push({ seq, sheetId: sheet.id, slot: sheet.slot, stage, at: sheet.signedAt });
  }
  vat.stage = stage;
  vat.stageSeq = seq;
  vat.stageLog = stageLog;
}

// 断档：从首张单到当前班次，没有有效单的班次（含被作废待重填的）
export function vatGaps(archive, vatId, nowSlot = currentSlot()) {
  const all = sheetsOf(archive, vatId);
  if (!all.length) return [];
  const nowIndex = slotIndex(nowSlot);
  const first = Math.min(...all.map(s => slotIndex(s.slot)));
  const filled = new Set(all.filter(s => s.status !== "void").map(s => slotIndex(s.slot)));
  const gaps = [];
  for (let i = first; i <= nowIndex; i += 1) {
    if (!filled.has(i)) gaps.push(slotFromIndex(i));
  }
  return gaps;
}

// 按缸汇总给页面：待签认、断档、当前阶段、本班门禁
export function vatView(archive, vat, nowSlot = currentSlot()) {
  const sheets = sheetsOf(archive, vat.id);
  const gate = writeGate(archive, vat.id, nowSlot);
  return {
    ...vat,
    sheets: sheets.slice().reverse(),
    pending: sheets.filter(s => s.status === "draft"),
    gaps: vatGaps(archive, vat.id, nowSlot).map(slot => ({ ...slot, label: slotLabel(slot) })),
    gate: gate.ok ? { ok: true } : { ok: false, message: gate.message },
  };
}
