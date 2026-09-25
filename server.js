// 入口：HTTP 路由 + 按缸展示待签认、断档和当前阶段的页面
import http from "node:http";
import { loadArchive, saveArchive } from "./archive.js";
import {
  SHIFTS, STAGES, newId, currentSlot, slotLabel, parseSlot,
  upsertSheet, signSheet, correctSheet, vatView,
} from "./rules.js";

const port = Number(process.env.PORT || 3039);

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
}
function send(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data, null, 2));
}
function html(res, text) {
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(text);
}
function fail(res, result) {
  send(res, result.status, { error: result.reason, message: result.message });
}

function page() {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>纸浆交接观察单</title>
  <style>
    :root { --bg:#f1f3ef; --panel:#fff; --ink:#20241f; --muted:#687066; --line:#d4ddd0; --accent:#526f43; --warn:#9b4937; --amber:#a06a1b; }
    * { box-sizing:border-box; }
    body { margin:0; background:var(--bg); color:var(--ink); font-family:Arial,"PingFang SC",sans-serif; }
    header { padding:18px 28px; background:#fff; border-bottom:1px solid var(--line); display:flex; justify-content:space-between; gap:16px; align-items:center; flex-wrap:wrap; }
    h1 { margin:0; font-size:24px; } h2 { margin:0 0 12px; font-size:17px; } h3 { margin:0; font-size:16px; }
    main { display:grid; grid-template-columns:360px 1fr; gap:20px; padding:20px 28px; align-items:start; }
    form,.panel,.card,.stat { background:var(--panel); border:1px solid var(--line); border-radius:8px; padding:14px 16px; }
    label { display:block; margin:9px 0 4px; color:var(--muted); font-size:13px; }
    input,select { width:100%; border:1px solid var(--line); border-radius:6px; padding:8px; font:inherit; background:#fff; }
    button { border:0; border-radius:6px; background:var(--accent); color:#fff; padding:8px 12px; font-weight:700; cursor:pointer; }
    button.ghost { background:#69736a; }
    button.warn-btn { background:#fff; color:var(--warn); border:1px solid var(--warn); padding:4px 8px; font-weight:400; }
    .stats { display:grid; grid-template-columns:repeat(3,1fr); gap:10px; margin-bottom:14px; }
    .stat strong { display:block; font-size:22px; }
    .grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(340px,1fr)); gap:12px; }
    .card { display:grid; gap:10px; align-content:start; }
    .meta { color:var(--muted); font-size:13px; }
    .pill { display:inline-block; border:1px solid var(--line); border-radius:999px; padding:2px 9px; font-size:12px; }
    .pill.stage { background:var(--accent); color:#fff; border-color:var(--accent); }
    .pill.draft { color:var(--amber); border-color:var(--amber); }
    .pill.signed { color:var(--accent); border-color:var(--accent); }
    .pill.void { color:var(--muted); text-decoration:line-through; }
    .sect { border-top:1px dashed var(--line); padding-top:8px; }
    .sect h4 { margin:0 0 6px; font-size:13px; color:var(--muted); }
    .row { display:flex; justify-content:space-between; align-items:center; gap:8px; font-size:13px; }
    .warn { color:var(--warn); font-weight:700; }
    .gaplist { display:flex; flex-wrap:wrap; gap:6px; }
    table { width:100%; border-collapse:collapse; font-size:12.5px; }
    th,td { text-align:left; padding:5px 6px; border-bottom:1px solid var(--line); white-space:nowrap; }
    th { color:var(--muted); font-weight:400; }
    .tablewrap { overflow-x:auto; }
    .hint { font-size:12px; color:var(--muted); margin-top:8px; line-height:1.6; }
    .slotrow { display:grid; grid-template-columns:1fr 1fr; gap:8px; }
    @media (max-width:900px){ main{grid-template-columns:1fr;padding:14px;} header{padding:14px 16px;} }
  </style>
</head>
<body>
  <header>
    <div><h1>纸浆交接观察单</h1><div class="meta">三班轮换 · 每缸每班一张 · 签认后补改即作废重排</div></div>
    <div class="row"><span class="pill stage" id="nowSlot"></span><button class="ghost" id="reload">刷新</button></div>
  </header>
  <main>
    <section>
      <form id="sheetForm">
        <h2>交班观察单</h2>
        <label>缸位</label><select name="vatId" id="vatSelect" required></select>
        <div class="slotrow">
          <div><label>日期</label><input name="date" id="slotDate" type="date" required></div>
          <div><label>班次</label><select name="shift" id="slotShift"></select></div>
        </div>
        <label>记录人</label><input name="recorder" required>
        <label>温度</label><input name="temperature" required placeholder="如 24.6">
        <label>气味</label><input name="smell" placeholder="如 微酸">
        <label>纤维</label><input name="fiber" placeholder="如 开始松散">
        <label>换水</label><select name="waterChanged"><option value="否">未换水</option><option value="是">已换水</option></select>
        <label>本班判定阶段</label><select name="stage" id="stageSelect"></select>
        <div style="margin-top:10px"><button>提交观察单</button></div>
        <div class="hint">每缸每班只留一张：同班重复提交覆盖未签认的草稿；已签认的单子只能在单子上「补改」。上一班未签认时，本班只能看，不能提交。断档班次可点缸位卡片上的「补录」。</div>
      </form>
      <form id="vatForm" style="margin-top:14px">
        <h2>新缸建档</h2>
        <label>缸名</label><input name="name" required placeholder="如 四号缸">
        <label>原料</label><input name="source" placeholder="如 构树皮">
        <label>初始阶段</label><select name="stage" id="vatStageSelect"></select>
        <div style="margin-top:10px"><button class="ghost">建档</button></div>
      </form>
    </section>
    <section>
      <div class="stats" id="stats"></div>
      <div class="grid" id="cards"></div>
    </section>
  </main>
  <script>
    let state = null;
    const $ = sel => document.querySelector(sel);
    function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c])); }
    async function api(path, options) {
      const res = await fetch(path, options && options.body ? { ...options, headers: { 'Content-Type': 'application/json' } } : options);
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || data.error || '请求失败');
      return data;
    }
    async function load() { state = await api('/api/state'); render(); }
    function slotText(slot) { return slot.date.slice(5) + ' ' + slot.shift; }
    function findSheet(id) {
      for (const v of state.vats) { const s = v.sheets.find(x => x.id === id); if (s) return s; }
      return null;
    }
    function statusPill(s) {
      if (s.status === 'draft') return '<span class="pill draft">待签认</span>';
      if (s.status === 'signed') return '<span class="pill signed">已签认 · 序号' + s.stageSeq + '</span>';
      return '<span class="pill void">已作废</span>';
    }
    function cardHtml(v) {
      const pend = v.pending.length
        ? v.pending.map(s => '<div class="row"><span>' + slotText(s.slot) + ' · ' + esc(s.recorder) + ' · 温度 ' + esc(s.temperature) + (s.waterChanged ? ' · 已换水' : '') + '</span><button data-sign="' + s.id + '">签认</button></div>').join('')
        : '<div class="meta">无待签认</div>';
      const gaps = v.gaps.length
        ? '<div class="gaplist">' + v.gaps.map(g => '<button class="warn-btn" data-gap data-vat="' + v.id + '" data-date="' + g.date + '" data-shift="' + g.shift + '">补录 ' + esc(g.label) + '</button>').join('') + '</div>'
        : '<div class="meta">无断档</div>';
      const rows = v.sheets.slice(0, 8).map(s =>
        '<tr><td>' + slotText(s.slot) + '</td><td>' + esc(s.recorder) + '</td><td>' + esc(s.temperature) + '</td><td>' + esc(s.smell) + '</td><td>' + esc(s.fiber) + '</td><td>' + (s.waterChanged ? '已换' : '未换') + '</td><td>' + esc(s.stage || '') + '</td><td>' + statusPill(s)
        + (s.corrections && s.corrections.length ? '<div class="meta">补改×' + s.corrections.length + '：' + esc(s.corrections[s.corrections.length - 1].reason) + '</div>' : '')
        + (s.status === 'void' && s.voidReason ? '<div class="meta">' + esc(s.voidReason) + '</div>' : '')
        + '</td><td>' + (s.status === 'signed' ? '<button class="ghost" data-correct="' + s.id + '">补改</button>' : '') + '</td></tr>').join('');
      const gate = v.gate.ok ? '' : '<div class="warn meta">本班只读：' + esc(v.gate.message) + '</div>';
      return '<article class="card">'
        + '<div class="row"><h3>' + esc(v.name) + '</h3><span class="pill stage">' + esc(v.stage) + '</span></div>'
        + '<div class="meta">' + esc(v.source || '未登记原料') + ' · 阶段序号 #' + v.stageSeq + '</div>'
        + gate
        + '<div class="sect"><h4>待签认</h4>' + pend + '</div>'
        + '<div class="sect"><h4>断档</h4>' + gaps + '</div>'
        + '<div class="sect"><h4>观察单</h4><div class="tablewrap"><table><thead><tr><th>班次</th><th>记录人</th><th>温度</th><th>气味</th><th>纤维</th><th>换水</th><th>阶段</th><th>状态</th><th></th></tr></thead><tbody>'
        + (rows || '<tr><td colspan="9" class="meta">尚无观察单</td></tr>')
        + '</tbody></table></div></div></article>';
    }
    function render() {
      $('#nowSlot').textContent = '当前班次 ' + state.now.label;
      const keepVat = $('#vatSelect').value;
      $('#vatSelect').innerHTML = state.vats.map(v => '<option value="' + v.id + '">' + esc(v.name) + '</option>').join('');
      if (keepVat) $('#vatSelect').value = keepVat;
      const pendCount = state.vats.reduce((n, v) => n + v.pending.length, 0);
      const gapCount = state.vats.reduce((n, v) => n + v.gaps.length, 0);
      $('#stats').innerHTML = '<div class="stat"><span>缸位</span><strong>' + state.vats.length + '</strong></div>'
        + '<div class="stat"><span>待签认</span><strong>' + pendCount + '</strong></div>'
        + '<div class="stat"><span>断档班次</span><strong>' + gapCount + '</strong></div>';
      $('#cards').innerHTML = state.vats.map(cardHtml).join('');
      bind();
      syncStage();
    }
    function bind() {
      document.querySelectorAll('[data-sign]').forEach(btn => btn.onclick = async () => {
        const sheet = findSheet(btn.dataset.sign);
        const signedBy = prompt('签认人（' + slotText(sheet.slot) + ' · 记录人 ' + sheet.recorder + '）', sheet.recorder);
        if (!signedBy) return;
        try { await api('/api/sheets/' + btn.dataset.sign + '/sign', { method: 'POST', body: JSON.stringify({ signedBy }) }); await load(); }
        catch (e) { alert(e.message); }
      });
      document.querySelectorAll('[data-correct]').forEach(btn => btn.onclick = () => correctFlow(btn.dataset.correct));
      document.querySelectorAll('[data-gap]').forEach(btn => btn.onclick = () => {
        $('#vatSelect').value = btn.dataset.vat;
        $('#slotDate').value = btn.dataset.date;
        $('#slotShift').value = btn.dataset.shift;
        syncStage();
        $('#sheetForm').scrollIntoView({ behavior: 'smooth' });
      });
    }
    async function correctFlow(id) {
      const s = findSheet(id);
      if (!s) return;
      const temperature = prompt('补改温度（原：' + s.temperature + '）', s.temperature);
      if (temperature === null) return;
      const smell = prompt('补改气味（原：' + (s.smell || '无') + '）', s.smell);
      if (smell === null) return;
      const fiber = prompt('补改纤维（原：' + (s.fiber || '无') + '）', s.fiber);
      if (fiber === null) return;
      const water = prompt('是否换水（是/否，原：' + (s.waterChanged ? '是' : '否') + '）', s.waterChanged ? '是' : '否');
      if (water === null) return;
      const corrector = prompt('补改人');
      if (!corrector) return;
      const reason = prompt('补改原因（后续班次的单子和缸位阶段将一起作废重排）');
      if (!reason) return;
      try {
        const r = await api('/api/sheets/' + id + '/correct', { method: 'POST', body: JSON.stringify({ temperature, smell, fiber, waterChanged: water, corrector, reason }) });
        alert('已补改，作废后续班次 ' + r.voided.length + ' 张，缸位阶段已重排');
        await load();
      } catch (e) { alert(e.message); }
    }
    function syncStage() {
      const v = state && state.vats.find(x => x.id === $('#vatSelect').value);
      if (v) $('#stageSelect').value = v.stage;
    }
    $('#sheetForm').onsubmit = async e => {
      e.preventDefault();
      const data = Object.fromEntries(new FormData($('#sheetForm')).entries());
      try { await api('/api/vats/' + data.vatId + '/sheets', { method: 'POST', body: JSON.stringify(data) }); await load(); }
      catch (err) { alert(err.message); }
    };
    $('#vatForm').onsubmit = async e => {
      e.preventDefault();
      const data = Object.fromEntries(new FormData($('#vatForm')).entries());
      try { await api('/api/vats', { method: 'POST', body: JSON.stringify(data) }); $('#vatForm').reset(); await load(); }
      catch (err) { alert(err.message); }
    };
    $('#vatSelect').onchange = syncStage;
    $('#reload').onclick = load;
    async function init() {
      await load();
      $('#slotShift').innerHTML = state.shifts.map(s => '<option>' + s + '</option>').join('');
      $('#stageSelect').innerHTML = state.stages.map(s => '<option>' + s + '</option>').join('');
      $('#vatStageSelect').innerHTML = state.stages.map(s => '<option>' + s + '</option>').join('');
      $('#slotDate').value = state.now.date;
      $('#slotShift').value = state.now.shift;
      syncStage();
    }
    init();
  </script>
</body>
</html>`;
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (req.method === "GET" && url.pathname === "/") return html(res, page());
    const archive = await loadArchive();
    if (req.method === "GET" && url.pathname === "/api/state") {
      const nowSlot = currentSlot();
      return send(res, 200, {
        now: { ...nowSlot, label: slotLabel(nowSlot) },
        shifts: SHIFTS,
        stages: STAGES,
        vats: archive.vats.map(vat => vatView(archive, vat, nowSlot)),
      });
    }
    if (req.method === "POST" && url.pathname === "/api/vats") {
      const input = await readBody(req);
      const name = String(input.name || "").trim();
      if (!name) return send(res, 400, { error: "name_required", message: "缸名不能为空" });
      if (archive.vats.some(v => v.name === name)) return send(res, 409, { error: "vat_exists", message: "缸名已存在" });
      const stage = STAGES.includes(input.stage) ? input.stage : STAGES[0];
      const vat = {
        id: newId("VAT"),
        name,
        source: String(input.source || "").trim(),
        initialStage: stage,
        stage,
        stageSeq: 0,
        stageLog: [],
        createdAt: new Date().toISOString(),
      };
      archive.vats.push(vat);
      await saveArchive(archive);
      return send(res, 201, vat);
    }
    const sheetRoute = url.pathname.match(/^\/api\/vats\/([^/]+)\/sheets$/);
    if (sheetRoute && req.method === "POST") {
      const input = await readBody(req);
      const result = upsertSheet(archive, sheetRoute[1], parseSlot(input), input);
      if (!result.ok) return fail(res, result);
      await saveArchive(archive);
      return send(res, result.created ? 201 : 200, result.sheet);
    }
    const signRoute = url.pathname.match(/^\/api\/sheets\/([^/]+)\/sign$/);
    if (signRoute && req.method === "POST") {
      const input = await readBody(req);
      const result = signSheet(archive, signRoute[1], input.signedBy);
      if (!result.ok) return fail(res, result);
      await saveArchive(archive);
      return send(res, 200, result.sheet);
    }
    const correctRoute = url.pathname.match(/^\/api\/sheets\/([^/]+)\/correct$/);
    if (correctRoute && req.method === "POST") {
      const input = await readBody(req);
      const result = correctSheet(archive, correctRoute[1], input);
      if (!result.ok) return fail(res, result);
      await saveArchive(archive);
      return send(res, 200, { sheet: result.sheet, voided: result.voided });
    }
    send(res, 404, { error: "not_found" });
  } catch (error) {
    send(res, 500, { error: error.message });
  }
});

server.listen(port, () => console.log("纸浆交接观察单 listening on http://localhost:" + port));
