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

const PDFDocument = require("pdfkit");
const pdf = await new Promise(resolve => {
  const doc = new PDFDocument(); const parts = [];
  doc.on("data", part => parts.push(part)); doc.on("end", () => resolve(Buffer.concat(parts)));
  doc.text("Packaged standalone inquiry evidence"); doc.end();
});
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
console.log(JSON.stringify({ standaloneImage: "passed", network: "disabled", formats: ["PDF", "HWP", "DOCX", "JPEG"], studentData: "none" }));
