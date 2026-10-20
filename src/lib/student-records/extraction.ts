import { Worker } from "node:worker_threads";
import { createRequire } from "node:module";
import { join } from "node:path";
import { DOMMatrix } from "@napi-rs/canvas";
import { RecordError } from "./access";

export const RECORD_FILE_MAX_BYTES = 10 * 1024 * 1024;
export const RECORD_TEXT_MAX_CHARS = 100_000;
export type Extraction = { status: "review" | "needs_ocr" | "error"; text: string; note: string };
export function detectRecordFile(name: string, data: Buffer) {
  if (!data.length || data.length > RECORD_FILE_MAX_BYTES) throw new RecordError("파일 한 개는 10MB 이하여야 합니다.", 413);
  const ext = name.toLowerCase().split(".").at(-1);
  if (ext === "pdf" && data.subarray(0, 5).toString() === "%PDF-") return "application/pdf";
  if (["jpg", "jpeg"].includes(ext ?? "") && data.subarray(0, 3).toString("hex") === "ffd8ff") return "image/jpeg";
  if (ext === "png" && data.subarray(0, 8).toString("hex") === "89504e470d0a1a0a") return "image/png";
  if (ext === "hwp" && data.subarray(0, 8).toString("hex") === "d0cf11e0a1b11ae1") return "application/x-hwp";
  if ((ext === "docx" || ext === "hwpx") && data.subarray(0, 4).toString("hex") === "504b0304") return ext === "hwpx" ? "application/hwp+zip" : "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  throw new RecordError("파일 내용과 확장자가 일치하는 HWP·HWPX·PDF·DOCX·JPG·PNG 파일을 올려 주세요.");
}

// Parse in a disposable worker, without inherited credentials, network URLs,
// macros, embedded scripts, attachments or external XML entities.
const source = String.raw`
const { parentPort, workerData } = require('node:worker_threads');
const { inflateRawSync } = require('node:zlib');
const b = Buffer.from(workerData.data), limit = 8 * 1024 * 1024;
const fail = () => { throw new Error('unsupported'); };
(async () => {
  let text = '';
  if (workerData.mime === 'application/x-hwp') {
    const CFB = require(workerData.modules.cfb), cfb = CFB.read(b, { type: 'buffer' });
    const header = Buffer.from(CFB.find(cfb, 'FileHeader')?.content || []);
    if (header.length < 40 || header.subarray(0, 17).toString() !== 'HWP Document File' || header[35] !== 5) fail();
    const flags = header.readUInt32LE(36);
    if (flags & (2 | 4 | 256)) fail();
    const sections = cfb.FullPaths.map((path, i) => ({ path, entry: cfb.FileIndex[i] })).filter(x => /\/BodyText\/Section\d+$/.test(x.path)).sort((a,b) => a.path.localeCompare(b.path, 'en', {numeric:true}));
    if (!sections.length || sections.length > 100) fail();
    let expanded = 0;
    for (const { entry } of sections) {
      const raw = Buffer.from(entry.content), section = flags & 1 ? inflateRawSync(raw, {maxOutputLength: limit - expanded}) : raw;
      expanded += section.length; if (expanded > limit) fail();
      let p = 0;
      while (p < section.length) {
        if (p + 4 > section.length) fail();
        const header = section.readUInt32LE(p); p += 4;
        const tag = header & 1023; let size = header >>> 20;
        if (size === 4095) { if (p + 4 > section.length) fail(); size = section.readUInt32LE(p); p += 4; }
        if (size > section.length - p) fail();
        if (tag === 67) {
          const part = section.subarray(p, p + size); let line = '';
          for (let i = 0; i + 1 < part.length;) {
            const code = part.readUInt16LE(i);
            if (code >= 32) { line += String.fromCharCode(code); i += 2; }
            else if ([1,2,3,4,5,6,7,8,9,11,12,14,15,16,17,18,19,20,21,22,23].includes(code)) { if (code === 9) line += '\t'; i += 16; }
            else { if (code === 10 || code === 13) line += '\n'; i += 2; }
          }
          text += line + '\n';
        }
        p += size;
      }
    }
  } else if (workerData.mime === 'application/pdf') {
    const { PDFParse } = require(workerData.modules.pdf);
    const parser = new PDFParse({ data: new Uint8Array(b), isEvalSupported: false, useSystemFonts: false, verbosity: 0 });
    try {
      if ((await parser.getInfo()).total > 30) throw new Error('pages');
      const result = await parser.getText();
      text = result.pages.map(p => p.text).join('\n\n');
    } finally { await parser.destroy(); }
  } else {
    const { unzipSync, strFromU8 } = require(workerData.modules.zip);
    const { XMLParser, XMLValidator } = require(workerData.modules.xml);
    let expanded = 0, entries = 0;
    const files = unzipSync(b, {filter: entry => {
      entries++; expanded += entry.originalSize;
      if (entries > 1000 || !Number.isFinite(expanded) || expanded > limit) fail();
      return entry.name === 'word/document.xml' || /^Contents\/section\d+\.xml$/.test(entry.name);
    }});
    const names = Object.keys(files).sort((a,b) => a.localeCompare(b, 'en', {numeric:true}));
    if (!names.length || (workerData.mime.includes('wordprocessingml') && !names.includes('word/document.xml'))) fail();
    for (const name of names) {
      const xml = strFromU8(files[name]);
      if (/<!DOCTYPE|<!ENTITY/i.test(xml) || XMLValidator.validate(xml) !== true) fail();
      const parsed = new XMLParser({preserveOrder:true, ignoreAttributes:true, trimValues:false, parseTagValue:false, processEntities:true}).parse(xml);
      const walk = nodes => { for (const node of nodes) for (const [key,value] of Object.entries(node)) {
        if (key === '#text') text += value;
        else if (Array.isArray(value)) { walk(value); if (/(^|:)p$/.test(key)) text += '\n'; if (/(^|:)tc$/.test(key)) text += '\t'; }
      }};
      walk(parsed); text += '\n';
    }
  }
  if (text.length > workerData.maxText) throw new Error('text-limit');
  parentPort.postMessage({text: text.replace(/\r\n?/g, '\n').replace(/\n{4,}/g, '\n\n').trim()});
})().catch(() => parentPort.postMessage({error:true}));
`;

