import { describe, expect, it } from "vitest";
import * as CFB from "cfb";
import { deflateRawSync } from "node:zlib";
import { zipSync, strToU8 } from "fflate";
import PDFDocument from "pdfkit";
import { detectRecordFile, extractRecordText, RECORD_FILE_MAX_BYTES } from "./extraction";

function syntheticHwp(paragraphs: string[], flags = 1) {
  const container = CFB.utils.cfb_new();
  const header = Buffer.alloc(256); header.write("HWP Document File"); header[35] = 5; header.writeUInt32LE(flags, 36);
  CFB.utils.cfb_add(container, "FileHeader", header);
  const records = paragraphs.map(text => { const body = Buffer.from(text + "\r", "utf16le"); const h = Buffer.alloc(4); h.writeUInt32LE((body.length << 20) | 67); return Buffer.concat([h, body]); });
  CFB.utils.cfb_add(container, "BodyText/Section0", flags & 1 ? deflateRawSync(Buffer.concat(records)) : Buffer.concat(records));
  CFB.utils.cfb_add(container, "Scripts/JScriptVersion", Buffer.from("must never execute"));
  return Buffer.from(CFB.write(container, { type: "buffer" }));
}
describe("bounded native document extraction", () => {
  it("reads all HWP paragraph records including table-cell paragraphs and ignores scripts", async () => {
    const data = syntheticHwp(["개별 탐구 계획", "표 첫 셀", "\u000b" + "x".repeat(7) + "표 안의 긴 답변", "마지막 표 셀의 예상 결과"]);
    expect(detectRecordFile("plan.hwp", data)).toBe("application/x-hwp");
    const result = await extractRecordText(data, "application/x-hwp");
    expect(result.status).toBe("review"); expect(result.text).toContain("표 안의 긴 답변"); expect(result.text).toContain("마지막 표 셀의 예상 결과"); expect(result.text).not.toContain("must never execute");
  });
  it("keeps protected HWP out of text extraction", async () => {
    expect((await extractRecordText(syntheticHwp(["secret"], 3), "application/x-hwp")).status).toBe("error");
  });
  it("reads DOCX tables without following relationships or entities", async () => {
    const data = Buffer.from(zipSync({ "word/document.xml": strToU8('<w:document xmlns:w="urn:synthetic"><w:body><w:tbl><w:tr><w:tc><w:p><w:r><w:t>표 안의 한글 &amp; 답변</w:t></w:r></w:p></w:tc></w:tr></w:tbl></w:body></w:document>') }));
    const mime = detectRecordFile("plan.docx", data);
    const result = await extractRecordText(data, mime);
    expect(result.status).toBe("review"); expect(result.text).toContain("표 안의 한글 & 답변");
    const malicious = Buffer.from(zipSync({ "word/document.xml": strToU8('<!DOCTYPE data [<!ENTITY secret SYSTEM "file:///etc/passwd">]><w:document>&secret;</w:document>') }));
    expect((await extractRecordText(malicious, mime)).status).toBe("error");
  });
  it("reads a real generated PDF and distinguishes an image that needs OCR", async () => {
    const pdf = await new Promise<Buffer>(resolve => { const document = new PDFDocument(); const parts: Buffer[] = []; document.on("data", part => parts.push(part)); document.on("end", () => resolve(Buffer.concat(parts))); document.text("Synthetic inquiry evidence: observed three samples."); document.end(); });
    const result = await extractRecordText(pdf, "application/pdf");
    expect(result.status).toBe("review"); expect(result.text).toContain("observed three samples");
    expect((await extractRecordText(Buffer.from([0xff, 0xd8, 0xff]), "image/jpeg")).status).toBe("needs_ocr");
  });
  it("rejects wrong signatures, unsupported formats and oversized inputs", () => {
    expect(() => detectRecordFile("fake.pdf", Buffer.from("<script>"))).toThrow();
    expect(() => detectRecordFile("file.exe", Buffer.from("%PDF-"))).toThrow();
    expect(() => detectRecordFile("big.pdf", Buffer.alloc(RECORD_FILE_MAX_BYTES + 1))).toThrow("10MB");
  });
});
