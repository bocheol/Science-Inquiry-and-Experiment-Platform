// Run in the built Alpine image with network disabled. Resolve dependencies
// exclusively from /app, not the host source checkout or development modules.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { deflateRawSync } from "node:zlib";

const require = createRequire(join(process.cwd(), "package.json"));
const code = await readFile(process.argv[2], "utf8");
const source = code.match(/const source = String\.raw`([\s\S]*?)`;/)?.[1];
assert.ok(source, "The production extraction worker must be present.");
const modules = { cfb: require.resolve("cfb"), zip: require.resolve("fflate"), xml: require.resolve("fast-xml-parser"), pdf: require.resolve("pdf-parse") };
assert.equal(typeof require("@napi-rs/canvas").DOMMatrix, "function");

async function extract(data, mime) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(source, { eval: true, env: {}, execArgv: [], resourceLimits: { maxOldGenerationSizeMb: 192, maxYoungGenerationSizeMb: 24 }, workerData: { data, mime, modules, maxText: 100_000 } });
    const timeout = setTimeout(() => { void worker.terminate(); reject(new Error("Packaged worker timed out.")); }, 20_000);
    worker.once("message", result => { clearTimeout(timeout); void worker.terminate(); result.error ? reject(new Error("Packaged document extraction failed.")) : resolve(result.text); });
    worker.once("error", error => { clearTimeout(timeout); reject(error); });
  });
}

// PDFKit is bundled into Next's server chunks, not an external runner module.
// A tiny valid PDF fixture keeps this check focused on the deployed parser.
const stream = "BT /F1 12 Tf 72 700 Td (Packaged standalone inquiry evidence) Tj ET";
const objects = [
  "<< /Type /Catalog /Pages 2 0 R >>",
  "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
  "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
  "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
];
let document = "%PDF-1.4\n";
const offsets = [];
for (const [index, object] of objects.entries()) {
  offsets.push(Buffer.byteLength(document));
  document += `${index + 1} 0 obj\n${object}\nendobj\n`;
}
const xref = Buffer.byteLength(document);
document += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
document += offsets.map(offset => String(offset).padStart(10, "0") + " 00000 n \n").join("");
document += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
const pdf = Buffer.from(document);
assert.match(await extract(pdf, "application/pdf"), /Packaged standalone inquiry evidence/);

const CFB = require("cfb");
const compound = CFB.utils.cfb_new();
const header = Buffer.alloc(256); header.write("HWP Document File"); header[35] = 5; header.writeUInt32LE(1, 36);
CFB.utils.cfb_add(compound, "FileHeader", header);
const body = Buffer.from("합성 HWP 표 내용\r", "utf16le"), record = Buffer.alloc(4); record.writeUInt32LE((body.length << 20) | 67);
CFB.utils.cfb_add(compound, "BodyText/Section0", deflateRawSync(Buffer.concat([record, body])));
assert.match(await extract(Buffer.from(CFB.write(compound, { type: "buffer" })), "application/x-hwp"), /합성 HWP 표 내용/);

const { zipSync, strToU8 } = require("fflate");
const docx = Buffer.from(zipSync({ "word/document.xml": strToU8('<w:document xmlns:w="urn:synthetic"><w:body><w:p><w:r><w:t>합성 DOCX 내용</w:t></w:r></w:p></w:body></w:document>') }));
assert.match(await extract(docx, "application/vnd.openxmlformats-officedocument.wordprocessingml.document"), /합성 DOCX 내용/);
const sharp = require("sharp");
const jpeg = await sharp({ create: { width: 20, height: 20, channels: 3, background: "#fff" } }).jpeg().toBuffer();
assert.equal((await sharp(jpeg).metadata()).format, "jpeg");
console.log(JSON.stringify({ standaloneImage: "passed", formats: ["PDF", "HWP", "DOCX", "JPEG"], studentData: "none" }));
