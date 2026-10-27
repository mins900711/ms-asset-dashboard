(function(root){
'use strict';
const DAY=86400000;
const finite=(v)=>typeof v==='number'&&Number.isFinite(v);
const round=(v,n=2)=>Math.sign(v)*Math.round((Math.abs(v)+Number.EPSILON*Math.max(1,Math.abs(v)))*10**n)/10**n;
const floor=(v,n=0)=>Math.floor((v+1e-10)*10**n)/10**n;
const dateMs=(s)=>{if(!/^\d{4}-\d{2}-\d{2}$/.test(s||''))throw Error('날짜를 확인해 주세요.');const d=Date.parse(s+'T00:00:00Z');if(!finite(d)||new Date(d).toISOString().slice(0,10)!==s)throw Error('올바른 날짜가 아닙니다.');return d;};
const addDays=(s,n)=>new Date(dateMs(s)+n*DAY).toISOString().slice(0,10);
const today=()=>new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Seoul',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
function nextV(v,pool,contribution=500,g=10){if(!finite(v)||v<=0||!finite(pool)||pool<0||!finite(contribution)||contribution<0||!finite(g)||g<=0)throw Error('V와 Pool 설정을 확인해 주세요.');return v*round(1+pool/v/g,3)+contribution;}
function plan({v,holdings,pool,price,contribution=500,band=.2,usage=.75}){
 if(![v,holdings,pool,price,contribution,band,usage].every(finite)||v<=0||price<=0||holdings<0||!Number.isInteger(holdings)||pool<0||contribution<0||band<=0||band>=1||usage<0||usage>1)throw Error('계산 입력값을 확인해 주세요.');
 const low=v*(1-band),high=v*(1+band),stock=holdings*price;
 // The contribution is exchanged AFTER the stock order. Never spend unfunded dollars.
 const excelBudget=floor((pool+contribution)*usage,2),budget=Math.max(0,Math.min(pool,excelBudget));
 let quantity=0;
 if(stock>high+1e-8)quantity=-Math.min(holdings,Math.floor((stock-high)/price+1e-10)+1);
 else if(stock<low-1e-8){const needed=Math.ceil((low-stock)/price-1e-10),excelAmount=floor(Math.min(excelBudget,needed*price),2);if(excelAmount>price+1e-9)quantity=Math.min(Math.floor((excelAmount+1e-9)/price),Math.floor((pool+1e-9)/price));}
 return {v,low,high,stock,budget,quantity,amount:round(Math.abs(quantity)*price),limited:quantity>=0&&stock<low&&budget<Math.ceil((low-stock)/price-1e-10)*price,action:quantity>0?'매수':quantity<0?'매도':'유지',reserve:round((pool+contribution)*(1-usage))};
}
// Exact cached workbook M-column expression, including transactions already entered.
function excelRemaining({v,holdings,pool,price,contribution,amount,prevPool,first=false}){
 const low=v*.8,high=v*1.2,stock=holdings*price;
 if(stock>high)return -(Math.floor((stock-high)/price)+1)*price;
 const base=first?pool+contribution:prevPool+contribution;
 const max=floor(Math.min(base*.75-amount,Math.ceil((low-stock)/price)*price),2);
 if(pool<base*.25||price>=max)return 0;
 if(stock<low)return max;
 return 0;
}
function currentAccount(state,id){const a=state.accounts[id];if(!a)throw Error('계좌를 찾을 수 없습니다.');const records=state.records.filter(r=>r.account===id).sort((a,b)=>a.cycleDate.localeCompare(b.cycleDate));return records.length?records[records.length-1]:a.baseline;}
function cycleFor(state,id){return addDays(currentAccount(state,id).cycleDate,14);}
function quoteValid(state,date){const q=state.quote;return !!q&&finite(q.price)&&q.price>0&&q.confirmed&&q.date===addDays(date,-1);}
function canTrade(state,id,clock=today()){
 const date=cycleFor(state,id);
 if(!state.baselineConfirmed)return {ok:false,reason:'최신 계좌 잔고를 확인해 주세요.'};
 if(date!==clock)return {ok:false,reason:date<clock?'미기록 회차가 있습니다. 설정에서 기준 잔고와 다음 거래일을 맞춰 주세요.':'거래일 당일에 진행할 수 있습니다.'};
 if(!quoteValid(state,date))return {ok:false,reason:'직전 월요일의 미국시장 종가를 확인해 주세요. 휴장이면 그 이전 최근 거래일 종가를 확인합니다.'};
 return {ok:true,reason:''};
}
function validateBaseline(b){if(!b||![b.v,b.pool,b.holdings,b.principal].every(finite)||b.v<=0||b.pool<0||b.principal<=0||b.holdings<0||!Number.isInteger(b.holdings))throw Error('기준 잔고의 숫자를 확인해 주세요.');dateMs(b.cycleDate);dateMs(b.asOf);if(new Date(dateMs(addDays(b.cycleDate,14))).getUTCDay()!==2)throw Error('다음 거래일은 화요일이어야 합니다.');}
function validateState(s){
 if(!s||s.schemaVersion!==1||!s.accounts||!Array.isArray(s.records)||!s.drafts||typeof s.drafts!=='object')throw Error('지원하는 VR 백업 파일이 아닙니다.');
 for(const id of ['minsu','bobae']){const a=s.accounts[id];if(!a||a.id!==id||!Array.isArray(a.history)||!Array.isArray(a.weekly))throw Error('계좌 기록이 누락되어 있습니다.');validateBaseline(a.baseline);for(const r of [...a.history,...a.weekly]){if(!r||!finite(r.assets)||!finite(r.principal)||r.principal<=0||!finite(r.price)||r.price<=0)throw Error('과거 자산 기록의 숫자를 확인해 주세요.');dateMs(r.date||r.asOf);}}
 const keys=new Set();
 for(const r of s.records){if(!['minsu','bobae'].includes(r.account)||!Number.isInteger(r.quantity)||!finite(r.pool)||r.pool<0||!finite(r.v)||r.v<=0||!finite(r.principal)||r.principal<=0||!Number.isInteger(r.holdings)||r.holdings<0||!finite(r.price)||r.price<=0||!finite(r.assets)||!finite(r.contribution)||r.contribution<0)throw Error('거래 기록이 올바르지 않습니다.');dateMs(r.cycleDate);dateMs(r.asOf);const k=r.account+'-'+r.cycleDate;if(keys.has(k))throw Error('중복 거래 회차가 있습니다.');keys.add(k);}
 if(!s.settings||s.settings.contribution!==500||s.settings.band!==.2||s.settings.g!==10||s.settings.poolUsage!==.75||s.settings.rpDays!==14)throw Error('현재 버전은 회당 $500, G=10, ±20%, Pool 75%, RP 14일 설정을 지원합니다.');
 if(s.quote&&(!finite(s.quote.price)||s.quote.price<=0))throw Error('종가가 올바르지 않습니다.');if(s.quote)dateMs(s.quote.date);
 return s;
}
function complete(state,id,draft,clock=today()){
 const gate=canTrade(state,id,clock);if(!gate.ok)throw Error(gate.reason);
 const date=cycleFor(state,id),prev=currentAccount(state,id);
 if(state.records.some(r=>r.account===id&&r.cycleDate===date))throw Error('이미 저장한 회차입니다.');
 if(!draft||!Array.isArray(draft.steps)||!draft.steps.slice(0,3).every(Boolean)||draft.steps.length<3)throw Error('RP 매도, 주식 거래, $500 환전을 순서대로 완료해 주세요.');
 if(!Number.isInteger(draft.quantity)||!finite(draft.rp)||draft.rp<0||Math.abs(draft.rp*100-Math.round(draft.rp*100))>1e-7)throw Error('거래수량과 RP 금액(소수 둘째 자리)을 입력해 주세요.');
 if(prev.holdings+draft.quantity<0)throw Error('보유 수량보다 많이 매도할 수 없습니다.');
 const p=plan({v:nextV(prev.v,prev.pool,500),pool:prev.pool,holdings:prev.holdings,price:state.quote.price});
 if(Math.abs(draft.quantity)>Math.abs(p.quantity))throw Error('실제 수량이 계산 수량을 초과합니다. 기준 잔고를 확인해 주세요.');
 if(Math.sign(draft.quantity)!==Math.sign(p.quantity)&&draft.quantity!==0)throw Error('계산된 매수·매도 방향과 실제 거래 방향이 다릅니다.');
 const record={id:id+'-'+date,account:id,cycleDate:date,asOf:date,v:p.v,holdings:prev.holdings+draft.quantity,pool:draft.rp,price:state.quote.price,principal:prev.principal+500,quantity:draft.quantity,contribution:500,source:'web',rpMaturity:addDays(date,14),quoteDate:state.quote.date,createdAt:new Date().toISOString()};
 record.assets=record.holdings*record.price+record.pool;
 // RP is the observed ending balance. Execution price, fees and interest cannot be separated from two inputs.
 record.cashReconciliation=round(record.pool-(prev.pool+500-draft.quantity*record.price));
 return record;
}
function blank(){return {schemaVersion:1,updatedAt:new Date().toISOString(),accounts:{},records:[],drafts:{},settings:{contribution:500,band:.2,g:10,poolUsage:.75,rpDays:14},quote:null,baselineConfirmed:false};}
root.VR={round,floor,dateMs,addDays,today,nextV,plan,excelRemaining,currentAccount,cycleFor,quoteValid,canTrade,validateBaseline,validateState,complete,blank};
})(typeof window!=='undefined'?window:globalThis);
