// The recovery image is intentionally read-only maintenance, not the old app
// with its revoked-access bypasses. It never initializes, seeds or migrates DBs.
export function validateMigrationRows(applied, expected) {
  if(expected.length!==15 || expected.some((row,i)=>row.version!==String(i+1).padStart(4,'0'))) throw new Error('Invalid reviewed migration manifest');
  if(applied.length<12 || applied.length>expected.length) throw new Error('Unrecognized database baseline');
  for(const [i,row] of applied.entries()){
    const known=expected[i];
    if(row.version!==known.version || row.name!==known.name || row.checksum!==known.checksum) throw new Error('Database compatibility mismatch');
  }
  return applied.map(row=>row.version);
}

export async function readCompatibility(pool, expected) {
  const client=await pool.connect();
  try {
    await client.query('BEGIN READ ONLY');
    const {rows}=await client.query('SELECT version, name, checksum FROM schema_migrations ORDER BY version');
    const versions=validateMigrationRows(rows,expected);
    await client.query('COMMIT');
    return versions;
  } catch(error) {
    await client.query('ROLLBACK').catch(()=>undefined);
    throw error;
  } finally { client.release(); }
}

export function recoveryHandler(pool, expected) {
  return async (request,response)=>{
    response.setHeader('Cache-Control','private, no-store');
    response.setHeader('Content-Type','application/json; charset=utf-8');
    response.setHeader('X-Content-Type-Options','nosniff');
    if(request.method==='GET' && request.url==='/api/health'){
      try {
        const versions=await readCompatibility(pool,expected);
        response.writeHead(200); response.end(JSON.stringify({ok:true,mode:'maintenance',readOnly:true,migrations:versions}));
      } catch {
        response.writeHead(503); response.end(JSON.stringify({ok:false,mode:'maintenance'}));
      }
      return;
    }
    response.setHeader('Retry-After','60');
    response.writeHead(503); response.end(JSON.stringify({message:'점검 중입니다. 잠시 후 다시 접속해 주세요.',mode:'maintenance'}));
  };
}

// pg emits idle-client failures outside connect/query promises. Handle the event
// without logging driver errors (which may contain addresses or credentials).
export function observePoolErrors(pool, log = console.error) {
  pool.on('error', () => log('Recovery database connection interrupted; health will recheck compatibility.'));
}
