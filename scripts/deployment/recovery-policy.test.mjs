import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { migrationManifest } from './migration-manifest.mjs';
import { validateMigrationRows, readCompatibility, recoveryHandler, observePoolErrors } from './recovery-policy.mjs';
const expected=await migrationManifest(new URL('../..',import.meta.url).pathname);
test('loads the actual 0015 module and accepts reviewed prefixes 0012 through 0015',()=>{
  assert.equal(expected.length,15);
  for(const count of [12,13,14,15]) assert.equal(validateMigrationRows(expected.slice(0,count),expected).length,count);
});
test('rejects future, missing, duplicate and modified migrations',()=>{
  for(const rows of [[],expected.slice(0,11),[...expected,{version:'0016'}],[...expected.slice(0,14),{...expected[14],checksum:'tampered'}],[...expected.slice(0,13),expected[14]], [...expected.slice(0,14),expected[13]]]){
    assert.throws(()=>validateMigrationRows(rows,expected));
  }
});
test('recovery uses a read-only transaction with no application queries or DDL',async()=>{
  const calls=[];
  const pool={connect:async()=>({query:async sql=>{calls.push(sql);return {rows:expected};},release:()=>calls.push('release')})};
  assert.equal((await readCompatibility(pool,expected)).length,15);
  assert.deepEqual(calls,['BEGIN READ ONLY','SELECT version, name, checksum FROM schema_migrations ORDER BY version','COMMIT','release']);
});
test('maintenance never exposes journal, records, photos or teacher history',async()=>{
  let queries=0;
  const handler=recoveryHandler({connect:async()=>{queries++;throw new Error('must not connect');}},expected);
  for(const url of ['/login','/api/records','/api/records?history=1','/api/records/journal-images/synthetic','/api/inquiry/journals','/api/teacher/journals','/teacher/team/synthetic']){
    let status,body;
    await handler({method:'GET',url},{setHeader(){},writeHead(code){status=code;},end(value){body=value;}});
    assert.equal(status,503);assert.equal(JSON.parse(body).mode,'maintenance');
  }
  assert.equal(queries,0);
});
test('health fails closed without exposing DB errors or credentials',async()=>{
  let status,body;
  await recoveryHandler({connect:async()=>{throw new Error('synthetic-secret-connection-string');}},expected)({method:'GET',url:'/api/health'},{setHeader(){},writeHead(code){status=code;},end(value){body=value;}});
  assert.equal(status,503);assert.doesNotMatch(body,/secret/);
});

test('handles background pool errors without crashing or logging driver secrets',async()=>{
  const pool=new EventEmitter(), logs=[];
  observePoolErrors(pool,message=>logs.push(message));
  assert.doesNotThrow(()=>pool.emit('error',new Error('synthetic-secret-connection-string')));
  assert.equal(logs.length,1);assert.doesNotMatch(logs[0],/synthetic-secret/);
  pool.connect=async()=>{throw new Error('synthetic-secret-connection-string');};
  let status,body;
  await recoveryHandler(pool,expected)({method:'GET',url:'/api/health'},{setHeader(){},writeHead(code){status=code;},end(value){body=value;}});
  assert.equal(status,503);assert.doesNotMatch(body,/synthetic-secret/);
});
