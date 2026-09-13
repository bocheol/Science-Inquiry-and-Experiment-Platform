// Build product batches from actual connector-read metadata/cells.
// Transport/auth are tested separately; this script does not make network calls.
import {readFile,writeFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
import {GoogleAuth} from 'google-auth-library';
const source=JSON.parse(await readFile('output/test-infra/sheet-78-initial.json','utf8'));
GoogleAuth.prototype.getClient=async()=>({getRequestHeaders:async()=>new Headers()});
process.env.GOOGLE_CLOUD_PROJECT='synthetic-preparation';
globalThis.fetch=async input=>{
 const url=new URL(input);let result;
 if(url.searchParams.has('fields'))result=source.meta;
 else if(decodeURIComponent(url.pathname).includes('조별시험'))result=source.sections;
 else if(decodeURIComponent(url.pathname).includes('헤더시험'))result=source.headers;
 else throw new Error('Unexpected fixture lookup');
 return new Response(JSON.stringify(result),{status:200});
};
const {prepareMaterialSheetTransfer}=await import('../src/lib/material-sheet-transfer.ts');
const items=Array.from({length:6},(_,i)=>({id:`synthetic-${i}`,name:`합성 준비물 ${i+1}`,specification:'시험 전용',unitPrice:1000+i*100,quantity:2,shipping:300,link:'https://example.com/synthetic'}));
const base={spreadsheetId:source.meta.spreadsheetId,sheetName:'조별시험',layout:'team_sections',teamNumber:1,teamName:'합성 시험 팀',leaderLoginId:'SYNTHETIC-78',leaderName:'합성 작성자',targetKey:'synthetic-cycle-78',submittedAt:'2026-09-09T00:00:00Z',items};
assert.equal(base.spreadsheetId,'1h7OY0b9x329xT_xHfHBp171IdqL6gLVcSDCgb4pwPiQ');
const sections=await prepareMaterialSheetTransfer(base,'connector-78-sections');
const headers=await prepareMaterialSheetTransfer({...base,sheetName:'헤더시험',layout:'header_row',items:items.slice(0,2)},'connector-78-headers');
await writeFile('output/test-infra/sheet-78-batches.json',JSON.stringify({sections,headers},null,2));
console.log('Product batches prepared from actual test workbook metadata and cells.');
