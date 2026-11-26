import { cp, mkdir, mkdtemp, rename, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const root = fileURLToPath(new URL('../', import.meta.url));
const dist = path.join(root,'dist');
await mkdir(dist,{recursive:true});
const stage = await mkdtemp(path.join(dist,'site-build-'));
try {
    for (const name of ['assets','character','novel','index.html','local.html','private.html','deploy.html','offline.js','LICENSE'])
        await cp(path.join(root,name),path.join(stage,name),{recursive:true});
    const dest = path.join(dist,'site');
    await rm(dest,{recursive:true,force:true});
    await rename(stage,dest);
} finally {
    await rm(stage,{recursive:true,force:true});
}
