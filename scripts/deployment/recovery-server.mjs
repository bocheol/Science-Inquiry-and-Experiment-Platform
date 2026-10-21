import http from 'node:http';
import { readFileSync } from 'node:fs';
import { Pool } from 'pg';
import { recoveryHandler, observePoolErrors } from './recovery-policy.mjs';
const manifest=JSON.parse(readFileSync(new URL('./migrations.json',import.meta.url),'utf8'));
const config=process.env.INSTANCE_UNIX_SOCKET
  ? {host:process.env.INSTANCE_UNIX_SOCKET,user:process.env.DB_USER,password:process.env.DB_PASSWORD,database:process.env.DB_NAME}
  : {connectionString:process.env.DATABASE_URL};
if(process.env.INSTANCE_UNIX_SOCKET ? !config.user || !config.password || !config.database : !config.connectionString){
  throw new Error('A configured persistent database is required for recovery.');
}
const pool=new Pool({...config,max:2,connectionTimeoutMillis:5000,statement_timeout:5000,options:'-c default_transaction_read_only=on'});
observePoolErrors(pool);
const server=http.createServer(recoveryHandler(pool,manifest));
server.listen(Number(process.env.PORT||8080),'0.0.0.0');
process.on('SIGTERM',()=>{server.close(()=>{void pool.end().then(()=>process.exit(0),()=>process.exit(1));});});
