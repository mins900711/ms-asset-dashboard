-- Wednesday 09:00 Asia/Seoul, on alternate weeks from 2026-12-02.
-- Only completed Tuesday records are imported. No browser session is needed.
create table if not exists vr_private.asset_sync_runs (
 account text not null check(account in ('minsu','bobae')),
 cycle_date date not null,
 source_revision bigint not null,
 synced_at timestamptz not null default now(),
 primary key(account,cycle_date)
);
alter table vr_private.asset_sync_runs enable row level security;
revoke all on vr_private.asset_sync_runs from public,anon,authenticated;

create or replace function vr_private.sync_asset_dashboard(p_run_at timestamptz default now())
returns jsonb language plpgsql security invoker set search_path='' as $$
declare
 local_time timestamp:=p_run_at at time zone 'Asia/Seoul';
 run_date date:=local_time::date;
 trade_date date:=run_date-1;
 s jsonb; revision bigint; rec jsonb; who text; owner_id text; cash_asset text;
 shares numeric; pool numeric; affected integer; imported integer:=0;
 fx numeric; total numeric; difference numeric;
begin
 if p_run_at is null or run_date<date '2026-12-02'
  or (run_date-date '2026-12-02')%14<>0 or local_time::time<time '09:00' then
  return jsonb_build_object('status','outside_schedule','imported',0);
 end if;
 -- Lock the source before targets, matching the VR write path.
 lock table vr_private.state in share mode;
 select state,st.revision into s,revision from vr_private.state st where id=1;
 if s is null or s->>'demo' is distinct from 'false' or s->>'baselineConfirmed' is distinct from 'true' then
  return jsonb_build_object('status','unconfirmed_source','imported',0);
 end if;
 lock table vr_private.asset_sync_runs,public.portfolio_holdings,
  public.ms_dashboard_assets,public.ms_dashboard_summary in share row exclusive mode;
 foreach who in array array['minsu','bobae'] loop
  if exists(select 1 from vr_private.asset_sync_runs where account=who and cycle_date=trade_date) then continue; end if;
  select value into rec from jsonb_array_elements(s->'records')
   where value->>'account'=who and value->>'cycleDate'=trade_date::text and value->>'source'='web'
   order by value->>'createdAt' desc nulls last limit 1;
  -- Draft orders, older balances and imported historical rows are never copied.
  if rec is null then continue; end if;
  if jsonb_typeof(rec->'holdings') is distinct from 'number'
   or jsonb_typeof(rec->'pool') is distinct from 'number'
   or rec->>'asOf' is distinct from trade_date::text then raise exception 'invalid_vr_balance'; end if;
  shares:=(rec->>'holdings')::numeric; pool:=(rec->>'pool')::numeric;
  if shares<0 or shares<>trunc(shares) or pool<0 then raise exception 'invalid_vr_quantity'; end if;
  owner_id:=case who when 'minsu' then 'dad' else 'mom' end;
  cash_asset:=case who when 'minsu' then 'USD 현금 (TQQQ)' else 'USD 현금' end;
  update public.portfolio_holdings set quantity=case asset_name when 'TQQQ' then shares else pool end,updated_at=now()
   where owner_key=owner_id and account_name='해외자산' and asset_name in ('TQQQ',cash_asset);
  get diagnostics affected=row_count;
  if affected<>2 then raise exception 'missing_vr_target_holdings'; end if;
  insert into vr_private.asset_sync_runs(account,cycle_date,source_revision,synced_at)
   values(who,trade_date,revision,p_run_at);
  imported:=imported+1;
 end loop;
 if imported=0 then return jsonb_build_object('status','no_new_completed_trade','imported',0); end if;

 -- Revalue the current dashboard at existing prices, without touching History.
 select price into strict fx from public.market_prices where price_key='USD/KRW' and is_active;
 if fx is null or fx<=0 then raise exception 'missing_fx_rate'; end if;
 if exists(select 1 from public.portfolio_holdings p left join public.ms_asset_config c using(asset_name)
  left join public.market_prices m on m.price_key=c.price_key and m.is_active
  where p.quantity>0 and (c.asset_name is null or
   coalesce(nullif(m.price,0),nullif(c.fixed_price,0),case when c.direct_value then 1 else 0 end)<=0))
 then raise exception 'missing_asset_price'; end if;
 with valued as (
  select case when c.home_mode in ('delta','direct','replace') and coalesce(c.home_category,'')<>'' then c.home_category
   when c.special_role in ('house','loan') then '주택' else '기타' end category,
   p.quantity*coalesce(nullif(m.price,0),nullif(c.fixed_price,0),case when c.direct_value then 1 else 0 end)
   *case when c.currency='USD' then fx else 1 end*case when c.liability then -1 else 1 end amount
  from public.portfolio_holdings p join public.ms_asset_config c using(asset_name)
  left join public.market_prices m on m.price_key=c.price_key and m.is_active
 ), grouped as(select category,greatest(0,round(sum(amount))) amount from valued group by category)
 update public.ms_dashboard_assets d set amount_krw=g.amount,updated_at=now() from grouped g where d.asset_name=g.category;
 select greatest(0,round(sum(p.quantity*coalesce(nullif(m.price,0),nullif(c.fixed_price,0),case when c.direct_value then 1 else 0 end)
  *case when c.currency='USD' then fx else 1 end*case when c.liability then -1 else 1 end))) into total
 from public.portfolio_holdings p join public.ms_asset_config c using(asset_name)
 left join public.market_prices m on m.price_key=c.price_key and m.is_active;
 select total-coalesce(sum(amount_krw),0) into difference from public.ms_dashboard_assets;
 if abs(difference)>10 then raise exception 'dashboard_category_mismatch'; end if;
 if difference<>0 then
  update public.ms_dashboard_assets set amount_krw=amount_krw+difference
   where asset_name=(select asset_name from public.ms_dashboard_assets order by amount_krw desc,asset_name limit 1);
 end if;
 update public.ms_dashboard_summary set total_krw=total,total_usd=round(total/fx),updated_at=now() where singleton=true;
 return jsonb_build_object('status','synced','imported',imported,'trade_date',trade_date);
end $$;
revoke all on function vr_private.sync_asset_dashboard(timestamptz) from public,anon,authenticated;

-- Cron is UTC. The function enforces the 14-day interval and per-account idempotency.
select cron.schedule('vr-to-assets-biweekly-wednesday','0 0 * * 3',
 'select vr_private.sync_asset_dashboard();');
