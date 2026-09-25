// 交接观察单规则：三班轮换、每缸每班一张、签认锁定、补改连带作废、缸位阶段重算。
// 本文件只做纯规则计算，不读写文件；状态由 archive.js 持久化，server.js 调用。

export const SHIFTS = [
  { name: "夜班", start: 0 },   // 00:00 - 08:00
  { name: "早班", start: 8 },   // 08:00 - 16:00
  { name: "中班", start: 16 }   // 16:00 - 24:00
];
export const STAGES = ["入缸", "发酵中", "可抄纸", "异常观察"];

// 可抄纸：最近一次换水（无换水则自首张签认单）起满 7 天
export const READY_DAYS = 7;

export class RuleError extends Error {
  constructor(message) {
    super(message);
    this.name = "RuleError";
  }
}

function pad(n) { return String(n).padStart(2, "0"); }

export function fmtDate(d) {
  return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
}

// 根据时间确定所在班次
export function slotOf(date) {
  const hour = date.getHours();
  const idx = hour >= 16 ? 2 : hour >= 8 ? 1 : 0;
  const day = fmtDate(date);
  return { date: day, shift: SHIFTS[idx].name, idx, key: day + "#" + idx };
}

export function parseSlot(key) {
  const [date, idxText] = String(key).split("#");
  const idx = Number(idxText);
  if (!date || !SHIFTS[idx]) throw new RuleError("班次时间格式不正确");
  return { date, idx, shift: SHIFTS[idx].name };
}

// 时隙先后：夜班(D) < 早班(D) < 中班(D) < 夜班(D+1)
export function cmpSlot(a, b) {
  const sa = parseSlot(a);
  const sb = parseSlot(b);
  if (sa.date < sb.date) return -1;
  if (sa.date > sb.date) return 1;
  return sa.idx - sb.idx;
}

function addDay(dateText, delta) {
  const d = new Date(Number(dateText.slice(0, 4)), Number(dateText.slice(5, 7)) - 1, Number(dateText.slice(8, 10)));
  d.setDate(d.getDate() + delta);
  return fmtDate(d);
}

function dateDiff(fromText, toText) {
  const from = new Date(Number(fromText.slice(0, 4)), Number(fromText.slice(5, 7)) - 1, Number(fromText.slice(8, 10)));
  const to = new Date(Number(toText.slice(0, 4)), Number(toText.slice(5, 7)) - 1, Number(toText.slice(8, 10)));
  return Math.round((to - from) / 86400000);
}

export function nextSlot(key) {
  const s = parseSlot(key);
  if (s.idx < 2) return s.date + "#" + (s.idx + 1);
  return addDay(s.date, 1) + "#0";
}

export function slotLabel(key) {
  const s = parseSlot(key);
  const [, m, day] = s.date.split("-");
  return Number(m) + "月" + Number(day) + "日 " + s.shift;
}

function clean(value) { return String(value ?? "").trim(); }

export function toBool(value) {
  return value === true || ["是", "true", "1", "yes", "on"].includes(clean(value).toLowerCase());
}

// 观察单的标准读数：记录人、温度、气味、纤维、换水
export function normalizeReadings(input, { partial = false } = {}) {
  const out = {};
  if (!partial || input.temperature !== undefined) {
    const temperature = clean(input.temperature);
    if (!temperature) throw new RuleError("温度必须填写");
    out.temperature = temperature;
  }
  if (!partial || input.smell !== undefined) {
    const smell = clean(input.smell);
    if (!smell) throw new RuleError("气味必须填写");
    out.smell = smell;
  }
  if (!partial || input.fiber !== undefined) {
    const fiber = clean(input.fiber);
    if (!fiber) throw new RuleError("纤维状态必须填写");
    out.fiber = fiber;
  }
  if (!partial || input.changedWater !== undefined) {
    if (clean(input.changedWater) === "") throw new RuleError("换水必须选择是或否");
    out.changedWater = toBool(input.changedWater);
  }
  return out;
}

// 气味出现霉/臭/腐等关键字即判异常观察
export function isAbnormal(sheet) {
  return /霉|臭|腐|异味/.test(sheet.smell || "");
}

