const fs=require('node:fs');
const {sourceHash}=require('./scripts-build-info.cjs');
try{
 const build=JSON.parse(fs.readFileSync('dist/BUILD_INFO.json','utf8'));
 if(sourceHash()!==build.sourceHash)throw Error('Compiled files do not match the project source.');
 console.log(`Starting Beast ${build.version} / ${build.buildId}`);
 require('./dist/src/index.js');
}catch(error){console.error(`Beast cannot start: ${error.message} Run npm run build, then npm start.`);process.exitCode=1}
