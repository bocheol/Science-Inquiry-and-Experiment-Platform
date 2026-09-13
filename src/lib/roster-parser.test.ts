import { expect, it } from "vitest";
import * as XLSX from "xlsx";
import { deflateRawSync } from "node:zlib";
import { parseRoster, ROSTER_MAX_BYTES, ROSTER_PARSE_ERROR } from "@/lib/roster-parser";

function workbook(rows: unknown[][], bookType: "xlsx" | "xls" = "xlsx"): ArrayBuffer {
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(rows), "학생 명단");
  return XLSX.write(book, { type: "array", bookType, compression: true });
}
const headers = ["반", "번호", "성명", "조 번호"];

it.each(["xlsx", "xls"] as const)("preserves Korean roster cells from %s", async bookType => {
  const rows = await parseRoster(workbook([headers, [9, 1, "합성 학생", "2조"], [1, 2, "검증 학생", ""]], bookType));
  expect(rows).toEqual([{ 반: 9, 번호: 1, 성명: "합성 학생", "조 번호": "2조" }, { 반: 1, 번호: 2, 성명: "검증 학생", "조 번호": "" }]);
});

it("accepts 1000 data rows but rejects 1001 and excess columns", async () => {
  const rows = Array.from({ length: 1000 }, (_, i) => [9, i + 1, "합성", ""]);
  expect(await parseRoster(workbook([headers, ...rows]))).toHaveLength(1000);
  await expect(parseRoster(workbook([headers, ...rows, rows[0]]))).rejects.toThrow("1001행, 32열");
  await expect(parseRoster(workbook([Array.from({ length: 33 }, (_, i) => "열" + i)]))).rejects.toThrow("1001행, 32열");
});

it("rejects oversized, empty, disguised and broken workbooks without exposing contents", async () => {
  await expect(parseRoster(new ArrayBuffer(ROSTER_MAX_BYTES + 1))).rejects.toThrow("2MB");
  await expect(parseRoster(new ArrayBuffer(0))).rejects.toThrow("2MB");
  await expect(parseRoster(new TextEncoder().encode("<table>synthetic-secret C:/private/path</table>").buffer)).rejects.toThrow(ROSTER_PARSE_ERROR);
  const good = new Uint8Array(workbook([headers, [1, 1, "합성", ""]]));
  await expect(parseRoster(good.slice(0, good.length - 20).buffer)).rejects.toThrow(ROSTER_PARSE_ERROR);
});

// Minimal ZIP with intentionally false expansion metadata. No external files.
function expansionZip(advertised: number): ArrayBuffer {
  const compressed = deflateRawSync(Buffer.alloc(17 * 1024 * 1024, 65));
  const name = Buffer.from("test.xml");
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(8, 8);
  local.writeUInt32LE(compressed.length, 18); local.writeUInt32LE(advertised, 22); local.writeUInt16LE(name.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 6); central.writeUInt16LE(8, 10);
  central.writeUInt32LE(compressed.length, 20); central.writeUInt32LE(advertised, 24); central.writeUInt16LE(name.length, 28);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + name.length, 12); end.writeUInt32LE(local.length + name.length + compressed.length, 16);
  return Uint8Array.from(Buffer.concat([local, name, compressed, central, name, end])).buffer;
}

it.each([17 * 1024 * 1024, 1])("rejects ZIP expansion beyond budget even with advertised size %s", async advertised => {
  const bytes = expansionZip(advertised);
  expect(bytes.byteLength).toBeLessThan(ROSTER_MAX_BYTES);
  await expect(parseRoster(bytes)).rejects.toThrow(ROSTER_PARSE_ERROR);
});
