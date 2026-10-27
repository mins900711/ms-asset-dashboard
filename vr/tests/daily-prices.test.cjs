const path=require('node:path'),root=path.resolve(__dirname,'..');
const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict'),{stripTypeScriptTypes}=require('node:module');
let passed=0;function test(label,fn){fn();passed++;console.log('PASS',label);}
let source=fs.readFileSync(path.join(root,'supabase/functions/vr-daily-prices/index.ts'),'utf8').replaceAll('export function','function');
source=stripTypeScriptTypes(source,{mode:'strip'});const c=vm.createContext({Intl,Date,Map,Number,Promise,Response,AbortSignal,Deno:{env:{get:()=>''},serve(){}},fetch(){throw Error('network disabled in test')}});vm.runInContext(source,c);
const fixture=(dates,closes,symbol='TQQQ')=>({chart:{result:[{meta:{symbol,currency:'USD',exchangeTimezoneName:'America/New_York'},timestamp:dates.map(d=>Date.parse(d)/1000),indicators:{quote:[{close:closes}]},events:{splits:{}}}]}});
const parse=(raw,date)=>c.parseDaily(raw,'TQQQ',new Date(date));
test('intraday price is excluded before completed session',()=>{const r=parse(fixture(['2026-10-26T13:30:00Z','2026-10-27T13:30:00Z'],[68.43,70]),'2026-10-27T18:00:00Z');assert.equal(r.rows.length,1);assert.equal(r.rows[0].date,'2026-10-26');});
test('close enters after 16:30 New York in both DST and winter',()=>{assert.equal(parse(fixture(['2026-10-27T13:30:00Z'],[70]),'2026-10-27T20:35:00Z').rows[0].date,'2026-10-27');assert.equal(parse(fixture(['2026-12-01T14:30:00Z'],[70]),'2026-12-01T21:35:00Z').rows[0].date,'2026-12-01');});
test('weekend, null and nonpositive prices are excluded',()=>{const r=parse(fixture(['2026-10-23T13:30:00Z','2026-10-24T13:30:00Z','2026-10-26T13:30:00Z'],[66.29,66.29,null]),'2026-10-27T02:00:00Z');assert.equal(r.rows.length,1);assert.throws(()=>parse(fixture(['2026-10-26T13:30:00Z'],[0]),'2026-10-27T02:00:00Z'));});
test('wrong symbol, currency and stale response fail closed',()=>{assert.throws(()=>parse(fixture(['2026-10-26T13:30:00Z'],[68.43],'SPY'),'2026-10-27T02:00:00Z'));const f=fixture(['2026-10-26T13:30:00Z'],[68.43]);f.chart.result[0].meta.currency='KRW';assert.throws(()=>parse(f,'2026-10-27T02:00:00Z'));assert.throws(()=>parse(fixture(['2026-10-01T13:30:00Z'],[68.43]),'2026-10-27T02:00:00Z'));});
test('split events retain date and ratio',()=>{const f=fixture(['2026-10-26T13:30:00Z'],[68.43]);f.chart.result[0].events.splits={one:{date:Date.parse('2026-10-26T13:30:00Z')/1000,numerator:2,denominator:1}};const r=parse(f,'2026-10-27T02:00:00Z');assert.equal(r.splits[0].date,'2026-10-26');assert.equal(r.splits[0].numerator,2);});
// Exercise client safeguards independently of the collector and database.
const e={innerHTML:'',textContent:'',value:'',isConnected:false,addEventListener(){},close(){},remove(){}};
const u=vm.createContext({console,Intl,Date,Map,Number,Promise,URL,AbortSignal,structuredClone,setTimeout(){},clearTimeout(){},sessionStorage:{getItem(){return null},setItem(){}},localStorage:{getItem(){return null}},document:{querySelector(){return e},querySelectorAll(){return[]},addEventListener(){}},window:{addEventListener(){}}});
vm.runInContext(fs.readFileSync(path.join(root,'src/engine.js'),'utf8'),u);u.VR=u.VR||u.window.VR;vm.runInContext(fs.readFileSync(path.join(root,'src/prices.js'),'utf8'),u);vm.runInContext(fs.readFileSync(path.join(root,'src/app.js'),'utf8'),u);
test('automatic quote avoids active trades and manual confirmed quotes; split blocks confirmation',()=>vm.runInContext(`
state=makeDemo();state.demo=false;unlocked=true;persist=()=>{};state.quote={price:100,date:neededBasis(),source:'excel_snapshot',confirmed:false};
const q={basis:{basisDate:neededBasis(),actualDate:neededBasis(),price:68.43,hasSplit:false,hasConflict:false}};
applyAutomaticQuote(q);if(!state.quote.confirmed||state.quote.price!==68.43)throw Error('automatic quote not applied');
state.quote={price:77,date:neededBasis(),source:'manual',confirmed:true};applyAutomaticQuote(q);if(state.quote.price!==77)throw Error('manual price overwritten');
state.quote.source='excel_snapshot';state.drafts={test:{steps:[true,false,false,false]}};applyAutomaticQuote(q);if(state.quote.price!==77)throw Error('active trade price overwritten');
applyAutomaticQuote({basis:{...q.basis,hasSplit:true}});if(state.quote.confirmed)throw Error('split did not block');
`,u));
test('dashboard latest price does not change Monday order calculation',()=>vm.runInContext(`
state.drafts={};state.quote.price=50;prices={latest:{price:90}};
const a=VR.currentAccount(state,'minsu');if(accountPlan().stock!==a.holdings*50)throw Error('latest quote used for order');if(quotePrice()!==90)throw Error('dashboard did not use latest quote');
`,u));
console.log(passed,'daily price tests passed');
