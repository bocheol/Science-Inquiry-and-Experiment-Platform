import {Worker} from "node:worker_threads";
import {createRequire} from "node:module";
import {join} from "node:path";
import * as XLSX from "xlsx";

export const ROSTER_MAX_BYTES=2*1024*1024;
export const ROSTER_MAX_ROWS=1000;
export const ROSTER_PARSE_TIMEOUT_MS=10_000;
export const ROSTER_PARSE_ERROR="명단 파일을 읽지 못했습니다. 정상적인 XLS/XLSX 파일인지 확인해 주세요.";
export class RosterInputError extends Error {}
export type RosterSourceRow={반?:string|number;번호?:string|number;성명?:string;"조 번호"?:string|number};

// Only this isolated worker parses uploaded bytes. It has no DB or credentials.
const workerSource=String.raw`
const {parentPort,workerData}=require('node:worker_threads');
const {inflateRawSync}=require('node:zlib');
try {
 const b=Buffer.from(workerData.buffer), maxExpanded=16*1024*1024;
 const fail=()=>{throw new Error('invalid workbook');};
 const u16=o=>{if(o<0||o+2>b.length)fail();return b.readUInt16LE(o);};
 const u32=o=>{if(o<0||o+4>b.length)fail();return b.readUInt32LE(o);};
 const extra=(start,length)=>{const end=start+length;if(end>b.length)fail();while(start<end){if(start+4>end)fail();const type=u16(start),size=u16(start+2);if(type===1||start+4+size>end)fail();start+=4+size;}};
 if(u32(0)===0x04034b50) {
  let e=-1;for(let i=b.length-22;i>=Math.max(0,b.length-65557);i--)if(u32(i)===0x06054b50&&i+22+u16(i+20)===b.length){e=i;break;}
  if(e<0||u16(e+4)||u16(e+6))fail();
  const count=u16(e+10),cdSize=u32(e+12),cd=u32(e+16);
  if(!count||count>256||count!==u16(e+8)||cd+cdSize!==e)fail();
  let p=cd,total=0;
  for(let i=0;i<count;i++) {
   if(u32(p)!==0x02014b50)fail();
   const flags=u16(p+8),method=u16(p+10),compressed=u32(p+20),expanded=u32(p+24),name=u16(p+28),extras=u16(p+30),comment=u16(p+32),local=u32(p+42);
   if(flags&0x2041||![0,8].includes(method)||expanded>maxExpanded-total||compressed>b.length||u32(local)!==0x04034b50)fail();
   if(u16(local+6)!==flags||u16(local+8)!==method)fail();
   const localName=u16(local+26),localExtra=u16(local+28),start=local+30+localName+localExtra;
   if(start+compressed>cd||localName!==name||!b.subarray(local+30,local+30+localName).equals(b.subarray(p+46,p+46+name)))fail();
   extra(p+46+name,extras);extra(local+30+localName,localExtra);
   if(!(flags&8)&&(u32(local+18)!==compressed||u32(local+22)!==expanded))fail();
   if((flags&8)&&((u32(local+18)!==0&&u32(local+18)!==compressed)||(u32(local+22)!==0&&u32(local+22)!==expanded)))fail();
   const bytes=method===0?b.subarray(start,start+compressed):inflateRawSync(b.subarray(start,start+compressed),{maxOutputLength:Math.max(1,maxExpanded-total)});
   if(bytes.length!==expanded)fail();total+=bytes.length;p+=46+name+extras+comment;
   if(p>e)fail();
  }
  if(p!==e)fail();
 } else if(b.subarray(0,8).toString('hex')!=='d0cf11e0a1b11ae1') fail();
 const XLSX=require(workerData.modulePath);
 if(XLSX.version!==workerData.version)fail();
 const book=XLSX.read(b,{type:'buffer',sheets:0,sheetRows:workerData.maxRows+2,dense:true,bookVBA:false,bookDeps:false});
 const sheet=book.Sheets[book.SheetNames[0]];if(!sheet)fail();
 const range=XLSX.utils.decode_range(sheet['!fullref']||sheet['!ref']||'A1');
 if(range.e.r>workerData.maxRows||range.e.c>=32){parentPort.postMessage({error:'limit'});}
 else {const rows=XLSX.utils.sheet_to_json(sheet,{defval:''});if(rows.length>workerData.maxRows)parentPort.postMessage({error:'limit'});else parentPort.postMessage({rows});}
} catch {parentPort.postMessage({error:'invalid'});}
`;

export async function parseRoster(buffer:ArrayBuffer):Promise<RosterSourceRow[]> {
  if(buffer.byteLength===0||buffer.byteLength>ROSTER_MAX_BYTES) throw new RosterInputError("명단 파일은 2MB 이하로 올려 주세요.");
  const modulePath=createRequire(join(process.cwd(),"package.json")).resolve("xlsx");
  return new Promise((resolve,reject)=>{
    const worker=new Worker(workerSource,{eval:true,workerData:{buffer,modulePath,version:XLSX.version,maxRows:ROSTER_MAX_ROWS},env:{},resourceLimits:{maxOldGenerationSizeMb:128,maxYoungGenerationSizeMb:16}});
    let settled=false;
    const finish=(error?:string,rows?:RosterSourceRow[])=>{if(settled)return;settled=true;clearTimeout(timer);void worker.terminate();if(error)reject(new RosterInputError(error));else resolve(rows!);};
    const timer=setTimeout(()=>finish("명단 파일 처리 시간이 초과되었습니다. 파일을 나누거나 다시 저장해 주세요."),ROSTER_PARSE_TIMEOUT_MS);
    worker.once("message",(message:{rows?:RosterSourceRow[];error?:string})=>finish(message.error==="limit"?"명단은 머리글을 포함해 1001행, 32열 이내로 올려 주세요.":message.error||!Array.isArray(message.rows)?ROSTER_PARSE_ERROR:undefined,message.rows));
    worker.once("error",()=>finish(ROSTER_PARSE_ERROR));
    worker.once("exit",()=>{if(!settled)finish(ROSTER_PARSE_ERROR);});
  });
}
