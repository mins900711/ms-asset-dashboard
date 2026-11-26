-- Synthetic balances only; every mutation is rolled back.
begin;
do $$
declare
 result jsonb; records jsonb;
 original_other jsonb; history_before jsonb;
begin
 if has_function_privilege('anon','vr_private.sync_asset_dashboard(timestamptz)','EXECUTE')
  or has_function_privilege('authenticated','vr_private.sync_asset_dashboard(timestamptz)','EXECUTE')
 then raise exception 'Sync must not be callable from browsers'; end if;
 select jsonb_build_array(
  (select jsonb_agg(to_jsonb(h) order by record_date) from public.ms_net_worth_history h),
  (select jsonb_agg(to_jsonb(h) order by record_date,asset_name) from public.asset_composition_history h)
 ) into history_before;
 select jsonb_agg(to_jsonb(p) order by id) into original_other from public.portfolio_holdings p
 where not(account_name='해외자산' and ((owner_key='dad' and asset_name in ('TQQQ','USD 현금 (TQQQ)'))
  or (owner_key='mom' and asset_name in ('TQQQ','USD 현금'))));
 result:=vr_private.sync_asset_dashboard('2026-12-02 08:59:00+09');
 if result->>'status'<>'outside_schedule' then raise exception 'Early guard failed'; end if;
 result:=vr_private.sync_asset_dashboard('2026-12-09 09:00:00+09');
 if result->>'status'<>'outside_schedule' then raise exception 'Alternate-week guard failed'; end if;
 update vr_private.state set state=jsonb_set(state,'{records}','[]'::jsonb) where id=1;
 result:=vr_private.sync_asset_dashboard('2026-12-02 09:00:00+09');
 if (result->>'imported')::int<>0 then raise exception 'Missing completion guard failed'; end if;
 records:='[{"account":"minsu","cycleDate":"2026-12-01","asOf":"2026-12-01","source":"web","holdings":17,"pool":125}]'::jsonb;
 update vr_private.state set state=jsonb_set(state,'{records}',records) where id=1;
 result:=vr_private.sync_asset_dashboard('2026-12-02 09:00:00+09');
 if (result->>'imported')::int<>1 then raise exception 'Completed first account was not imported'; end if;
 if (select quantity from public.portfolio_holdings where owner_key='dad' and account_name='해외자산' and asset_name='TQQQ')<>17
  or (select quantity from public.portfolio_holdings where owner_key='dad' and account_name='해외자산' and asset_name='USD 현금 (TQQQ)')<>125
 then raise exception 'First account values incorrect'; end if;
 records:=records||'[{"account":"bobae","cycleDate":"2026-12-01","asOf":"2026-12-01","source":"web","holdings":29,"pool":250}]'::jsonb;
 update vr_private.state set state=jsonb_set(state,'{records}',records) where id=1;
 result:=vr_private.sync_asset_dashboard('2026-12-02 09:00:00+09');
 if (result->>'imported')::int<>1 then raise exception 'Per-account idempotency failed'; end if;
 if (select quantity from public.portfolio_holdings where owner_key='mom' and account_name='해외자산' and asset_name='TQQQ')<>29
  or (select quantity from public.portfolio_holdings where owner_key='mom' and account_name='해외자산' and asset_name='USD 현금')<>250
 then raise exception 'Second account values incorrect'; end if;
 result:=vr_private.sync_asset_dashboard('2026-12-02 09:00:00+09');
 if (result->>'imported')::int<>0 then raise exception 'Duplicate execution changed balances'; end if;
 if (select count(*) from vr_private.asset_sync_runs where cycle_date='2026-12-01')<>2 then raise exception 'Missing sync log'; end if;
 if (select total_krw from public.ms_dashboard_summary where singleton=true)<>(select sum(amount_krw) from public.ms_dashboard_assets)
 then raise exception 'Dashboard sum mismatch'; end if;
 if (select jsonb_agg(to_jsonb(p) order by id) from public.portfolio_holdings p
 where not(account_name='해외자산' and ((owner_key='dad' and asset_name in ('TQQQ','USD 현금 (TQQQ)'))
  or (owner_key='mom' and asset_name in ('TQQQ','USD 현금'))))) is distinct from original_other
 then raise exception 'Unrelated holdings changed'; end if;
 if jsonb_build_array(
  (select jsonb_agg(to_jsonb(h) order by record_date) from public.ms_net_worth_history h),
  (select jsonb_agg(to_jsonb(h) order by record_date,asset_name) from public.asset_composition_history h)
 ) is distinct from history_before then raise exception 'History changed'; end if;
end $$;
rollback;
select 'rollback tests passed' as result;
