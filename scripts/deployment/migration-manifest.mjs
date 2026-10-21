// Node 24: resolve TypeScript aliases explicitly; plain import of migrations.ts
// otherwise fails on the separately imported 0015 student-records migration.
import { registerHooks } from 'node:module';
import { existsSync } from 'node:fs';
import { resolve, extname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

export async function migrationManifest(root) {
  root=resolve(root);
  const hooks=registerHooks({resolve(specifier,context,nextResolve){
    if(specifier.startsWith('@/')) specifier=pathToFileURL(resolve(root,'src',specifier.slice(2)+'.ts')).href;
    else if(specifier.startsWith('.') && !extname(specifier) && context.parentURL){
      const path=fileURLToPath(new URL(specifier,context.parentURL));
      if(existsSync(path+'.ts')) specifier=pathToFileURL(path+'.ts').href;
    }
    return nextResolve(specifier,context);
  }});
  try {
    const {DATABASE_MIGRATIONS}=await import(pathToFileURL(resolve(root,'src/lib/db/migrations.ts')).href);
    return DATABASE_MIGRATIONS.map(({version,name,sql})=>({version,name,checksum:createHash('sha256').update(`${version}\n${name}\n${sql}`).digest('hex')}));
  } finally { hooks.deregister(); }
}
if(process.argv[1] && import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  console.log(JSON.stringify(await migrationManifest(process.argv[2])));
}