export async function extractRecordText(data: Buffer, mime: string): Promise<Extraction> {
  if (mime.startsWith("image/")) return { status: "needs_ocr", text: "", note: "사진입니다. 교사가 문자 인식을 실행하거나 확인한 내용을 직접 입력할 수 있습니다." };
  const require = createRequire(join(process.cwd(), "package.json"));
  // Keep the native PDF geometry dependency in Next's standalone trace. The
  // document itself is still parsed exclusively inside the bounded worker.
  if (mime === "application/pdf" && typeof DOMMatrix !== "function") return { status: "error", text: "", note: "PDF 읽기 구성 요소를 확인해 주세요. 원본은 보관되어 있습니다." };
  const modules = { cfb: require.resolve("cfb"), zip: require.resolve("fflate"), xml: require.resolve("fast-xml-parser"), pdf: require.resolve("pdf-parse") };
  return new Promise(resolve => {
    const worker = new Worker(source, { eval: true, env: {}, execArgv: [], resourceLimits: { maxOldGenerationSizeMb: 192, maxYoungGenerationSizeMb: 24 }, workerData: { data, mime, modules, maxText: RECORD_TEXT_MAX_CHARS } });
    let settled = false;
    const finish = (result: Extraction) => { if (settled) return; settled = true; clearTimeout(timer); void worker.terminate(); resolve(result); };
    const failure: Extraction = { status: "error", text: "", note: "본문을 읽지 못했습니다. 암호·배포용 문서, 손상 파일, 30쪽/10만 자 초과 여부를 확인하거나 PDF로 다시 저장해 주세요. 원본은 보관되어 있습니다." };
    const timer = setTimeout(() => finish({ ...failure, note: "파일 읽기 제한 시간(20초)을 넘었습니다. 파일을 나누거나 PDF로 다시 저장해 주세요. 원본은 보관되어 있습니다." }), 20_000);
    worker.once("message", (result: { text?: string; error?: boolean }) => {
      if (result.error || typeof result.text !== "string") return finish(failure);
      if (!result.text.trim()) return finish({ status: "needs_ocr", text: "", note: "추출된 문자가 없습니다. 스캔 문서라면 교사가 문자 인식을 실행해 주세요." });
      finish({ status: "review", text: result.text, note: "표·수식·읽기 순서를 원본과 비교한 뒤 추출 확인을 눌러 주세요." });
    });
    worker.once("error", () => finish(failure));
    worker.once("exit", () => { if (!settled) finish(failure); });
  });
}
