import { createHash } from "node:crypto";
import { googleRequest, googleSheetsConfigured } from "@/lib/google-sheets";
import type { MaterialItem } from "@/lib/types";
import { UserFacingError } from "@/lib/user-facing-error";

export type MaterialSheetSnapshot = {
  spreadsheetId: string;
  sheetName: string;
  layout: "header_row" | "team_sections";
  teamNumber: number;
  teamName: string;
  leaderLoginId: string;
  leaderName: string;
  columnMapping?: Record<string, string>;
  targetKey: string;
  submittedAt: string;
  items: MaterialItem[];
  previousOperationId?: string;
};
type GridRange = { sheetId: number; startRowIndex: number; endRowIndex: number; startColumnIndex: number; endColumnIndex: number };
type NamedRange = { namedRangeId: string; name: string; range: GridRange };
type Metadata = {
  sheets?: { properties: { sheetId: number; title: string; gridProperties: { rowCount: number } } }[];
  namedRanges?: NamedRange[];
};
export type MaterialSheetBatch = { requests: Record<string, unknown>[]; receiptId: string; sheetName: string; rowCount: number };
const key = (prefix: string, value: string) => `${prefix}_${createHash("sha256").update(value).digest("hex")}`;
const receiptId = (id: string) => key("science_material_receipt", id);
const quote = (name: string) => `'${name.replaceAll("'", "''")}'`;
const cell = (value: string | number) => ({ userEnteredValue: typeof value === "number" ? { numberValue: value } : { stringValue: value } });
const formula = (value: string) => ({ userEnteredValue: { formulaValue: value } });

async function metadata(spreadsheetId: string) {
  if (!googleSheetsConfigured()) throw new UserFacingError("Google Sheets 서비스 계정 연결 대기 중");
  return googleRequest<Metadata>(spreadsheetId, "?fields=sheets.properties(sheetId,title,gridProperties.rowCount),namedRanges");
}

// Only this immutable batch is retried. Adding an already existing receipt ID
// invalidates the entire atomic batch, including its row insertions and writes.
export async function executeMaterialSheetTransfer(spreadsheetId: string, batch: MaterialSheetBatch) {
  const recorded = async () => (await metadata(spreadsheetId)).namedRanges?.some(range => range.namedRangeId === batch.receiptId);
  if (await recorded()) return { sheetName: batch.sheetName, rowCount: batch.rowCount };
  try {
    await googleRequest(spreadsheetId, ":batchUpdate", { method: "POST", body: JSON.stringify({ requests: batch.requests }) });
  } catch (error) {
    // This also handles an applied write whose HTTP response was lost.
    if (!await recorded().catch(() => false)) throw error;
  }
  return { sheetName: batch.sheetName, rowCount: batch.rowCount };
}

