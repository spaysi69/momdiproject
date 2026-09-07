const fs=require('node:fs');const path=require('node:path');fs.mkdirSync('dist',{recursive:true});fs.cpSync(path.join(process.cwd(),'src'),path.join(process.cwd(),'dist','src'),{recursive:true});
