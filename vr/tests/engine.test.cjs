const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');require('../src/engine.js');const V=globalThis.VR;
let passed=0;function test(name,fn){fn();passed++;console.log('PASS',name);}
const almost=(a,b,t=.015)=>assert.ok(Math.abs(a-b)<t,`${a} != ${b}`);
function fixture(){const s=V.blank(),date='2026-10-13';for(const id of ['minsu','bobae']){const b={id,account:id,cycleDate:date,asOf:'2026-10-26',v:10000,holdings:100,pool:2000,principal:11000,price:100,assets:12000,quantity:0,source:'test'};s.accounts[id]={id,baseline:b,history:[],weekly:[]};}s.baselineConfirmed=true;s.quote={price:100,date:'2026-10-26',confirmed:true};return s;}
test('currency display rounds floating point half-cents correctly',()=>{assert.equal(V.round(108722.64499999999,2),108722.65);assert.equal(V.round(404618.49499999994,2),404618.5);});
test('Excel rounding before multiplying V',()=>almost(V.nextV(10000,2000,500),10700));
test('fractional V is not rounded to cents',()=>almost(V.nextV(101039.0589,32072.045,500),104772.3088,.001));
test('lower boundary and one-share remainder hold like original Excel',()=>{assert.equal(V.plan({v:10000,holdings:80,pool:10000,price:100}).quantity,0);assert.equal(V.plan({v:10000,holdings:79,pool:10000,price:100}).quantity,0);assert.equal(V.plan({v:10000,holdings:78,pool:10000,price:100}).quantity,2);});
test('upper boundary is hold; above boundary sells below max',()=>{assert.equal(V.plan({v:10000,holdings:120,pool:1000,price:100}).quantity,0);assert.equal(V.plan({v:10000,holdings:121,pool:1000,price:100}).quantity,-2);});
test('buy limited by Pool; never uses unfunded contribution',()=>{const p=V.plan({v:10000,holdings:0,pool:200,price:100});assert.equal(p.quantity,1);assert.equal(p.limited,true);});
test('no negative or fractional holdings; zero pool permitted',()=>{assert.equal(V.plan({v:10000,holdings:1,pool:0,price:100}).quantity,0);assert.throws(()=>V.plan({v:10000,holdings:1.5,pool:0,price:100}));assert.throws(()=>V.nextV(0,1));});
test('cycle handles leap years and dates strictly',()=>{assert.equal(V.addDays('2024-02-20',14),'2024-03-05');assert.throws(()=>V.dateMs('2026-02-30'));});
test('Excel and app history use different date keys for the same trade',()=>{
 const expected={cycleStart:'2026-10-06',cycleEnd:'2026-10-19',tradeDate:'2026-10-20'};
 assert.deepEqual(V.historyDates({source:'excel',cycleDate:'2026-10-06',quantity:1}),expected);
 assert.deepEqual(V.historyDates({source:'web',cycleDate:'2026-10-20',quantity:1}),expected);
 assert.deepEqual(V.historyDates({source:'excel_checkpoint',cycleDate:'2026-10-20',asOf:'2026-10-25',quantity:1}),expected);
 assert.deepEqual(V.historyDates({source:'excel',cycleDate:'2026-10-06',quantity:null}),{...expected,tradeDate:null});
});
test('trade period can begin in the previous year',()=>{
 assert.deepEqual(V.tradePeriod('2027-01-05'),{cycleStart:'2026-12-22',cycleEnd:'2027-01-04',tradeDate:'2027-01-05'});
});
test('app trades supersede overlapping Excel rows per account, including archived app trades',()=>{
 const s=fixture();
 const imported={id:'excel',account:'minsu',cycleDate:'2026-10-20',source:'excel',quantity:0};
 const older={...imported,id:'older',cycleDate:'2026-10-06'};
 const app={id:'app',account:'minsu',cycleDate:'2026-11-03',source:'web',quantity:2};
 s.accounts.minsu.history=[older,imported];
 s.accounts.bobae.history=[{...imported,account:'bobae'}];
 s.records=[app];
 assert.deepEqual(V.accountTradeHistory(s,'minsu').map(r=>r.id),['older','app']);
 assert.deepEqual(V.accountTradeHistory(s,'bobae').map(r=>r.id),['excel']);
 s.accounts.minsu.history.push(s.records.pop());
 assert.deepEqual(V.accountTradeHistory(s,'minsu').map(r=>r.id),['older','app']);
 assert.equal(s.accounts.minsu.history.length,3);
});
test('old snapshot and wrong Monday cannot trade',()=>{const s=fixture();assert.equal(V.canTrade(s,'minsu','2026-10-27').ok,true);assert.equal(V.canTrade(s,'minsu','2026-10-28').ok,false);s.quote.date='2026-10-25';assert.equal(V.canTrade(s,'minsu','2026-10-27').ok,false);s.quote.date='2026-10-26';s.baselineConfirmed=false;assert.equal(V.canTrade(s,'minsu','2026-10-27').ok,false);});
test('two inputs complete a hold; RP is observed final balance',()=>{const s=fixture(),r=V.complete(s,'minsu',{steps:[true,true,true],quantity:0,rp:2512.34},'2026-10-27');assert.equal(r.holdings,100);assert.equal(r.pool,2512.34);assert.equal(r.principal,11500);assert.equal(r.cashReconciliation,12.34);assert.equal(r.rpMaturity,'2026-11-10');almost(r.v,10750);s.records.push(r);assert.equal(V.currentAccount(s,'minsu').pool,2512.34);assert.equal(V.currentAccount(s,'bobae').pool,2000);assert.equal(V.cycleFor(s,'minsu'),'2026-11-10');assert.equal(V.cycleFor(s,'bobae'),'2026-10-27');});
test('incomplete steps, blank values and subcent RP rejected',()=>{const s=fixture();assert.throws(()=>V.complete(s,'minsu',{steps:[true,false,true],quantity:0,rp:2000},'2026-10-27'));assert.throws(()=>V.complete(s,'minsu',{steps:[true,true,true],quantity:null,rp:2000},'2026-10-27'));assert.throws(()=>V.complete(s,'minsu',{steps:[true,true,true],quantity:0,rp:2000.001},'2026-10-27'));});
test('over-selling, wrong direction, duplicate imports rejected',()=>{const s=fixture();s.quote.price=200;assert.throws(()=>V.complete(s,'minsu',{steps:[true,true,true],quantity:-101,rp:2000},'2026-10-27'));assert.throws(()=>V.complete(s,'minsu',{steps:[true,true,true],quantity:1,rp:2000},'2026-10-27'));const r=V.complete(s,'minsu',{steps:[true,true,true],quantity:0,rp:2500},'2026-10-27');s.records=[r,r];assert.throws(()=>V.validateState(s));});
test('backup schema validation detects corruption',()=>{const s=fixture();V.validateState(s);s.accounts.minsu.baseline.pool=-1;assert.throws(()=>V.validateState(s));s.accounts.minsu.baseline.pool=0;s.settings.contribution=600;assert.throws(()=>V.validateState(s));});
test('order uses the closing period V, without advancing into the next row',()=>{const s=fixture();s.accounts.minsu.baseline.pool=10000;s.quote.price=70;const p=V.orderPlan(s,'minsu');assert.equal(p.v,10000);assert.equal(p.quantity,15);assert.equal(p.budget,7500);});
test('completed trade uses final RP including the funded deposit for the next V',()=>{const s=fixture();s.accounts.minsu.baseline.pool=10000;s.quote.price=70;const r=V.complete(s,'minsu',{steps:[true,true,true],quantity:15,rp:9500},'2026-10-27');assert.equal(r.orderV,10000);assert.equal(r.vBasisPool,9500);almost(r.v,11450);assert.equal(r.principal,11500);assert.equal(r.holdings,115);assert.equal(r.pool,9500);s.records.push(r);assert.equal(V.orderPlan(s,'minsu').v,11450);});
test('the current deposit does not inflate the 75 percent order allowance',()=>{const p=V.plan({v:10000,holdings:0,pool:1000,price:100,contribution:500});assert.equal(p.budget,750);assert.equal(p.quantity,7);assert.equal(p.reserve,750);});
const fixturePath=path.join(__dirname,'excel-fixtures.json');
if(fs.existsSync(fixturePath)){
 const rows=JSON.parse(fs.readFileSync(fixturePath,'utf8'));let targetChecks=0,bandChecks=0,valuationChecks=0,remainingChecks=0,poolChecks=0;
 for(const r of rows){if(r.prevV!==null){almost(V.nextV(r.prevV,r.prevPool,r.contribution),r.v);targetChecks++;}almost(r.v*.8,r.low);almost(r.v*1.2,r.high);bandChecks+=2;almost(r.holdings*r.price,r.stock);valuationChecks++;almost(V.excelRemaining({...r,first:r.prevV===null}),r.expectedAmount,.011);remainingChecks++;almost((r.prevPool??r.initial)-r.amount+r.contribution,r.pool);poolChecks++;}
 const report={targetChecks,bandChecks,valuationChecks,remainingChecks,poolChecks,engineTests:passed,reference:'Original account workbooks: cached cell values',toleranceUSD:.015};
 fs.writeFileSync(path.join(__dirname,'verification.json'),JSON.stringify(report,null,2));console.log('EXCEL REGRESSION',JSON.stringify(report));
}else console.log('Private Excel fixtures excluded from public repository. Summary: tests/verification.json');
console.log(passed,'engine tests passed');
