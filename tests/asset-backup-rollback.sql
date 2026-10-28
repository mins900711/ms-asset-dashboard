-- Run after backend/backup.sql. All record changes are rolled back.
begin;
do $test$
declare d jsonb:=private.ms_build_full_app_data(); b jsonb; f text; rejected boolean;
begin
 b:=jsonb_build_object('format','ms-asset-dashboard-backup','version',1,'data',d);
 perform ms_backup_private.validate_backup(b);
 f:=ms_backup_private.fingerprint();
 perform ms_backup_private.restore_records(b,f);
 assert (private.ms_build_full_app_data()->'holdings')=(d->'holdings');
 assert (private.ms_build_full_app_data()->'history')=(d->'history');
 assert (private.ms_build_full_app_data()->'composition_history')=(d->'composition_history');
 assert (private.ms_build_full_app_data()->'market_prices')=(d->'market_prices');
 assert (private.ms_build_full_app_data()->'asset_config')=(d->'asset_config');
 rejected:=false;
 begin perform ms_backup_private.restore_records(b,'stale');
 exception when others then rejected:=SQLERRM='backup_revision_conflict'; end;
 assert rejected;
 rejected:=false;
 begin perform ms_backup_private.validate_backup(jsonb_set(b,'{data,holdings,0,quantity}','-1'::jsonb));
 exception when others then rejected:=true; end;
 assert rejected;
 assert not has_function_privilege('anon','ms_backup_private.restore_records(jsonb,text)','execute');
 assert not has_function_privilege('anon','ms_backup_private.fingerprint()','execute');
end $test$;
set local role anon;
do $test$ begin
 assert public.ms_backup_gateway(null,'prepare')->>'error'='invalid_admin_password';
 assert public.ms_backup_gateway(null,'restore','{}'::jsonb)->>'error'='invalid_admin_password';
end $test$;
rollback;
select 'Backup roundtrip, validation, conflict and anonymous access checks passed; rolled back' result;
