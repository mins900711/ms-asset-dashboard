-- JSON backup restore. Existing password verification remains authoritative.
create schema if not exists ms_backup_private;
revoke all on schema ms_backup_private from public;
grant usage on schema ms_backup_private to anon, authenticated;

create or replace function ms_backup_private.fingerprint()
returns text language sql stable security definer set search_path = '' as $$
 select md5((private.ms_build_full_app_data() - array['market_prices','asset_config','fx_rate'])::text);
$$;
revoke all on function ms_backup_private.fingerprint() from public, anon, authenticated;

create or replace function ms_backup_private.validate_backup(p_backup jsonb)
returns void language plpgsql security invoker set search_path = '' as $$
declare d jsonb; r jsonb; n text; k text; seen text[];
begin
 if p_backup->>'format' is distinct from 'ms-asset-dashboard-backup'
    or p_backup->>'version' is distinct from '1'
    or jsonb_typeof(p_backup->'data') is distinct from 'object'
    or octet_length(p_backup::text)>10485760 then
  raise exception 'invalid_backup';
 end if;
 d:=p_backup->'data';
 foreach n in array array['holdings','history','composition_history'] loop
  if jsonb_typeof(d->n) is distinct from 'array' then raise exception 'invalid_backup'; end if;
 end loop;
 if jsonb_array_length(d->'holdings') not between 1 and 2000
    or jsonb_array_length(d->'history')>20000
    or jsonb_array_length(d->'composition_history')>100000 then raise exception 'invalid_backup'; end if;
 seen:='{}';
 for r in select value from jsonb_array_elements(d->'holdings') loop
  if jsonb_typeof(r) is distinct from 'object' then raise exception 'invalid_backup'; end if;
  foreach n in array array['owner_key','owner_label','account_name','account_type','asset_name'] loop
   if jsonb_typeof(r->n) is distinct from 'string' or length(btrim(r->>n)) not between 1 and 120 then raise exception 'invalid_backup'; end if;
  end loop;
  if r->>'owner_key' not in ('dad','mom','sky','sea')
     or jsonb_typeof(r->'quantity') is distinct from 'number'
     or (r->>'quantity')::numeric not between 0 and 1e16
     or jsonb_typeof(r->'sort_order') is distinct from 'number'
     or (r->>'sort_order')::numeric not between 0 and 100000
     or (r->>'sort_order')::numeric<>trunc((r->>'sort_order')::numeric)
     or not exists(select 1 from public.ms_asset_config c where c.asset_name=r->>'asset_name') then raise exception 'invalid_backup'; end if;
  k:=jsonb_build_array(r->>'owner_key',r->>'account_name',r->>'asset_name')::text;
  if k=any(seen) then raise exception 'invalid_backup'; end if; seen:=array_append(seen,k);
 end loop;
 seen:='{}';
 for r in select value from jsonb_array_elements(d->'history') loop
  if jsonb_typeof(r) is distinct from 'object'
     or coalesce(r->>'record_date','')!~'^\d{4}-\d{2}-\d{2}$'
     or (r->>'record_date')::date not between date '1900-01-01' and (now() at time zone 'Asia/Seoul')::date
     or jsonb_typeof(r->'total_krw') is distinct from 'number'
     or jsonb_typeof(r->'total_usd') is distinct from 'number'
     or (r->>'total_krw')::numeric not between 0.000001 and 1e18
     or (r->>'total_usd')::numeric not between 0.000001 and 1e18 then raise exception 'invalid_backup'; end if;
  k:=r->>'record_date'; if k=any(seen) then raise exception 'invalid_backup'; end if; seen:=array_append(seen,k);
 end loop;
 seen:='{}';
 for r in select value from jsonb_array_elements(d->'composition_history') loop
  if jsonb_typeof(r) is distinct from 'object'
     or coalesce(r->>'record_date','')!~'^\d{4}-\d{2}-\d{2}$'
     or (r->>'record_date')::date not between date '1900-01-01' and (now() at time zone 'Asia/Seoul')::date
     or jsonb_typeof(r->'asset_name') is distinct from 'string'
     or length(btrim(r->>'asset_name')) not between 1 and 120
     or coalesce(r->>'entry_type','') not in ('asset','liability')
     or jsonb_typeof(r->'amount_krw') is distinct from 'number'
     or (r->>'amount_krw')::numeric not between 0 and 1e18
     or (r->>'amount_krw')::numeric<>trunc((r->>'amount_krw')::numeric)
     or jsonb_typeof(r->'sort_order') is distinct from 'number'
     or (r->>'sort_order')::numeric not between 0 and 100000
     or (r->>'sort_order')::numeric<>trunc((r->>'sort_order')::numeric) then raise exception 'invalid_backup'; end if;
  k:=jsonb_build_array(r->>'record_date',r->>'asset_name',r->>'entry_type')::text;
  if k=any(seen) then raise exception 'invalid_backup'; end if; seen:=array_append(seen,k);
 end loop;
end; $$;
revoke all on function ms_backup_private.validate_backup(jsonb) from public, anon, authenticated;

