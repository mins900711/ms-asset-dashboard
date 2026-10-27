const cors={'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'authorization, apikey, content-type, x-vr-job-key','Access-Control-Allow-Methods':'POST, OPTIONS'};
const send=(data:unknown,status=200)=>new Response(JSON.stringify(data),{status,headers:{...cors,'Content-Type':'application/json','Cache-Control':'no-store'}});
const base=Deno.env.get('SUPABASE_URL')!;
const service=Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
async function rpc(name:string,body:unknown,privileged=true){const key=privileged?service:Deno.env.get('SUPABASE_ANON_KEY')!;const r=await fetch(base+'/rest/v1/rpc/'+name,{method:'POST',headers:{apikey:key,Authorization:'Bearer '+key,'Content-Type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(12000)});if(!r.ok)throw Error('database_write_failed');return r.json();}
export function dateInNY(time:Date){return new Intl.DateTimeFormat('sv-SE',{timeZone:'America/New_York',year:'numeric',month:'2-digit',day:'2-digit'}).format(time);}
export function parseDaily(raw:any,symbol:string,now:Date){
 const r=raw?.chart?.result?.[0];if(!r||r.meta?.symbol!==symbol||r.meta?.currency!=='USD'||r.meta?.exchangeTimezoneName!=='America/New_York')throw Error('invalid_quote_response');
 const local=dateInNY(now),hour=Number(new Intl.DateTimeFormat('en-US',{timeZone:'America/New_York',hour:'2-digit',hourCycle:'h23'}).format(now));
 const minute=Number(new Intl.DateTimeFormat('en-US',{timeZone:'America/New_York',minute:'2-digit'}).format(now));
 const completed=(d:string)=>d<local||(d===local&&hour*60+minute>=990);
 const rows=[],close=r.indicators?.quote?.[0]?.close;
 for(let i=0;i<(r.timestamp?.length||0);i++){const date=dateInNY(new Date(r.timestamp[i]*1000)),price=close?.[i],dow=new Date(date+'T00:00:00Z').getUTCDay();
  if(completed(date)&&![0,6].includes(dow)&&typeof price==='number'&&Number.isFinite(price)&&price>0)rows.push({symbol,date,close:Math.round(price*10000)/10000});
 }
 if(!rows.length)throw Error('no_completed_closes');
 const unique=new Map(rows.map(x=>[x.date,x]));const result=[...unique.values()].sort((a,b)=>a.date.localeCompare(b.date));
 if(now.getTime()-Date.parse(result.at(-1)!.date+'T00:00:00Z')>7*86400000)throw Error('stale_quote_response');
 const splits=Object.values(r.events?.splits||{}).map((x:any)=>({symbol,date:dateInNY(new Date(x.date*1000)),numerator:Number(x.numerator),denominator:Number(x.denominator)})).filter(x=>completed(x.date)&&x.numerator>0&&x.denominator>0);
 return{rows:result,splits};
}
Deno.serve(async(req:Request)=>{
 if(req.method==='OPTIONS')return new Response('ok',{headers:cors});if(req.method!=='POST')return send({message:'method_not_allowed'},405);
 let started=false;
 try{
  const jobKey=req.headers.get('x-vr-job-key');let manual=true;
  if(jobKey){if(await rpc('vr_price_job_auth',{p_secret:jobKey})!==true)return send({message:'authentication_required'},401);manual=false;}
  else{const token=req.headers.get('Authorization')?.replace(/^Bearer /,'');if(!token||!(/^[0-9a-f]{64}$/).test(token))return send({message:'authentication_required'},401);
   const check=await rpc('vr_gateway',{p_action:'check',p_token:token,p_data:{}},false);if(check?.valid!==true)return send({message:'authentication_required'},401);
  }
  const begin=await rpc('vr_prices_commit',{p_run:{phase:'start',manual}});if(begin.skipped)return send({skipped:true,message:'최근 수집이 실행되었습니다. 잠시 후 기록을 확인해 주세요.'});started=true;
  const now=new Date(),start=Math.floor((now.getTime()-50*86400000)/1000),end=Math.floor(now.getTime()/1000)+86400;
  const results=await Promise.allSettled(['TQQQ','SPY'].map(async symbol=>{
   const response=await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?period1=${start}&period2=${end}&interval=1d&events=splits`,{headers:{'User-Agent':'VR-personal-tracker/2.0'},signal:AbortSignal.timeout(15000)});
   if(!response.ok)throw Error('provider_http_'+response.status);return parseDaily(await response.json(),symbol,now);
  }));
  const rows:any[]=[],splits:any[]=[],errors:string[]=[];
  results.forEach((r,i)=>{if(r.status==='fulfilled'){rows.push(...r.value.rows);splits.push(...r.value.splits);}else errors.push(['TQQQ','SPY'][i]+':'+String(r.reason?.message||'quote_fetch_failed').slice(0,100));});
  const status=errors.length===0?'ok':rows.length?'partial':'error';const saved=await rpc('vr_prices_commit',{p_rows:rows,p_splits:splits,p_run:{phase:'finish',status,error:errors.join('; ')}});
  return send({status,processed:saved.processed,latest:rows.reduce((date,x)=>x.date>date?x.date:date,''),errors},status==='error'?502:200);
 }catch{if(started)try{await rpc('vr_prices_commit',{p_run:{phase:'finish',status:'error',error:'collector_failed'}});}catch{}return send({message:'collector_failed'},502);}
});