export async function prepareMaterialSheetTransfer(input: MaterialSheetSnapshot, operationId: string): Promise<MaterialSheetBatch> {
  const meta = await metadata(input.spreadsheetId);
  const sheet = meta.sheets?.find(value => value.properties.title === input.sheetName)?.properties;
  if (!sheet) throw new UserFacingError("고정된 준비물 운영 탭을 찾을 수 없습니다. 담당 교사가 연결을 확인해 주세요.");
  const requests: Record<string, unknown>[] = [];
  const readRows = async (range: string) => (await googleRequest<{ values?: (string | number)[][] }>(input.spreadsheetId,
    `/values/${encodeURIComponent(`${quote(input.sheetName)}!${range}`)}?valueRenderOption=FORMULA`)).values ?? [];
  let targetRange: GridRange;
  if (input.layout === "team_sections") {
    const rows = await readRows("A1:J200");
    const starts = rows.flatMap((row, index) => index >= 7 && String(row[0] ?? "") === String(input.teamNumber) ? [index] : []);
    const start = starts[0];
    const end = rows.findIndex((row, index) => index > start && String(row[0] ?? "").trim() === `${input.teamNumber}조`);
    if (starts.length !== 1 || end < 0) throw new UserFacingError("해당 조의 입력 영역을 하나만 확인할 수 있어야 전송할 수 있습니다.");
    const capacity = Math.max(end - start, input.items.length);
    if (capacity > end - start) requests.push({ insertDimension: {
      range: { sheetId: sheet.sheetId, dimension: "ROWS", startIndex: end, endIndex: end + capacity - (end - start) }, inheritFromBefore: true,
    } });
    const values = Array.from({ length: capacity }, (_, offset) => {
      const item = input.items[offset];
      const row = start + offset + 1;
      return { values: [cell(offset === 0 ? input.teamNumber : ""), cell(offset === 0 ? input.leaderLoginId : ""), cell(offset === 0 ? input.leaderName : ""),
        cell(item?.name ?? ""), cell(item?.specification ?? ""), cell(item?.unitPrice ?? ""), cell(item?.quantity ?? ""), cell(item?.shipping ?? ""),
        formula(`=IF(COUNTA(D${row}:H${row})=0,"",(F${row}*G${row})+H${row})`), cell(item?.link ?? "")] };
    });
    values.push({ values: [cell(`${input.teamNumber}조`), ...Array.from({ length: 7 }, () => cell("")), formula(`=SUM(I${start + 1}:I${start + capacity})`), cell("")] });
    targetRange = { sheetId: sheet.sheetId, startRowIndex: start, endRowIndex: start + capacity + 1, startColumnIndex: 0, endColumnIndex: 10 };
    requests.push({ updateCells: { range: targetRange, rows: values, fields: "userEnteredValue" } });
  } else {
    const standardKeys = ["submittedAt", "teamName", "leaderLoginId", "leaderName", "name", "specification", "unitPrice", "quantity", "shipping", "total", "link"];
    const headers = (await readRows("1:1"))[0]?.map(value => String(value).trim()) ?? [];
    const mapping = input.columnMapping ?? {};
    const columns = Object.keys(mapping).length ? Object.entries(mapping).map(([name, header]) => {
      const index = headers.indexOf(header);
      if (index < 0 || headers.lastIndexOf(header) !== index) throw new UserFacingError("연결한 열 제목이 없거나 중복되어 전송할 수 없습니다.");
      if (!standardKeys.includes(name)) throw new UserFacingError("지원하지 않는 준비물 열 연결입니다.");
      return { name, index };
    }) : standardKeys.map((name, index) => ({ name, index }));
    const targetId = key("science_material_target", input.targetKey);
    const existing = meta.namedRanges?.find(value => value.namedRangeId === targetId);
    if (input.previousOperationId && !existing) throw new UserFacingError("이전 신청의 입력 위치 기록이 없습니다. 중복 방지를 위해 담당 교사의 확인이 필요합니다.");
    if (existing && existing.range.sheetId !== sheet.sheetId) throw new UserFacingError("기존 신청 위치와 운영 탭이 다릅니다.");
    const width = Math.max(...columns.map(column => column.index)) + 1;
    // New blocks go after all existing values, including unmapped columns.
    const start = existing?.range.startRowIndex ?? Math.max(1, (await readRows(`1:${sheet.gridProperties.rowCount}`)).length);
    const oldCapacity = existing ? existing.range.endRowIndex - start : 0;
    const capacity = Math.max(oldCapacity, input.items.length);
    if (existing && capacity > oldCapacity) requests.push({ insertDimension: {
      range: { sheetId: sheet.sheetId, dimension: "ROWS", startIndex: start + oldCapacity, endIndex: start + capacity }, inheritFromBefore: true,
    } });
    else if (!existing && start + capacity > sheet.gridProperties.rowCount) requests.push({ appendDimension: { sheetId: sheet.sheetId, dimension: "ROWS", length: start + capacity - sheet.gridProperties.rowCount } });
    targetRange = { sheetId: sheet.sheetId, startRowIndex: start, endRowIndex: start + capacity, startColumnIndex: 0, endColumnIndex: width };
    // Touch mapped columns only; preserve unrelated formulas and formatting.
    for (const column of columns) requests.push({ updateCells: {
      range: { ...targetRange, startColumnIndex: column.index, endColumnIndex: column.index + 1 }, fields: "userEnteredValue",
      rows: Array.from({ length: capacity }, (_, offset) => {
        const item = input.items[offset];
        const record: Record<string, string | number> = item ? { ...item, submittedAt: input.submittedAt, teamName: input.teamName,
          leaderLoginId: input.leaderLoginId, leaderName: input.leaderName, total: item.unitPrice * item.quantity + item.shipping } : {};
        return { values: [cell(record[column.name] ?? "")] };
      }),
    } });
    const namedRange = { namedRangeId: targetId, name: targetId, range: targetRange };
    requests.push(existing ? { updateNamedRange: { namedRange, fields: "range" } } : { addNamedRange: { namedRange } });
  }
  const id = receiptId(operationId);
  // A non-data marker: no new visible column/tab, no student identifiers.
  requests.push({ addNamedRange: { namedRange: { namedRangeId: id, name: id, range: { ...targetRange, endRowIndex: targetRange.startRowIndex + 1, endColumnIndex: targetRange.startColumnIndex + 1 } } } });
  return { requests, receiptId: id, sheetName: input.sheetName, rowCount: input.items.length };
}
