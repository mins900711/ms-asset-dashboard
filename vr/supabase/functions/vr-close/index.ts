// Optional Supabase Edge Function. Yahoo chart is an unofficial data source.
// Fails closed: it never substitutes a live intraday price or an unknown symbol.
const cors={"Access-Control-Allow-Origin":"*","Access-Control-Allow-Headers":"authorization, apikey, content-type, x-client-info","Access-Control-Allow-Methods":"POST, OPTIONS"};
const send=(data:unknown,status=200)=>new Response(JSON.stringify(data),{status,headers:{...cors,"Content-Type":"application/json","Cache-Control":"no-store"}});
Deno.serve(async(req:Request)=>{
 if(req.method==='OPTIONS')return new Response('ok',{headers:cors});
 if(req.method!=='POST')return send({message:'method_not_allowed'},405);
 try{
  const authorization=req.headers.get('Authorization');
  if(!authorization?.startsWith('Bearer '))return send({message:'authentication_required'},401);
  const token=authorization.slice(7);
  const check=await fetch(Deno.env.get('SUPABASE_URL')+'/rest/v1/rpc/vr_gateway',{method:'POST',headers:{apikey:Deno.env.get('SUPABASE_ANON_KEY')!,'Content-Type':'application/json'},body:JSON.stringify({p_action:'check',p_token:token,p_data:{}}),signal:AbortSignal.timeout(8000)});
  if(!check.ok||(await check.json())?.valid!==true)return send({message:'authentication_required'},401);
  const {basisDate}=await req.json();
  if(!/^\d{4}-\d{2}-\d{2}$/.test(basisDate))return send({message:'invalid_date'},400);
  const basis=new Date(basisDate+'T00:00:00Z');
  if(basis.toISOString().slice(0,10)!==basisDate||basis.getUTCDay()!==1)return send({message:'monday_required'},400);
  const kstToday=new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Seoul',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
  const nextDay=new Date(basis.getTime()+86400000).toISOString().slice(0,10);
  if(nextDay>kstToday)return send({message:'market_not_closed'},400);
  const nyParts=new Intl.DateTimeFormat('sv-SE',{timeZone:'America/New_York',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(new Date());
  const part=(type:string)=>nyParts.find(x=>x.type===type)?.value||'';
  const nyDate=part('year')+'-'+part('month')+'-'+part('day');
  if(basisDate>nyDate||(basisDate===nyDate&&(Number(part('hour'))*60+Number(part('minute'))<16*60+15)))return send({message:'market_not_closed'},400);
  const start=Math.floor((basis.getTime()-8*86400000)/1000),end=Math.floor((basis.getTime()+2*86400000)/1000);
  const url=`https://query1.finance.yahoo.com/v8/finance/chart/TQQQ?period1=${start}&period2=${end}&interval=1d&events=splits`;
  const response=await fetch(url,{headers:{'User-Agent':'VR-personal-tracker/1.0'},signal:AbortSignal.timeout(12000)});
  if(!response.ok)return send({message:'quote_provider_unavailable'},502);
  const raw=await response.json(),r=raw.chart?.result?.[0];
  if(!r||r.meta?.symbol!=='TQQQ'||r.meta?.currency!=='USD')return send({message:'invalid_symbol_response'},502);
  const close=r.indicators?.quote?.[0]?.close,rows=[];
  for(let i=0;i<(r.timestamp?.length||0);i++){
   const timestamp=r.timestamp[i],date=new Intl.DateTimeFormat('sv-SE',{timeZone:'America/New_York',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(timestamp*1000));
   if(date<=basisDate&&typeof close?.[i]==='number'&&Number.isFinite(close[i])&&close[i]>0)rows.push({date,price:close[i]});
  }
  rows.sort((a,b)=>a.date.localeCompare(b.date));const last=rows.at(-1);
  if(!last||basis.getTime()-Date.parse(last.date+'T00:00:00Z')>7*86400000)return send({message:'close_not_found'},502);
  const hasSplit=Object.values(r.events?.splits||{}).some((e:any)=>new Date(e.date*1000).toISOString().slice(0,10)<=nextDay);
  return send({symbol:'TQQQ',price:Math.round(last.price*10000)/10000,basisDate,actualDate:last.date,source:'yahoo_chart_unofficial',hasSplit});
 }catch{return send({message:'quote_fetch_failed'},502);}
});
