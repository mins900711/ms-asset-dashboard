grant usage on schema vr_private to service_role;
create table vr_private.daily_prices (
 symbol text not null check(symbol in ('TQQQ','SPY')), price_date date not null,
 close numeric not null check(close>0), source text not null,
 is_market_close boolean not null default false, has_conflict boolean not null default false,
 incoming_close numeric, collected_at timestamptz not null default now(),
 primary key(symbol,price_date)
);
create table vr_private.price_splits (
 symbol text not null check(symbol in ('TQQQ','SPY')), split_date date not null,
 numerator numeric not null check(numerator>0), denominator numeric not null check(denominator>0),
 primary key(symbol,split_date)
);
create table vr_private.price_status (
 id smallint primary key check(id=1), status text not null default 'waiting',
 last_attempt timestamptz,last_success timestamptz,last_error text,rows_processed integer not null default 0
);
insert into vr_private.price_status(id) values(1);
alter table vr_private.daily_prices enable row level security;
alter table vr_private.price_splits enable row level security;
alter table vr_private.price_status enable row level security;
revoke all on vr_private.daily_prices,vr_private.price_splits,vr_private.price_status from public,anon,authenticated;
-- The random job key stays in Vault; no application password is used by the scheduler.
select vault.create_secret(encode(extensions.gen_random_bytes(32),'hex'),'vr_daily_job_key','VR daily closing-price collector');
create function vr_private.price_job_auth(p_secret text) returns boolean
language sql security definer set search_path='' as $$
 select p_secret is not null and exists(select 1 from vault.decrypted_secrets where name='vr_daily_job_key' and decrypted_secret=p_secret);
