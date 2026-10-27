-- Single-owner password gate. Privileged implementation stays outside the exposed schema.
create schema if not exists vr_private;
revoke all on schema vr_private from public;
grant usage on schema vr_private to anon, authenticated;
create table vr_private.security (
 id smallint primary key check(id=1), password_hash text not null,
 failed_attempts integer not null default 0, locked_until timestamptz,
 updated_at timestamptz not null default now()
);
create table vr_private.sessions (
 token_hash text primary key, expires_at timestamptz not null
);
create index vr_sessions_expiry on vr_private.sessions(expires_at);
create table vr_private.state (
 id smallint primary key check(id=1), revision bigint not null check(revision>0),
 state jsonb not null, updated_at timestamptz not null default now()
);
alter table vr_private.security enable row level security;
alter table vr_private.sessions enable row level security;
alter table vr_private.state enable row level security;
revoke all on all tables in schema vr_private from public,anon,authenticated;
-- Copy only the existing verifier; passwords are never returned or embedded in HTML.
insert into vr_private.security(id,password_hash)
select 1,admin_password_hash from private.ms_app_security where id=1 and admin_password_hash is not null;
do $$ begin if not exists(select 1 from vr_private.security) then raise exception 'initial_password_unavailable'; end if; end $$;
create or replace function vr_private.gateway(p_action text,p_token text,p_data jsonb)
returns jsonb language plpgsql security definer set search_path=''
as $$
declare
 sec vr_private.security%rowtype;
 v_token text; v_expiry timestamptz;
 v_password text; v_new text;
 v_state jsonb; v_revision bigint; v_expected bigint;
begin
 if p_action not in ('login','load','save','logout','password','check') or p_action is null then
  return jsonb_build_object('error','invalid_action');
 end if;
 if p_action='login' then
  v_password:=p_data->>'password';
  select * into sec from vr_private.security where id=1 for update;
  if sec.locked_until>clock_timestamp() then return jsonb_build_object('error','temporarily_locked'); end if;
  if v_password is null or octet_length(v_password)>72 or length(v_password)=0
    or extensions.crypt(v_password,sec.password_hash) is distinct from sec.password_hash then
   update vr_private.security set failed_attempts=case when failed_attempts>=4 then 0 else failed_attempts+1 end,
    locked_until=case when failed_attempts>=4 then clock_timestamp()+interval '5 minutes' else null end where id=1;
   return jsonb_build_object('error','invalid_password');
  end if;
  update vr_private.security set failed_attempts=0,locked_until=null where id=1;
  delete from vr_private.sessions where expires_at<=clock_timestamp();
  v_token:=encode(extensions.gen_random_bytes(32),'hex');
  v_expiry:=clock_timestamp()+interval '8 hours';
  insert into vr_private.sessions(token_hash,expires_at) values(encode(extensions.digest(v_token,'sha256'),'hex'),v_expiry);
  return jsonb_build_object('token',v_token,'expiresAt',v_expiry);
 end if;
 -- Serialize session validation, reads and writes with password changes/revocation.
 perform 1 from vr_private.security where id=1 for update;
 if p_token is null or p_token !~ '^[0-9a-f]{64}$' or not exists(
  select 1 from vr_private.sessions where token_hash=encode(extensions.digest(p_token,'sha256'),'hex') and expires_at>clock_timestamp()
 ) then return jsonb_build_object('error','session_expired'); end if;
 if p_action='check' then return jsonb_build_object('valid',true); end if;
 if p_action='logout' then
  delete from vr_private.sessions where token_hash=encode(extensions.digest(p_token,'sha256'),'hex');
  return jsonb_build_object('ok',true);
 end if;
 if p_action='password' then
  v_password:=p_data->>'password'; v_new:=p_data->>'newPassword';
  select * into sec from vr_private.security where id=1;
  if sec.locked_until>clock_timestamp() then return jsonb_build_object('error','temporarily_locked'); end if;
  if v_password is null or octet_length(v_password)>72 or extensions.crypt(v_password,sec.password_hash) is distinct from sec.password_hash then
   update vr_private.security set failed_attempts=case when failed_attempts>=4 then 0 else failed_attempts+1 end,
    locked_until=case when failed_attempts>=4 then clock_timestamp()+interval '5 minutes' else null end where id=1;
   return jsonb_build_object('error','invalid_password');
  end if;
  if v_new is null or length(v_new)<8 or octet_length(v_new)>72 then return jsonb_build_object('error','invalid_new_password'); end if;
  update vr_private.security set password_hash=extensions.crypt(v_new,extensions.gen_salt('bf',10)),failed_attempts=0,locked_until=null,updated_at=now() where id=1;
  delete from vr_private.sessions;
  v_token:=encode(extensions.gen_random_bytes(32),'hex');v_expiry:=clock_timestamp()+interval '8 hours';
  insert into vr_private.sessions(token_hash,expires_at) values(encode(extensions.digest(v_token,'sha256'),'hex'),v_expiry);
  return jsonb_build_object('token',v_token,'expiresAt',v_expiry);
 end if;
 if p_action='load' then
  select state,revision into v_state,v_revision from vr_private.state where id=1;
  if not found then return 'null'::jsonb; end if;
  return jsonb_build_object('state',v_state,'revision',v_revision);
 end if;
 v_state:=p_data->'state';
 if v_state->>'schemaVersion' is distinct from '1'
  or jsonb_typeof(v_state->'accounts') is distinct from 'object'
  or jsonb_typeof(v_state->'records') is distinct from 'array'
  or not(v_state->'accounts' ?& array['minsu','bobae'])
  or v_state->>'demo'='true' or octet_length(v_state::text)>12582912 then
  return jsonb_build_object('error','invalid_state');
 end if;
 if coalesce(p_data->>'revision','') !~ '^[0-9]{1,15}$' then return jsonb_build_object('error','revision_conflict'); end if;
 v_expected:=(p_data->>'revision')::bigint;
 select revision into v_revision from vr_private.state where id=1 for update;
 if not found then
  if v_expected<>0 then return jsonb_build_object('error','revision_conflict'); end if;
  insert into vr_private.state(id,revision,state) values(1,1,v_state);v_revision:=1;
 else
  if v_expected<>v_revision then return jsonb_build_object('error','revision_conflict'); end if;
  v_revision:=v_revision+1;
  update vr_private.state set state=v_state,revision=v_revision,updated_at=now() where id=1;
 end if;
 return jsonb_build_object('revision',v_revision);
end;
$$;
revoke all on function vr_private.gateway(text,text,jsonb) from public;
grant execute on function vr_private.gateway(text,text,jsonb) to anon,authenticated;
create or replace function public.vr_gateway(p_action text,p_token text default null,p_data jsonb default '{}'::jsonb)
returns jsonb language sql security invoker set search_path=''
as $$ select vr_private.gateway(p_action,p_token,p_data); $$;
revoke all on function public.vr_gateway(text,text,jsonb) from public;
grant execute on function public.vr_gateway(text,text,jsonb) to anon,authenticated;
