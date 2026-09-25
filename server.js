// 入口：HTTP 路由与页面渲染。
// 业务规则见 rules.js，档案存取见 archive.js。

import http from "node:http";
import { loadDb, saveDb, newSheetId } from "./archive.js";
import {
  SHIFTS,
  READY_DAYS,
  RuleError,
  overview,
  createSheet,
  updateDraft,
  signSheet,
  amendSheet
} from "./rules.js";

const port = Number(process.env.PORT || 3039);
// 三班轮换按车间当地时间（东八区），不随部署机器时区漂移
process.env.TZ ||= "Asia/Shanghai";
const fields = [["code", "批次编号", "text"], ["source", "原料来源", "text"], ["vat", "浸泡缸", "text"], ["days", "发酵天数", "number"], ["owner", "负责人", "text"]];

async function body(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new RuleError("请求内容不是有效的 JSON");
  }
}
function send(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data, null, 2));
}
function html(res, text) {
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(text);
}
function newItemId() { return "PF-" + Date.now(); }

function page() {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>纸浆三班交接观察单</title>
  <style>
    :root { --bg:#f1f3ef; --panel:#fff; --ink:#20241f; --muted:#687066; --line:#d4ddd0; --accent:#526f43; --warn:#9b4937; --hold:#8a6d1d; }
    * { box-sizing:border-box; } body { margin:0; background:var(--bg); color:var(--ink); font-family:Arial,"PingFang SC",sans-serif; }
    header { padding:20px 28px; background:#fff; border-bottom:1px solid var(--line); display:flex; justify-content:space-between; gap:16px; align-items:center; }
    h1 { margin:0; font-size:24px; } h2 { margin:0 0 10px; font-size:17px; } h3 { margin:0; font-size:18px; }
    main { display:grid; grid-template-columns:360px 1fr; gap:20px; padding:20px 28px; align-items:start; }
    form,.panel,.card,.stat { background:var(--panel); border:1px solid var(--line); border-radius:8px; padding:15px; }
    form + form { margin-top:14px; }
    label { display:block; margin:9px 0 4px; color:var(--muted); font-size:13px; }
    input,select,textarea { width:100%; border:1px solid var(--line); border-radius:6px; padding:8px; font:inherit; background:#fff; }
    button { border:0; border-radius:6px; background:var(--accent); color:#fff; padding:9px 12px; font-weight:700; cursor:pointer; }
    button.secondary { background:#69736a; } button.danger { background:var(--warn); } button:disabled { opacity:.45; cursor:not-allowed; }
    .meta { color:var(--muted); font-size:13px; } .row { display:flex; gap:8px; align-items:center; flex-wrap:wrap; margin-top:10px; }
    .pill { display:inline-block; border:1px solid var(--line); border-radius:999px; padding:3px 9px; font-size:12px; }
    .pill.stage-入缸 { background:#eef1ec; } .pill.stage-发酵中 { background:#e4ecd9; color:#3f5733; }
    .pill.stage-可抄纸 { background:#dce7f5; color:#2f4a6b; border-color:#b9cbe4; }
    .pill.stage-异常观察 { background:#f6e2dd; color:var(--warn); border-color:#e4bdb1; }
    .pill.pending { background:#f7ecd2; color:var(--hold); border-color:#e2cd93; }
    .pill.gap { background:#f6e2dd; color:var(--warn); border-color:#e4bdb1; }
    .notice { border:1px solid var(--line); border-radius:8px; background:#fff; padding:12px 14px; margin-bottom:14px; font-size:14px; line-height:1.7; }
    .notice.warn { background:#fbeee8; border-color:#e4bdb1; }
    .vats { display:grid; grid-template-columns:repeat(auto-fill,minmax(420px,1fr)); gap:14px; }
    .vat-head { display:flex; justify-content:space-between; align-items:flex-start; gap:10px; }
    .sheets { margin-top:10px; border-top:1px dashed var(--line); }
    .sheet { padding:10px 0; border-bottom:1px dashed var(--line); }
    .sheet:last-child { border-bottom:0; }
    .sheet.voided { opacity:.62; }
    .sheet.voided .readings del { color:var(--muted); }
    .readings { display:grid; grid-template-columns:repeat(2,1fr); gap:3px 12px; font-size:13px; margin-top:6px; }
    .tag { font-size:12px; padding:1px 7px; border-radius:999px; border:1px solid var(--line); }
    .tag.s-待签认 { background:#f7ecd2; color:var(--hold); border-color:#e2cd93; }
    .tag.s-已签认 { background:#e4ecd9; color:#3f5733; border-color:#c2d3ae; }
    .tag.s-已作废 { background:#f0e2de; color:var(--warn); border-color:#e4bdb1; }
    .err { color:var(--warn); font-size:13px; margin-top:8px; min-height:16px; }
    .ok { color:var(--accent); font-size:13px; margin-top:8px; min-height:16px; }
    .rules li { margin:4px 0; }
    .hidden { display:none; }
    @media (max-width:960px){ header{display:block;padding:16px} main{grid-template-columns:1fr;padding:14px} }
  </style>
</head>
<body>
  <header>
    <div>
      <h1>纸浆三班交接观察单</h1>
      <div class="meta">每缸每班一张 · 记录人 / 温度 / 气味 / 纤维 / 换水 · 当前：<span id="currentShift"></span></div>
    </div>
    <button id="reload">刷新</button>
  </header>
  <main>
    <section>
      <form id="createForm">
        <h2>新增纸浆批次</h2>
        <div id="fields"></div>
        <div class="row"><button>建档</button></div>
        <div class="err" data-err="create"></div>
      </form>

      <form id="sheetForm">
        <h2>本班观察记录</h2>
        <label>浸泡缸</label>
        <select name="vat" id="sheetVat"></select>
        <div class="meta" id="targetInfo"></div>
        <label>记录人</label><input name="recorder" id="recorderName" required>
        <label>温度（℃）</label><input name="temperature" required placeholder="如 25.1">
        <label>气味</label><input name="smell" required placeholder="如 微酸；霉/臭/腐判异常">
        <label>纤维松散度</label><input name="fiber" required placeholder="如 开始松散 / 松散 / 成束">
        <label>是否换水</label>
        <select name="changedWater" required><option value="">请选择</option><option value="否">否</option><option value="是">是</option></select>
        <div class="row"><button>提交观察单（待签认）</button></div>
        <div class="err" data-err="sheet"></div>
      </form>

      <form id="signForm">
        <h2>上班签认</h2>
        <label>待签认观察单</label>
        <select name="id" id="signSelect"></select>
        <label>签认人（上班）</label><input name="signer" id="signerName" required>
        <div class="meta">签认前下个班只能看，不能追加或改阶段；签认后读数锁定，需补改走下方并连带作废后续班次。</div>
        <div class="row"><button>签认</button></div>
        <div class="err" data-err="sign"></div>
      </form>

      <form id="amendForm">
        <h2>签认后补改原始读数</h2>
        <label>选择观察单</label>
        <select name="id" id="amendSelect"></select>
        <div class="meta warn" id="amendWarn"></div>
        <label>补改人</label><input name="by" required>
        <label>补改原因</label><input name="reason" required placeholder="如 温度表校准修正">
        <label>温度（℃）</label><input name="temperature" required>
        <label>气味</label><input name="smell" required>
        <label>纤维松散度</label><input name="fiber" required>
        <label>是否换水</label>
        <select name="changedWater" required><option value="否">否</option><option value="是">是</option></select>
        <div class="row"><button class="danger" type="submit">补改并连带作废后续班次</button></div>
        <div class="err" data-err="amend"></div>
      </form>

      <form id="draftForm">
        <h2>修改本班待签认单</h2>
        <label>观察单</label><select name="id" id="draftSelect"></select>
        <label>记录人</label><input name="recorder" required>
        <label>温度（℃）</label><input name="temperature" required>
        <label>气味</label><input name="smell" required>
        <label>纤维松散度</label><input name="fiber" required>
        <label>是否换水</label>
        <select name="changedWater" required><option value="否">否</option><option value="是">是</option></select>
        <div class="row"><button class="secondary">修改读数（不影响后续班次）</button></div>
        <div class="err" data-err="draft"></div>
      </form>
    </section>

    <section>
      <div class="notice">
        <b>交接规则</b>
        <ol class="rules" style="margin:6px 0 0 18px;padding:0">
          <li>三班轮换：${SHIFTS.map(s => s.name + " " + String(s.start).padStart(2, "0") + ":00-" + (s.name === "中班" ? "24" : String(s.start + 8).padStart(2, "0")) + ":00").join("，")}。</li>
          <li>每缸每班只留一张观察单，上一张签认后才能记本班；上班签认前下个班只能看，不能追加或改阶段。</li>
          <li>温度或换水等原始读数签认后补改，本单之后各班观察单与缸位阶段一起作废，由后续班次重排补记；缸位阶段满 ${READY_DAYS} 天（换水后重新起算）为可抄纸，异味霉点为异常观察。</li>
        </ol>
      </div>
      <div id="lockedNotice"></div>
      <div class="vats" id="vats"></div>
    </section>
  </main>
  <script>
    const createFields = ${JSON.stringify(fields)};
    let view = null;
    const $ = sel => document.querySelector(sel);

    async function api(path, options) {
      const res = await fetch(path, options && options.body ? { ...options, headers: { "Content-Type": "application/json" } } : options);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "请求失败");
      return data;
    }
    function esc(v) {
      return String(v == null ? "" : v).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
    }
    function remember(id) {
      const el = $(id);
      const key = "pulp:" + id;
      el.value = localStorage.getItem(key) || "";
      el.addEventListener("change", () => localStorage.setItem(key, el.value));
    }

    function renderForms() {
      $("#fields").innerHTML = createFields.map(([key, label, type]) =>
        '<label>' + label + '</label><input name="' + key + '" type="' + type + '"' + (key === "code" ? " required" : "") + (key === "vat" ? ' list="vatList"' : "") + ">"
      ).join("") + '<datalist id="vatList"></datalist>';
    }

    function boolText(v) { return v ? "是" : "否"; }

    function sheetHtml(s) {
      const revisions = (s.revisions || []).map(r =>
        '<div class="meta">补改于 ' + esc(r.at.slice(0, 16).replace("T", " ")) + " · " + esc(r.by) + "：" + esc(r.reason) +
        "（原读数 " + esc(r.readings.temperature) + "℃ / " + esc(r.readings.smell) + " / " + esc(r.readings.fiber) + " / 换水" + (r.readings.changedWater ? "是" : "否") + "）</div>"
      ).join("");
      const voidInfo = s.status === "已作废"
        ? '<div class="meta" style="color:var(--warn)">已作废：' + esc(s.voidReason || "") + "（" + esc(s.voidedBy || "") + "）</div>"
        : "";
      return '<div class="sheet ' + (s.status === "已作废" ? "voided" : "") + '">' +
        '<div class="row" style="margin:0;justify-content:space-between">' +
          '<b>' + esc(s.label) + '</b><span class="tag s-' + esc(s.status) + '">' + esc(s.status) + "</span>" +
        "</div>" +
        '<div class="readings"><span>记录人：' + esc(s.recorder) + "</span><span>温度：" + esc(s.temperature) + "℃</span>" +
          "<span>气味：" + esc(s.smell) + (s.abnormal && s.status !== "已作废" ? ' <span class="pill gap">异常</span>' : "") + "</span>" +
          "<span>纤维：" + esc(s.fiber) + "</span><span>换水：" + boolText(s.changedWater) + "</span>" +
          "<span>签认：" + esc(s.signer || "—") + "</span></div>" +
        revisions + voidInfo +
      "</div>";
    }

    function vatHtml(v) {
      const pendingPills = v.pending.map(p => '<span class="pill pending">待签认：' + esc(labelOf(p.slot)) + "</span>").join(" ");
      const gapPills = v.gaps.map(g => '<span class="pill gap">断档：' + esc(labelOf(g)) + "</span>").join(" ");
      const batches = v.batches.length
        ? v.batches.map(b => esc(b.code) + "（" + esc(b.source || "") + "，" + esc(b.owner || "") + "）").join("、")
        : "暂无批次";
      let line = '<span class="meta">阶段依据：';
      if (v.stage === "入缸") line += "尚无签认观察单</span>";
      else if (v.stageAbnormal) line += "最近签认单气味异常</span>";
      else line += "自" + esc(v.baseline) + "起第 " + (v.stageDays + 1) + " 天</span>";
      const blocked = v.blocked ? '<div class="notice warn" style="margin-top:10px;padding:8px 10px">🔒 ' + esc(v.blocked) + "</div>" : "";
      return '<article class="card"><div class="vat-head"><h3>' + esc(v.vat) + '</h3><span class="pill stage-' + esc(v.stage) + '">' + esc(v.stage) + "</span></div>" +
        '<div class="meta" style="margin-top:6px">批次：' + batches + "</div>" +
        '<div class="row">' + pendingPills + gapPills + "</div>" + line + blocked +
        '<div class="sheets">' + (v.sheets.length ? v.sheets.map(sheetHtml).join("") : '<div class="meta">本缸还没有观察单</div>') + "</div>" +
      "</article>";
    }

    function labelOf(key) {
      const [d, i] = key.split("#");
      const [, m, day] = d.split("-");
      return Number(m) + "月" + Number(day) + "日 " + ["夜班", "早班", "中班"][Number(i)];
    }

    function optionsFor(selectId, entries, emptyText) {
      const sel = $(selectId);
      const prev = sel.value;
      sel.innerHTML = (entries.length ? "" : '<option value="">' + emptyText + "</option>") +
        entries.map(e => '<option value="' + esc(e.value) + '">' + esc(e.text) + "</option>").join("");
      if ([...sel.options].some(o => o.value === prev)) sel.value = prev;
    }

    function renderSelectors() {
      const vats = view.vats;
      // 缸位下拉：无缸时手填
      $("#sheetVat").innerHTML = (vats.length ? "" : '<option value="">（请直接输入缸名）</option>') +
        vats.map(v => "<option>" + esc(v.vat) + "</option>").join("");
      const list = $("#vatList");
      if (list) list.innerHTML = vats.map(v => "<option>" + esc(v.vat) + "</option>").join("");

      const pending = [];
      const signed = [];
      for (const v of vats) for (const s of v.sheets) {
        if (s.status === "待签认") pending.push({ value: s.id, text: v.vat + " · " + s.label });
        if (s.status === "已签认") signed.push({ value: s.id, text: v.vat + " · " + s.label });
      }
      optionsFor("#signSelect", pending, "无待签认单");
      optionsFor("#draftSelect", pending, "无待签认单");
      optionsFor("#amendSelect", signed, "无已签认单");
      fillDraft();
      fillAmend();
    }

    function findSheet(id) {
      for (const v of view.vats) {
        const s = v.sheets.find(x => x.id === id);
        if (s) return { vat: v.vat, sheet: s };
      }
      return null;
    }

    function fillDraft() {
      const found = findSheet($("#draftSelect").value);
      const f = $("#draftForm");
      if (!found) {
        f.querySelectorAll("input:not([name=recorder])").forEach(i => i.value = "");
        return;
      }
      const s = found.sheet;
      f.recorder.value = s.recorder;
      f.temperature.value = s.temperature;
      f.smell.value = s.smell;
      f.fiber.value = s.fiber;
      f.changedWater.value = s.changedWater ? "是" : "否";
    }

    function fillAmend() {
      const found = findSheet($("#amendSelect").value);
      const warn = $("#amendWarn");
      if (!found) { warn.textContent = ""; return; }
      const s = found.sheet;
      const f = $("#amendForm");
      f.temperature.value = s.temperature;
      f.smell.value = s.smell;
      f.fiber.value = s.fiber;
      f.changedWater.value = s.changedWater ? "是" : "否";
      warn.textContent = "补改 " + found.vat + " " + s.label + " 将作废其后所有有效观察单并按新读数重排阶段。";
    }

    function render() {
      $("#currentShift").textContent = view.currentLabel;
      $("#vats").innerHTML = view.vats.length ? view.vats.map(vatHtml).join("") : '<div class="panel meta">还没有缸位，请先建档或在左侧登记观察单。</div>';
      const lockedVats = view.vats.filter(v => v.blocked);
      $("#lockedNotice").innerHTML = lockedVats.length
        ? '<div class="notice warn">🔒 待签认期间只读：' + lockedVats.map(v => esc(v.vat) + "（" + v.blocked + "）").join("；") + "</div>"
        : "";
      renderSelectors();
      const info = $("#targetInfo");
      const vat = view.vats.find(v => v.vat === $("#sheetVat").value);
      if (!vat) info.textContent = "";
      else if (vat.blocked) info.innerHTML = '<span style="color:var(--warn)">' + esc(vat.blocked) + "</span>";
      else if (vat.canRecord) info.innerHTML = "本次记录班次：<b>" + labelOf(vat.targetSlot) + "</b>（每缸每班一张，提交后待上班签认）";
      else info.innerHTML = '<span style="color:var(--warn)">最早待补班次为 ' + labelOf(vat.targetSlot) + "，存在断档，须由该班次起逐班补记，不能直接记本班</span>";
    }

    async function load() {
      view = await api("/api/overview");
      render();
    }

    function showErr(formName, msg, ok) {
      const el = document.querySelector('[data-err="' + formName + '"]');
      el.className = ok ? "ok" : "err";
      el.textContent = msg || "";
      if (msg) setTimeout(() => { if (el.textContent === msg) { el.textContent = ""; el.className = "err"; } }, 5000);
    }
    remember("#recorderName");
    remember("#signerName");
    renderForms();

    $("#createForm").onsubmit = async ev => {
      ev.preventDefault();
      const f = ev.target;
      try {
        const payload = Object.fromEntries(new FormData(f).entries());
        await api("/api/items", { method: "POST", body: JSON.stringify(payload) });
        f.reset();
        await load();
        showErr("create", "批次已建档", true);
      } catch (e) { showErr("create", e.message); }
    };

    $("#sheetForm").onsubmit = async ev => {
      ev.preventDefault();
      const f = ev.target;
      try {
        const payload = Object.fromEntries(new FormData(f).entries());
        await api("/api/vats/" + encodeURIComponent(payload.vat) + "/sheets", { method: "POST", body: JSON.stringify(payload) });
        f.reset();
        f.recorder.value = localStorage.getItem("pulp:#recorderName") || "";
        await load();
        showErr("sheet", "观察单已提交，等待上班签认", true);
      } catch (e) { showErr("sheet", e.message); }
    };

    $("#signForm").onsubmit = async ev => {
      ev.preventDefault();
      const f = ev.target;
      try {
        const payload = Object.fromEntries(new FormData(f).entries());
        await api("/api/sheets/" + encodeURIComponent(payload.id) + "/sign", { method: "POST", body: JSON.stringify(payload) });
        f.reset();
        f.signer.value = localStorage.getItem("pulp:#signerName") || "";
        await load();
        showErr("sign", "已签认，后续班次可以继续记录", true);
      } catch (e) { showErr("sign", e.message); }
    };

    $("#draftForm").onsubmit = async ev => {
      ev.preventDefault();
      const f = ev.target;
      try {
        const payload = Object.fromEntries(new FormData(f).entries());
        await api("/api/sheets/" + encodeURIComponent(payload.id), { method: "PATCH", body: JSON.stringify(payload) });
        await load();
        showErr("draft", "待签认单读数已更新", true);
      } catch (e) { showErr("draft", e.message); }
    };

    $("#amendForm").onsubmit = async ev => {
      ev.preventDefault();
      const f = ev.target;
      try {
        const payload = Object.fromEntries(new FormData(f).entries());
        if (!confirm("补改将作废该缸其后所有未作废观察单并重排阶段，确认继续？")) return;
        const res = await api("/api/sheets/" + encodeURIComponent(payload.id) + "/amend", { method: "POST", body: JSON.stringify(payload) });
        f.reset();
        await load();
        showErr("amend", "已补改，连带作废 " + res.voided.length + " 张后续观察单", true);
      } catch (e) { showErr("amend", e.message); }
    };

    $("#draftSelect").onchange = fillDraft;
    $("#amendSelect").onchange = fillAmend;
    $("#sheetVat").onchange = render;
    $("#reload").onclick = load;
    load();
  </script>
</body>
</html>`;
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const p = url.pathname;
    const now = new Date();
    const db = await loadDb();

    if (req.method === "GET" && p === "/") return html(res, page());
    if (req.method === "GET" && p === "/api/overview") return send(res, 200, overview(db, db.items, now));
    if (req.method === "GET" && p === "/api/items") return send(res, 200, db.items);

    if (req.method === "POST" && p === "/api/items") {
      const input = await body(req);
      if (!String(input.code || "").trim()) throw new RuleError("批次编号必须填写");
      if (!String(input.vat || "").trim()) throw new RuleError("浸泡缸必须填写");
      const item = {
        id: newItemId(),
        code: String(input.code).trim(),
        source: String(input.source || "").trim(),
        vat: String(input.vat).trim(),
        days: Number(input.days || 0),
        owner: String(input.owner || "").trim(),
        status: "入缸",
        logs: [{ at: now.toISOString(), step: "建档", note: "创建纸浆批次，缸位阶段以交接观察单为准" }]
      };
      db.items.unshift(item);
      await saveDb(db);
      return send(res, 201, item);
    }

    // 本班观察记录：POST /api/vats/:vat/sheets
    const create = p.match(/^\/api\/vats\/(.+)\/sheets$/);
    if (create && req.method === "POST") {
      const vat = decodeURIComponent(create[1]);
      const input = await body(req);
      const sheet = createSheet(db, vat, input, now, newSheetId);
      await saveDb(db);
      return send(res, 201, sheet);
    }

    // 修改待签认单：PATCH /api/sheets/:id
    const draft = p.match(/^\/api\/sheets\/([^/]+)$/);
    if (draft && req.method === "PATCH") {
      const sheet = updateDraft(db, draft[1], await body(req));
      await saveDb(db);
      return send(res, 200, sheet);
    }

    // 上班签认：POST /api/sheets/:id/sign
    const sign = p.match(/^\/api\/sheets\/([^/]+)\/sign$/);
    if (sign && req.method === "POST") {
      const sheet = signSheet(db, sign[1], await body(req), now);
      await saveDb(db);
      return send(res, 200, sheet);
    }

    // 签认后补改：POST /api/sheets/:id/amend（连带作废后续班次，阶段重算）
    const amend = p.match(/^\/api\/sheets\/([^/]+)\/amend$/);
    if (amend && req.method === "POST") {
      const result = amendSheet(db, amend[1], await body(req), now);
      await saveDb(db);
      return send(res, 200, result);
    }

    return send(res, 404, { error: "not_found" });
  } catch (error) {
    if (error instanceof RuleError) return send(res, 400, { error: error.message });
    return send(res, 500, { error: error.message });
  }
});

server.listen(port, () => console.log("纸浆三班交接观察单 listening on http://localhost:" + port));