create or replace function ms_backup_private.restore_records(p_backup jsonb,p_expected text)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare d jsonb:=p_backup->'data'; total numeric; fx numeric; difference numeric;
begin
 perform ms_backup_private.validate_backup(p_backup);
 lock table public.ms_dashboard_summary,public.ms_dashboard_assets,public.portfolio_holdings,
   public.ms_net_worth_history,public.asset_composition_history in share row exclusive mode;
 if p_expected is null or p_expected<>ms_backup_private.fingerprint() then raise exception 'backup_revision_conflict'; end if;
 delete from public.portfolio_holdings where 1=1;
 insert into public.portfolio_holdings(owner_key,owner_label,account_name,account_type,asset_name,quantity,sort_order)
 select x.owner_key,x.owner_label,x.account_name,x.account_type,x.asset_name,x.quantity,x.sort_order
 from jsonb_to_recordset(d->'holdings') x(owner_key text,owner_label text,account_name text,account_type text,asset_name text,quantity numeric,sort_order integer);
 delete from public.ms_net_worth_history where 1=1;
 insert into public.ms_net_worth_history(record_date,total_krw,total_usd)
 select x.record_date,x.total_krw,x.total_usd from jsonb_to_recordset(d->'history') x(record_date date,total_krw numeric,total_usd numeric);
 delete from public.asset_composition_history where 1=1;
 insert into public.asset_composition_history(record_date,asset_name,amount_krw,entry_type,sort_order)
 select x.record_date,x.asset_name,x.amount_krw,x.entry_type,x.sort_order
 from jsonb_to_recordset(d->'composition_history') x(record_date date,asset_name text,amount_krw bigint,entry_type text,sort_order integer);

 -- Revalue restored quantities at today's existing prices; never rewind the price collector.
 select greatest(1,coalesce((select price from public.market_prices where price_key='USD/KRW' and is_active limit 1),1)) into fx;
 select greatest(0,round(coalesce(sum(p.quantity*
   coalesce(nullif(m.price,0),case when c.fixed_price>0 then c.fixed_price end,case when c.direct_value then 1 else 0 end)*
   case when c.currency='USD' then fx else 1 end*case when c.liability then -1 else 1 end),0))) into total
 from public.portfolio_holdings p join public.ms_asset_config c on c.asset_name=p.asset_name
 left join public.market_prices m on m.price_key=c.price_key and m.is_active;
 update public.ms_dashboard_summary set total_krw=total,total_usd=round(total/fx),updated_at=now() where singleton=true;
 delete from public.ms_dashboard_assets where 1=1;
 insert into public.ms_dashboard_assets(asset_name,amount_krw,sort_order)
 select category,greatest(0,round(sum(amount))),row_number() over(order by min(asset_order))::integer
 from (
  select case when c.home_mode in ('delta','direct','replace') and coalesce(c.home_category,'')<>'' then c.home_category
    when c.special_role in ('house','loan') then '주택' else '기타' end category,
   p.quantity*coalesce(nullif(m.price,0),case when c.fixed_price>0 then c.fixed_price end,case when c.direct_value then 1 else 0 end)*
   case when c.currency='USD' then fx else 1 end*case when c.liability then -1 else 1 end amount,
   p.sort_order asset_order
  from public.portfolio_holdings p join public.ms_asset_config c on c.asset_name=p.asset_name
  left join public.market_prices m on m.price_key=c.price_key and m.is_active
 ) v group by category having greatest(0,round(sum(amount)))>0;
 select total-coalesce(sum(amount_krw),0) into difference from public.ms_dashboard_assets;
 if difference<>0 then
  update public.ms_dashboard_assets set amount_krw=greatest(0,amount_krw+difference)
  where asset_name=(select asset_name from public.ms_dashboard_assets order by amount_krw desc,asset_name limit 1);
 end if;
 return jsonb_build_object('holdings',jsonb_array_length(d->'holdings'),'history',jsonb_array_length(d->'history'),'composition_history',jsonb_array_length(d->'composition_history'));
end; $$;
revoke all on function ms_backup_private.restore_records(jsonb,text) from public, anon, authenticated;

create or replace function ms_backup_private.gateway(p_password text,p_action text,p_data jsonb default '{}'::jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare restored jsonb;
begin
 if private.ms_role_password_ok(p_password,'admin') is not true then
  return jsonb_build_object('error','invalid_admin_password');
 end if;
 if p_action='prepare' then
  return jsonb_build_object('fingerprint',ms_backup_private.fingerprint(),'data',private.ms_build_full_app_data());
 elsif p_action='restore' then
  restored:=ms_backup_private.restore_records(p_data->'backup',p_data->>'fingerprint');
  return jsonb_build_object('restored',restored,'data',private.ms_build_full_app_data());
 else raise exception 'invalid_backup_action'; end if;
end; $$;
revoke all on function ms_backup_private.gateway(text,text,jsonb) from public;
grant execute on function ms_backup_private.gateway(text,text,jsonb) to anon, authenticated;

create or replace function public.ms_backup_gateway(p_password text,p_action text,p_data jsonb default '{}'::jsonb)
returns jsonb language sql security invoker set search_path = '' as $$
 select ms_backup_private.gateway(p_password,p_action,p_data);
$$;
revoke all on function public.ms_backup_gateway(text,text,jsonb) from public;
grant execute on function public.ms_backup_gateway(text,text,jsonb) to anon, authenticated;
