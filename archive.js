// 班次档案：缸位册 + 观察单册的存取，首次开账时建一份示例档案
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { currentSlot, slotFromIndex, slotIndex, resequenceVat } from "./rules.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const archivePath = join(__dirname, "data", "shift-archive.json");

export async function loadArchive() {
  if (!existsSync(archivePath)) {
    await mkdir(dirname(archivePath), { recursive: true });
    await saveArchive(seedArchive());
  }
  return JSON.parse(await readFile(archivePath, "utf8"));
}

export async function saveArchive(archive) {
  await writeFile(archivePath, JSON.stringify(archive, null, 2));
}

function seedArchive() {
  const at = new Date().toISOString();
  const current = slotIndex(currentSlot());
  const slot = offset => slotFromIndex(current + offset);
  const vats = [
    { id: "VAT-1", name: "一号缸", source: "构树皮", initialStage: "入缸", stage: "入缸", stageSeq: 0, stageLog: [], createdAt: at },
    { id: "VAT-2", name: "二号缸", source: "桑皮", initialStage: "入缸", stage: "入缸", stageSeq: 0, stageLog: [], createdAt: at },
    { id: "VAT-3", name: "三号缸", source: "楮皮", initialStage: "入缸", stage: "入缸", stageSeq: 0, stageLog: [], createdAt: at },
  ];
  const sheet = (id, vatId, offset, status, body) => ({
    id,
    vatId,
    slot: slot(offset),
    ...body,
    status,
    signedBy: status === "signed" ? body.recorder : null,
    signedAt: status === "signed" ? at : null,
    corrections: [],
    voidReason: null,
    voidedAt: null,
    stageSeq: null,
    createdAt: at,
    updatedAt: at,
  });
  const archive = {
    vats,
    sheets: [
      // 一号缸：前两班已签，本班草稿待签认
      sheet("SH-1", "VAT-1", -2, "signed", { recorder: "林素", temperature: "24.6", smell: "微酸", fiber: "开始松散", waterChanged: false, stage: "发酵中" }),
      sheet("SH-2", "VAT-1", -1, "signed", { recorder: "林素", temperature: "25.1", smell: "酸香", fiber: "松散", waterChanged: true, stage: "发酵中" }),
      sheet("SH-3", "VAT-1", 0, "draft", { recorder: "阿禾", temperature: "25.4", smell: "酸香", fiber: "明显松散", waterChanged: false, stage: "发酵中" }),
      // 三号缸：两班前签过，之后断档
      sheet("SH-4", "VAT-3", -2, "signed", { recorder: "老周", temperature: "23.8", smell: "微酸", fiber: "未松散", waterChanged: false, stage: "发酵中" }),
    ],
  };
  for (const vat of archive.vats) resequenceVat(archive, vat.id);
  return archive;
}