export function activeSheets(sheets) {
  return sheets
    .filter(s => s.status !== "已作废")
    .slice()
    .sort((a, b) => cmpSlot(a.slot, b.slot));
}

// 缸位阶段完全由已签认观察单推导，任何人不能手工改阶段
export function stageFor(sheets) {
  const signed = activeSheets(sheets).filter(s => s.status === "已签认");
  if (signed.length === 0) return { stage: "入缸", baseline: null, latest: null };
  const latest = signed[signed.length - 1];
  if (isAbnormal(latest)) return { stage: "异常观察", baseline: null, latest };
  // 换水回改会移动基准，故基准取最后一张“换水=是”的签认单，否则取首张签认单
  let baseline = signed[0].date;
  for (const s of signed) if (s.changedWater) baseline = s.date;
  const days = dateDiff(baseline, latest.date);
  return { stage: days >= READY_DAYS ? "可抄纸" : "发酵中", baseline, latest, days };
}

// 本班次能否记录：必须正好轮到目标时隙（首张=当前班；其后逐班顺延，缺班即断档；
// 补改作废后目标退回最早空档，由后续班次逐班重排）。不能跳班、不能提前记未来班。
export function targetFor(sheets, currentKey) {
  const active = activeSheets(sheets);
  if (active.length === 0) return { key: currentKey };
  const last = active[active.length - 1];
  if (last.status === "待签认") {
    return { blocked: slotLabel(last.slot) + "观察单尚未签认，下个班只能查看，不能追加或改阶段", pendingSlot: last.slot };
  }
  return { key: nextSlot(last.slot) };
}

export function assertVat(vat) {
  const name = clean(vat);
  if (!name) throw new RuleError("必须选择缸位");
  return name;
}

// 建档：每缸每班只留一张，且上一张必须已签认
export function createSheet(archive, vat, input, now, newId) {
  const name = assertVat(vat);
  const current = slotOf(now);
  const target = targetFor(archive.sheets.filter(s => s.vat === name), current.key);
  if (target.blocked) throw new RuleError(target.blocked);
  if (cmpSlot(target.key, current.key) > 0) throw new RuleError("未到记录时间：" + slotLabel(target.key) + " 才轮到记录，不能提前记未来班次");
  if (cmpSlot(target.key, current.key) < 0) {
    throw new RuleError("中间有班次未记录（最早断档 " + slotLabel(target.key) + "），请先由对应缸位逐班重排补记后再记本班");
  }

  const readings = normalizeReadings(input);
  const recorder = clean(input.recorder);
  if (!recorder) throw new RuleError("记录人必须填写");

  const slot = parseSlot(current.key);
  const sheet = {
    id: newId(),
    vat: name,
    slot: current.key,
    date: slot.date,
    shift: slot.shift,
    recorder,
    ...readings,
    status: "待签认",
    createdAt: now.toISOString(),
    signedAt: null,
    signer: null,
    revisions: []
  };
  archive.sheets.push(sheet);
  return sheet;
}

// 待签认阶段：记录人可修原始读数；签认后此路不通
export function updateDraft(archive, id, input) {
  const sheet = archive.sheets.find(s => s.id === id);
  if (!sheet) throw new RuleError("观察单不存在");
  if (sheet.status === "已作废") throw new RuleError("观察单已作废，不能修改");
  if (sheet.status === "已签认") throw new RuleError("观察单已签认，补改请走“补改原始读数”");
  if (input.recorder !== undefined) {
    const recorder = clean(input.recorder);
    if (!recorder) throw new RuleError("记录人必须填写");
    sheet.recorder = recorder;
  }
  Object.assign(sheet, normalizeReadings(input, { partial: true }));
  return sheet;
}

// 上班签认：签认前下个班只读
export function signSheet(archive, id, input, now) {
  const sheet = archive.sheets.find(s => s.id === id);
  if (!sheet) throw new RuleError("观察单不存在");
  if (sheet.status === "已作废") throw new RuleError("观察单已作废，不能签认");
  if (sheet.status === "已签认") throw new RuleError("观察单已签认，不能重复签认");
  const signer = clean(input && input.signer);
  if (!signer) throw new RuleError("签认人必须填写");
  sheet.status = "已签认";
  sheet.signedAt = now.toISOString();
  sheet.signer = signer;
  return sheet;
}

