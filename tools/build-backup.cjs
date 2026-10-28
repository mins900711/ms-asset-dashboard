const fs=require('node:fs'),path=require('node:path');
const root=path.join(__dirname,'..');
const file=path.join(root,'index.html'),html=fs.readFileSync(file,'utf8');
const start='// BEGIN ASSET BACKUP\n',end='// END ASSET BACKUP';
const from=html.indexOf(start),to=html.indexOf(end,from);
if(from<0||to<0)throw Error('Missing backup source markers');
const script=fs.readFileSync(path.join(root,'src/asset-backup.js'),'utf8');
fs.writeFileSync(file,html.slice(0,from)+start+script+'\n'+html.slice(to));
