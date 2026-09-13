import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock("@/lib/google-sheets", () => ({ googleRequest: mocks.request, googleSheetsConfigured: () => true }));
import { executeMaterialSheetTransfer, prepareMaterialSheetTransfer, type MaterialSheetSnapshot } from "@/lib/material-sheet-transfer";

const input: MaterialSheetSnapshot = {
  spreadsheetId: "synthetic-sheet", sheetName: "Materials", layout: "header_row", teamNumber: 1,
  teamName: "=Team()", leaderLoginId: "00100", leaderName: "+Leader", targetKey: "synthetic-session", submittedAt: "2026-09-01T00:00:00Z",
  columnMapping: { name: "품명", quantity: "갯수", specification: "규격" },
  items: [{ name: "=IMPORTXML(\"https://example.test\")", specification: "@literal", unitPrice: 10, quantity: 1, shipping: 0, link: "https://example.test" }],
};
type Range = { namedRangeId: string; name: string; range: { sheetId: number; startRowIndex: number; endRowIndex: number; startColumnIndex: number; endColumnIndex: number } };
let ranges: Range[];
let headers: string[];
let rows: (string | number)[][];
let mutations: number;
let loseReply: boolean;
let unreadableAfterWrite: boolean;
beforeEach(() => {
  ranges = []; headers = ["품명", "교사 전용", "갯수", "", "규격"]; rows = [headers, ["existing", "=SUM(A3:A4)"]];
  mutations = 0; loseReply = false; unreadableAfterWrite = false;
  mocks.request.mockReset().mockImplementation(async (_id, path, init) => {
    if (path.startsWith("?fields=")) {
      if (unreadableAfterWrite && mutations) throw new Error("Synthetic read failure");
      return structuredClone({ sheets: [{ properties: { title: "Materials", sheetId: 5, gridProperties: { rowCount: 1000 } } }], namedRanges: ranges });
    }
    if (path.startsWith("/values/")) return { values: decodeURIComponent(path).includes("!1:1?") ? [headers] : rows };
    if (path === ":batchUpdate") {
      const body = JSON.parse(init.body);
      // Google's atomic validation contract: an existing receipt invalidates
      // every request before any row insertion or cell update is applied.
      for (const request of body.requests) if (request.addNamedRange && ranges.some(range => range.namedRangeId === request.addNamedRange.namedRange.namedRangeId)) throw new Error("Duplicate named range ID");
      for (const request of body.requests) {
        if (request.addNamedRange) ranges.push(request.addNamedRange.namedRange);
        if (request.updateNamedRange) {
          const target = ranges.find(range => range.namedRangeId === request.updateNamedRange.namedRange.namedRangeId)!;
          target.range = request.updateNamedRange.namedRange.range;
        }
      }
      mutations += 1;
      if (loseReply) throw new Error("Synthetic response lost after application");
      return {};
    }
    throw new Error(`Unexpected synthetic request: ${path}`);
  });
});

it("uses explicit string cells and updates only mapped columns, including gaps", async () => {
  const batch = await prepareMaterialSheetTransfer(input, "operation-1");
  const writes = batch.requests.flatMap(request => request.updateCells ? [request.updateCells as { range: Range["range"]; rows: unknown[] }] : []);
  expect(writes.map(write => write.range.startColumnIndex)).toEqual([0, 2, 4]);
  expect(writes[0].rows).toEqual([{ values: [{ userEnteredValue: { stringValue: input.items[0].name } }] }]);
  expect(writes[0].range.startRowIndex).toBe(2);
  expect(batch.requests).not.toEqual(expect.arrayContaining([expect.objectContaining({ appendCells: expect.anything() })]));
  expect(batch.requests.at(-1)).toMatchObject({ addNamedRange: { namedRange: { namedRangeId: batch.receiptId } } });
});

it("atomically inserts structured rows, writes totals, and records the receipt", async () => {
  rows = [...Array.from({ length: 7 }, () => []), [1], ["1조"]];
  const batch = await prepareMaterialSheetTransfer({ ...input, layout: "team_sections", items: [input.items[0], input.items[0]] }, "structured-1");
  expect(mocks.request.mock.calls.every(call => call[2] == null)).toBe(true);
  expect(batch.requests).toHaveLength(3);
  expect(batch.requests[0]).toMatchObject({ insertDimension: { range: { startIndex: 8, endIndex: 9 } } });
  expect(batch.requests[1]).toMatchObject({ updateCells: { range: { startRowIndex: 7, endRowIndex: 10 } } });
  const write = batch.requests[1].updateCells as { rows: { values: unknown[] }[] };
  expect(write.rows[0].values[3]).toEqual({ userEnteredValue: { stringValue: input.items[0].name } });
  expect(write.rows[2].values[8]).toEqual({ userEnteredValue: { formulaValue: "=SUM(I8:I9)" } });
  await executeMaterialSheetTransfer(input.spreadsheetId, batch);
  await executeMaterialSheetTransfer(input.spreadsheetId, batch);
  expect(mutations).toBe(1);
});

it("recognizes a successful batch even when the write response was lost", async () => {
  const batch = await prepareMaterialSheetTransfer(input, "lost-response");
  loseReply = true;
  await expect(executeMaterialSheetTransfer(input.spreadsheetId, batch)).resolves.toMatchObject({ rowCount: 1 });
  expect(mutations).toBe(1);
});

it("retries the same batch after both the write response and receipt read fail without duplicating rows", async () => {
  const batch = await prepareMaterialSheetTransfer(input, "lost-all");
  loseReply = true; unreadableAfterWrite = true;
  await expect(executeMaterialSheetTransfer(input.spreadsheetId, batch)).rejects.toThrow("response lost");
  loseReply = false; unreadableAfterWrite = false;
  await executeMaterialSheetTransfer(input.spreadsheetId, batch);
  expect(mutations).toBe(1);
});

it("concurrent retries apply an immutable operation only once", async () => {
  const batch = await prepareMaterialSheetTransfer(input, "concurrent");
  await Promise.all([executeMaterialSheetTransfer(input.spreadsheetId, batch), executeMaterialSheetTransfer(input.spreadsheetId, batch)]);
  expect(mutations).toBe(1);
});

it("edits the owned block and clears removed mapped values without deleting rows or touching unrelated columns", async () => {
  const first = await prepareMaterialSheetTransfer({ ...input, items: [input.items[0], input.items[0]] }, "first");
  await executeMaterialSheetTransfer(input.spreadsheetId, first);
  const next = await prepareMaterialSheetTransfer({ ...input, previousOperationId: "first" }, "second");
  const write = next.requests[0].updateCells as { range: Range["range"]; rows: unknown[] };
  expect(write.range).toMatchObject({ startRowIndex: 2, endRowIndex: 4 });
  expect(write.rows[1]).toEqual({ values: [{ userEnteredValue: { stringValue: "" } }] });
  expect(next.requests.some(request => request.deleteDimension || request.insertDimension)).toBe(false);
  await executeMaterialSheetTransfer(input.spreadsheetId, next);
  await executeMaterialSheetTransfer(input.spreadsheetId, first);
  expect(mutations).toBe(2);
});

it("rejects duplicate headers and missing previous target metadata before writing", async () => {
  headers = ["품명", "품명", "갯수", "규격"];
  await expect(prepareMaterialSheetTransfer(input, "bad-headers")).rejects.toThrow("중복");
  headers = ["품명", "갯수", "규격"];
  await expect(prepareMaterialSheetTransfer({ ...input, previousOperationId: "lost-target" }, "bad-target")).rejects.toThrow("입력 위치");
  expect(mutations).toBe(0);
});