// 签认后补改原始读数：本单留修订痕，其后各班观察单与缸位阶段一起作废并重排
export function amendSheet(archive, id, input, now) {
  const sheet = archive.sheets.find(s => s.id === id);
  if (!sheet) throw new RuleError("观察单不存在");
  if (sheet.status === "已作废") throw new RuleError("观察单已作废，不能补改");
  if (sheet.status !== "已签认") throw new RuleError("只有签认后的观察单才能补改，待签认单请直接修改");
  const by = clean(input && input.by);
  const reason = clean(input && input.reason);
  if (!by) throw new RuleError("补改人必须填写");
  if (!reason) throw new RuleError("补改原因必须填写");
  const readings = normalizeReadings(input);

  sheet.revisions.push({
    at: now.toISOString(),
    by,
    reason,
    readings: {
      temperature: sheet.temperature,
      smell: sheet.smell,
      fiber: sheet.fiber,
      changedWater: sheet.changedWater
    }
  });
  Object.assign(sheet, readings);

  // 连带作废：同缸、班次更晚、仍有效的观察单全部作废，留档不删，由后续班次重排补记
  const voided = [];
  for (const later of archive.sheets) {
    if (later.vat === sheet.vat && later.status !== "已作废" && cmpSlot(later.slot, sheet.slot) > 0) {
      later.status = "已作废";
      later.voidedAt = now.toISOString();
      later.voidReason = "前序班次 " + slotLabel(sheet.slot) + " 补改原始读数，本单连带作废，需重排";
      later.voidedBy = by;
      later.causedBy = sheet.id;
      voided.push(later.id);
    }
  }
  return { sheet, voided };
}

// 断档：从本缸第一张有效单到当前班次之间，缺一张就是一个断档（含补改作废后未重排的班次）
export function gapsFor(sheets, currentKey) {
  const active = activeSheets(sheets);
  if (active.length === 0) return [];
  const owned = new Set(active.map(s => s.slot));
  const gaps = [];
  let cursor = active[0].slot;
  for (;;) {
    if (!owned.has(cursor)) gaps.push(cursor);
    if (cmpSlot(cursor, currentKey) >= 0) break;
    cursor = nextSlot(cursor);
  }
  return gaps;
}

// 按缸汇总：待签认、断档、当前阶段，页面按此渲染
export function overview(archive, items, now) {
  const current = slotOf(now);
  const vatNames = [];
  for (const item of items) if (item.vat && !vatNames.includes(item.vat)) vatNames.push(item.vat);
  for (const s of archive.sheets) if (!vatNames.includes(s.vat)) vatNames.push(s.vat);

  const vats = vatNames.map(vat => {
    const vatSheets = archive.sheets
      .filter(s => s.vat === vat)
      .sort((a, b) => -cmpSlot(a.slot, b.slot));
    const pending = vatSheets.filter(s => s.status === "待签认");
    const gaps = gapsFor(vatSheets, current.key);
    const target = targetFor(vatSheets, current.key);
    const canRecord = !target.blocked && target.key === current.key;
    const { stage, latest, baseline, days } = stageFor(vatSheets);
    return {
      vat,
      stage,
      stageAbnormal: latest ? isAbnormal(latest) : false,
      baseline,
      stageDays: days ?? null,
      latestSignedAt: latest ? latest.slot : null,
      pending: pending.map(s => ({ slot: s.slot, id: s.id })),
      gaps,
      targetSlot: target.key || null,
      blocked: target.blocked || null,
      canRecord,
      batches: items.filter(i => i.vat === vat).map(i => ({ code: i.code, source: i.source, owner: i.owner, days: i.days })),
      sheets: vatSheets.map(s => ({
        ...s,
        abnormal: isAbnormal(s),
        label: slotLabel(s.slot)
      }))
    };
  });

  return {
    now: now.toISOString(),
    currentSlot: current.key,
    currentLabel: fmtDate(now) + " " + current.shift,
    vats
  };
}
