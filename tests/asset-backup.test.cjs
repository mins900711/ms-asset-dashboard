const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
const path=require('node:path');
const source=fs.readFileSync(path.join(__dirname,'../src/asset-backup.js'),'utf8');
const context={};vm.createContext(context);vm.runInContext(source,context);
const payload={
 dashboard:{total_krw:1400000,total_usd:1000,assets:[{asset_name:'미국주식',amount_krw:1400000,sort_order:1}],password:'never-export'},
 fx_rate:1400,
 holdings:[{owner_key:'dad',owner_label:'테스트',account_name:'테스트 계좌',account_type:'증권',asset_name:'테스트ETF',quantity:10,sort_order:1,password:'never-export'}],
 history:[{record_date:'2026-01-01',total_krw:1200000,total_usd:900},{record_date:'2026-10-20',total_krw:1400000,total_usd:1000}],
 composition_history:[{record_date:'2026-10-20',asset_name:'미국주식',amount_krw:1400000,entry_type:'asset',sort_order:1}],
 market_prices:[{price_key:'TEST',display_name:'테스트ETF',symbol:'TEST',market:'US',quote_currency:'USD',price:100,unit:'USD',price_date:'2026-10-27',data_status:'ok',sort_order:1,token:'never-export'}],
 asset_config:[{asset_name:'테스트ETF',price_key:'TEST',currency:'USD',unit:'주',fixed_price:null,direct_value:false,liability:false,reference_price:false,home_category:'미국주식',home_mode:'direct',special_role:null,sort_order:1}],
 password:'never-export',api_key:'never-export',session_token:'never-export'
};
const backup=context.buildAssetBackup(payload,new Date('2026-10-28T02:00:00Z'));
assert.equal(backup.exportedAtKst,'2026-10-28 11:00');
assert.equal(backup.data.history.length,2);
assert.ok(!JSON.stringify(backup).includes('never-export'));
assert.equal(context.validateAssetBackup(JSON.parse(JSON.stringify(backup))).format,'ms-asset-dashboard-backup');
const reject=mutate=>{const copy=structuredClone(backup);mutate(copy);assert.throws(()=>context.validateAssetBackup(copy));};
reject(b=>b.format='vr-backup');
reject(b=>b.version=2);
reject(b=>b.data.holdings[0].quantity=-1);
reject(b=>b.data.holdings[0].quantity='10');
reject(b=>b.data.holdings.push({...b.data.holdings[0]}));
reject(b=>b.data.holdings[0].owner_key='__proto__');
reject(b=>b.data.history[0].record_date='2026-02-30');
reject(b=>b.data.history[0].total_krw=0);
reject(b=>b.data.composition_history[0].amount_krw=10.5);
reject(b=>b.data.composition_history[0].entry_type='script');
reject(b=>b.data.composition_history[0].sort_order=null);
console.log('Backup roundtrip, secret exclusion, format/quantity/date/duplicate validation passed');

const page=fs.readFileSync(path.join(__dirname,'../index.html'),'utf8');
assert.equal(page.split('// BEGIN ASSET BACKUP\n')[1].split('// END ASSET BACKUP')[0].trim(),source.trim());
