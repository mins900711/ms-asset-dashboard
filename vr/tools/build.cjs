const fs=require('node:fs');const path=require('node:path');
const root=path.resolve(__dirname,'..');
const css=fs.readFileSync(path.join(root,'src/styles.css'),'utf8');
const engine=fs.readFileSync(path.join(root,'src/engine.js'),'utf8');
const prices=fs.readFileSync(path.join(root,'src/prices.js'),'utf8');
const app=fs.readFileSync(path.join(root,'src/app.js'),'utf8');
const verification=JSON.parse(fs.readFileSync(path.join(root,'tests/verification.json'),'utf8'));
function html(seed){return `<!doctype html>\n<html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="theme-color" content="#132a31"><meta name="description" content="민수와 보배의 적립식 VR 계좌 현황과 격주 거래 기록을 관리합니다."><meta name="color-scheme" content="light"><title>적립식 VR 관리</title><style>${css}</style></head><body><div id="app"></div><input id="import-file" class="file-input" type="file" accept="application/json,.json" aria-label="VR 백업 가져오기"><dialog id="confirm-dialog"></dialog><noscript>이 앱을 사용하려면 JavaScript를 켜 주세요.</noscript><script>${seed?'window.VR_INITIAL='+JSON.stringify(seed).replace(/</g,'\\u003c')+';':''}window.VR_VERIFICATION=${JSON.stringify(verification)};\n${engine}\n${prices}\n${app}\n</script></body></html>`;}
fs.mkdirSync(path.join(root,'dist'),{recursive:true});fs.writeFileSync(path.join(root,'dist/index.html'),html(null));
fs.writeFileSync(path.join(root,'index.html'),html(null));
if(process.argv.includes('--private')){const seed=JSON.parse(fs.readFileSync(path.join(root,'tools/seed-private.json'),'utf8'));const out=path.resolve(root,'../outputs/VR_manager_personal.html');fs.writeFileSync(out,html(seed));console.log('Personal HTML:',out);}
console.log('Public HTML:',path.join(root,'dist/index.html'));
