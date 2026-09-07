import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import build from '../scripts-build-info.cjs';
test('build matches source and refuses a stale source/compiled combination',()=>{
 const current=JSON.parse(fs.readFileSync('dist/BUILD_INFO.json','utf8'));
 assert.equal(current.version,JSON.parse(fs.readFileSync('package.json')).version);
 assert.equal(build.sourceHash(),current.sourceHash);
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'beast-build-test-'));
 try{
  fs.cpSync('src',path.join(dir,'src'),{recursive:true});
  for(const name of ['package.json','package-lock.json','tsconfig.json','config.json','scripts-copy-public.cjs','scripts-build-info.cjs','scripts-start.cjs','scripts-clean.cjs'])fs.copyFileSync(name,path.join(dir,name));
  fs.mkdirSync(path.join(dir,'dist'));fs.copyFileSync('dist/BUILD_INFO.json',path.join(dir,'dist/BUILD_INFO.json'));
  fs.appendFileSync(path.join(dir,'src/index.ts'),'\n// different source\n');
  const result=spawnSync(process.execPath,['scripts-start.cjs'],{cwd:dir,encoding:'utf8'});
  assert.equal(result.status,1);assert.match(result.stderr,/Compiled files do not match/);
 }finally{fs.rmSync(dir,{recursive:true,force:true})}
});
