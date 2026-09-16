import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { SourceSnapshot } from './source-snapshot.js';
const hash=(s:string)=>createHash('sha256').update(s).digest('hex');
test('only verified shipped source can be searched/read; changed artifacts and traversal are rejected',()=>{
  const dir=mkdtempSync(join(tmpdir(),'self-source-'));
  try {
    const code='export function memoryCapture() {\n  return true;\n}';
    writeFileSync(join(dir,'index.js'),'compiled');
    writeFileSync(join(dir,'self-source.json'),JSON.stringify({format:1,version:'1.2.3',buildId:'test',commit:null,dirty:true,builtAt:'now',artifacts:[{path:'index.js',sha256:hash('compiled')}],files:[{path:'server/memory.ts',content:code,sha256:hash(code)}]}));
    const source=new SourceSnapshot(join(dir,'self-source.json'));
    assert.equal(source.status,'verified');assert.equal(source.search('memoryCapture').matches[0].path,'server/memory.ts');
    assert.match(String((source.read('server/memory.ts',2,1) as {content:string}).content),/^2: /);
    assert.ok('error' in source.read('../../secrets'));
    writeFileSync(join(dir,'index.js'),'different release');
    const changed=new SourceSnapshot(join(dir,'self-source.json'));assert.equal(changed.status,'mismatch');assert.equal(changed.search('memory').matches.length,0);
    assert.equal(new SourceSnapshot(join(dir,'missing')).status,'unavailable');
  }finally{rmSync(dir,{recursive:true,force:true});}
});