$$;
revoke all on function vr_private.price_job_auth(text) from public,anon,authenticated;
grant execute on function vr_private.price_job_auth(text) to service_role;
create function public.vr_price_job_auth(p_secret text) returns boolean
language sql security invoker set search_path='' as $$ select vr_private.price_job_auth(p_secret); $$;
revoke all on function public.vr_price_job_auth(text) from public,anon,authenticated;
grant execute on function public.vr_price_job_auth(text) to service_role;
create function vr_private.prices_commit(p_rows jsonb,p_splits jsonb,p_run jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare r jsonb; n integer:=0; v_day date; v_close numeric; v_symbol text; v_ny timestamptz:=clock_timestamp();
begin
 if p_run->>'phase'='start' then
  perform 1 from vr_private.price_status where id=1 for update;
  if coalesce((p_run->>'manual')::boolean,false) and exists(select 1 from vr_private.price_status where id=1 and last_attempt>clock_timestamp()-interval '15 minutes') then
   return jsonb_build_object('skipped',true);
  end if;
  update vr_private.price_status set last_attempt=clock_timestamp(),status='running',last_error=null where id=1;
  return jsonb_build_object('started',true);
 end if;
 if jsonb_typeof(p_rows) is distinct from 'array' or jsonb_array_length(p_rows)>1000 then raise exception 'invalid_prices';end if;
 for r in select value from jsonb_array_elements(p_rows) loop
  v_symbol:=r->>'symbol';v_day:=(r->>'date')::date;v_close:=(r->>'close')::numeric;
  if v_symbol not in ('TQQQ','SPY') or v_close is null or v_close<=0 or v_close>1000000 or extract(isodow from v_day)>5
    or v_day>(v_ny at time zone 'America/New_York')::date
    or (v_day=(v_ny at time zone 'America/New_York')::date and (v_ny at time zone 'America/New_York')::time<time '16:30') then raise exception 'invalid_close';end if;
  insert into vr_private.daily_prices(symbol,price_date,close,source,is_market_close)
   values(v_symbol,v_day,v_close,'yahoo_chart',true)
   on conflict(symbol,price_date) do update set
    has_conflict=abs(vr_private.daily_prices.close-excluded.close)>0.02,
    incoming_close=case when abs(vr_private.daily_prices.close-excluded.close)>0.02 then excluded.close else null end,
    close=case when abs(vr_private.daily_prices.close-excluded.close)<=0.02 then excluded.close else vr_private.daily_prices.close end,
    source=case when abs(vr_private.daily_prices.close-excluded.close)<=0.02 then excluded.source else vr_private.daily_prices.source end,
    is_market_close=true,collected_at=now();n:=n+1;
 end loop;
 for r in select value from jsonb_array_elements(coalesce(p_splits,'[]')) loop
  insert into vr_private.price_splits(symbol,split_date,numerator,denominator)
  values(r->>'symbol',(r->>'date')::date,(r->>'numerator')::numeric,(r->>'denominator')::numeric)
  on conflict(symbol,split_date) do nothing;
 end loop;
 update vr_private.price_status set status=coalesce(p_run->>'status','error'),
 last_success=case when p_run->>'status'='ok' then clock_timestamp() else last_success end,
 last_error=nullif(left(p_run->>'error',400),''),rows_processed=n where id=1;
 return jsonb_build_object('processed',n,'status',p_run->>'status');
end $$;
revoke all on function vr_private.prices_commit(jsonb,jsonb,jsonb) from public,anon,authenticated;
grant execute on function vr_private.prices_commit(jsonb,jsonb,jsonb) to service_role;
create function public.vr_prices_commit(p_rows jsonb default '[]',p_splits jsonb default '[]',p_run jsonb default '{}') returns jsonb
language sql security invoker set search_path='' as $$ select vr_private.prices_commit(p_rows,p_splits,p_run); $$;
revoke all on function public.vr_prices_commit(jsonb,jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.vr_prices_commit(jsonb,jsonb,jsonb) to service_role;
create function vr_private.prices_read(p_token text,p_data jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare v_basis date;v_since date;v_quote record;v_latest record;v_rows jsonb;v_status jsonb;v_split boolean;v_conflict boolean;v_stats jsonb;
begin
 if (vr_private.gateway('check',p_token,'{}')->>'valid') is distinct from 'true' then return jsonb_build_object('error','session_expired');end if;
 v_basis:=(p_data->>'basisDate')::date;v_since:=(p_data->>'sinceDate')::date;
 select * into v_latest from vr_private.daily_prices where symbol='TQQQ' and not has_conflict order by price_date desc limit 1;
 select * into v_quote from vr_private.daily_prices where symbol='TQQQ' and is_market_close and not has_conflict and price_date<=v_basis and price_date>=v_basis-7 order by price_date desc limit 1;
 select exists(select 1 from vr_private.price_splits where symbol='TQQQ' and split_date>coalesce(v_since,v_basis-7) and split_date<=v_basis+1) into v_split;
 select exists(select 1 from vr_private.daily_prices where symbol='TQQQ' and has_conflict and price_date<=v_basis and price_date>=coalesce(v_quote.price_date,v_basis-7)) into v_conflict;
 select jsonb_agg(to_jsonb(t) order by t.date) into v_rows from (
  select price_date as date,max(close) filter(where symbol='TQQQ') as tqqq,max(close) filter(where symbol='SPY') as spy,
   bool_and(is_market_close) as market_close,bool_or(has_conflict) as conflict
  from vr_private.daily_prices group by price_date order by price_date desc limit 5000
 )t;
 select to_jsonb(t) into v_status from (select status,last_attempt,last_success,last_error,rows_processed from vr_private.price_status where id=1)t;
 select jsonb_build_object('dates',count(distinct price_date),'rows',count(*),'firstDate',min(price_date),'lastDate',max(price_date),'conflicts',count(*)filter(where has_conflict)) into v_stats from vr_private.daily_prices;
 return jsonb_build_object('rows',coalesce(v_rows,'[]'),'stats',v_stats,'collection',v_status,
  'latest',case when v_latest.symbol is null then null else jsonb_build_object('date',v_latest.price_date,'price',v_latest.close,'source',v_latest.source,'marketClose',v_latest.is_market_close)end,
  'basis',case when v_quote.symbol is null then null else jsonb_build_object('basisDate',v_basis,'actualDate',v_quote.price_date,'price',v_quote.close,'hasSplit',v_split,'hasConflict',v_conflict,'source','automatic_daily')end);
end $$;
revoke all on function vr_private.prices_read(text,jsonb) from public;
grant execute on function vr_private.prices_read(text,jsonb) to anon,authenticated;
create function public.vr_daily_prices(p_token text,p_data jsonb default '{}') returns jsonb
language sql security invoker set search_path='' as $$ select vr_private.prices_read(p_token,p_data); $$;
revoke all on function public.vr_daily_prices(text,jsonb) from public;
grant execute on function public.vr_daily_prices(text,jsonb) to anon,authenticated;
-- Native server schedule. Nothing depends on an open browser or a user session.
create function vr_private.collect_daily_prices() returns bigint language sql security invoker set search_path='' as $$
 select net.http_post(
  url:='https://rcauycwrtqtuyllnsxog.supabase.co/functions/v1/vr-daily-prices',
  headers:=jsonb_build_object('Content-Type','application/json','x-vr-job-key',(select decrypted_secret from vault.decrypted_secrets where name='vr_daily_job_key')),
  body:='{}'::jsonb,timeout_milliseconds:=45000
 );
$$;
revoke all on function vr_private.collect_daily_prices() from public,anon,authenticated;
select cron.schedule('vr-daily-close-and-retry','20 22,23 * * 1-5','select vr_private.collect_daily_prices();');
