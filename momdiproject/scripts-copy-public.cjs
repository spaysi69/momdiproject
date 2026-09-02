const fs = require('node:fs');
const path = require('node:path');
const source = path.join(process.cwd(), 'src', 'server', 'public');
const destination = path.join(process.cwd(), 'dist', 'src', 'server', 'public');
fs.cpSync(source, destination, { recursive: true });
