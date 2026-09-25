// 班次档案：交接观察单与纸浆批次的持久化。
// 单一 JSON 档案 data/paper-pulp-fermentation.json，结构 { items, sheets }。
// 档案只负责存取；三班轮换、签认、作废等业务规则全部在 rules.js。

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const dbPath = join(__dirname, "data", "paper-pulp-fermentation.json");

const seed = {
  "items": [
    {
      "code": "PF-001",
      "source": "构树皮",
      "vat": "三号缸",
      "days": 5,
      "owner": "林素",
      "status": "发酵中",
      "logs": [
        {
          "at": "2026-06-15",
          "step": "观察",
          "note": "温度24.6，气味微酸，纤维开始松散",
          "abnormal": false
        }
      ]
    }
  ],
  "sheets": []
};

export async function loadDb() {
  if (!existsSync(dbPath)) {
    await mkdir(dirname(dbPath), { recursive: true });
    await writeFile(dbPath, JSON.stringify(seed, null, 2));
    return JSON.parse(JSON.stringify(seed));
  }
  const db = JSON.parse(await readFile(dbPath, "utf8"));
  // 兼容旧档案：早期版本只有 items，没有交接观察单
  if (!Array.isArray(db.sheets)) db.sheets = [];
  if (!Array.isArray(db.items)) db.items = [];
  return db;
}

export async function saveDb(db) {
  await writeFile(dbPath, JSON.stringify(db, null, 2));
}

export function newSheetId() {
  return "HS-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 6);
}
