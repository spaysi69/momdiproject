const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
function sourceHash(root=process.cwd()){
 const files=[];
 function visit(dir){for(const e of fs.readdirSync(dir,{withFileTypes:true})){const file=path.join(dir,e.name);if(e.isDirectory())visit(file);else files.push(file)}}
 visit(path.join(root,'src'));
 for(const name of ['package.json','package-lock.json','tsconfig.json','config.json','scripts-copy-public.cjs','scripts-build-info.cjs','scripts-start.cjs','scripts-clean.cjs'])if(fs.existsSync(path.join(root,name)))files.push(path.join(root,name));
 const hash=crypto.createHash('sha256');for(const file of files.sort()){hash.update(path.relative(root,file));hash.update(fs.readFileSync(file))}return hash.digest('hex');
}
module.exports={sourceHash};
if(require.main===module){const version=JSON.parse(fs.readFileSync('package.json','utf8')).version;const fingerprint=sourceHash();const info={version,buildId:fingerprint.slice(0,12),sourceHash:fingerprint};fs.writeFileSync('dist/BUILD_INFO.json',JSON.stringify(info,null,2));console.log(`Verified build ${version} / ${info.buildId}`)}
