-- Run against the real migration: supabase test db.
-- Roles and JWT identities below exercise PostgreSQL grants/RLS, not a mock.
begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
select plan(36);

insert into auth.users (id, email) values
    ('11111111-1111-4111-8111-111111111111', 'v07-owner-a@example.invalid'),
    ('22222222-2222-4222-8222-222222222222', 'v07-owner-b@example.invalid');
insert into public.workspaces (id, user_id, ticker, active_thesis_version, current_state, create_key, create_digest)
values
    ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '11111111-1111-4111-8111-111111111111', 'NVDA', 1,
        '{"standing":{"ticker":"NVDA","version":1,"statement":"Owner A original investment thesis."}}', 'create-a', repeat('a',64)),
    ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', '22222222-2222-4222-8222-222222222222', 'MSFT', 1,
        '{"standing":{"ticker":"MSFT","version":1,"statement":"Owner B original investment thesis."}}', 'create-b', repeat('b',64));
insert into public.workspace_events (workspace_id, sequence, event_type, payload, idempotency_key)
values
    ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 1, 'workspace_created', '{}', 'create-a'),
    ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 1, 'workspace_created', '{}', 'create-b');

select ok((select relrowsecurity from pg_class where oid = 'public.workspaces'::regclass), 'workspaces enables RLS');
select ok((select relrowsecurity from pg_class where oid = 'public.workspace_events'::regclass), 'events enables RLS');
select ok((select relrowsecurity from pg_class where oid = 'private.workspace_mutations'::regclass), 'private outcomes enables RLS');
select ok(not has_table_privilege('anon', 'public.workspaces', 'select,insert,update,delete'), 'anon has no workspace grants');
select ok(not has_table_privilege('anon', 'public.workspace_events', 'select,insert,update,delete'), 'anon has no event grants');
select ok(has_table_privilege('authenticated', 'public.workspaces', 'select'), 'authenticated workspace SELECT is granted');
select ok(not has_table_privilege('authenticated', 'public.workspaces', 'insert,update,delete'), 'authenticated cannot overwrite its own canonical state');
select ok(not has_table_privilege('authenticated', 'public.workspace_events', 'insert,update,delete'), 'authenticated cannot forge or alter audit events');
select ok(not has_table_privilege('authenticated', 'private.workspace_mutations', 'select,insert,update,delete'), 'authenticated has no outcome table access');
select ok(not has_table_privilege('service_role', 'public.workspace_events', 'update,delete'), 'service audit access is append-only');
select ok(not has_table_privilege('service_role', 'private.workspace_mutations', 'update,delete'), 'service retry outcomes are immutable');
select ok(not has_function_privilege('authenticated', 'public.v07_commit_workspace(uuid,uuid,integer,integer,text,text,jsonb,jsonb)', 'execute'), 'authenticated has no canonical commit RPC grant');
select ok(not has_function_privilege('anon', 'public.v07_create_workspace(uuid,uuid,text,text,text,jsonb,jsonb,text)', 'execute'), 'anon has no create RPC grant');
select ok(not has_function_privilege('authenticated', 'public.v07_mutation_result(uuid,uuid,text,text)', 'execute'), 'authenticated has no outcome RPC grant');
select ok(not has_function_privilege('anon', 'public.v07_schema_version()', 'execute'), 'schema readiness RPC is service-only');
select ok(has_function_privilege('service_role', 'public.v07_commit_workspace(uuid,uuid,integer,integer,text,text,jsonb,jsonb)', 'execute'), 'service may commit validated domain state');
select ok(not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname in ('public','private') and p.proname like 'v07_%' and p.prosecdef
), 'no v07 function elevates its caller through SECURITY DEFINER');
select ok(not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname in ('public','private') and p.proname like 'v07_%'
        and not coalesce(p.proconfig @> array['search_path=""'], false)
), 'all v07 functions pin an empty search_path');

set local role anon;
select throws_ok('select * from public.workspaces', '42501', null, 'signed-out reader cannot query private workspaces');
select throws_ok('select * from public.workspace_events', '42501', null, 'signed-out reader cannot query private history');
select throws_ok('select public.v07_schema_version()', '42501', null, 'signed-out caller cannot invoke service RPC');

set local role authenticated;
set local request.jwt.claim.sub = '11111111-1111-4111-8111-111111111111';
select results_eq('select ticker from public.workspaces order by ticker', array['NVDA'], 'A reads exactly its workspace');
select is_empty($$select * from public.workspaces where id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'$$, 'A cannot read B through a forged workspace ID');
select results_eq('select workspace_id::text from public.workspace_events', array['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'], 'A reads exactly its event history');
select throws_ok($$update public.workspaces set revision = 99 where id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'$$, '42501', null, 'A cannot update B');
select throws_ok($$update public.workspaces set revision = 99 where id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'$$, '42501', null, 'A cannot bypass server semantics even on its own row');
select throws_ok('select * from private.workspace_mutations', '42501', null, 'private outcomes cannot be queried by a user');
select throws_ok($$select public.v07_mutation_result('11111111-1111-4111-8111-111111111111','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','create-a',repeat('a',64))$$, '42501', null, 'a user cannot invoke a server-only outcome RPC');

set local request.jwt.claim.sub = '22222222-2222-4222-8222-222222222222';
select results_eq('select ticker from public.workspaces order by ticker', array['MSFT'], 'B reads exactly its workspace');
select is_empty($$select * from public.workspace_events where workspace_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'$$, 'B cannot read A audit history');
select results_eq($$select revision from public.workspaces where id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'$$, array[1], 'denied A update leaves B row intact');
set local request.jwt.claim.sub = '11111111-1111-4111-8111-111111111111';
select results_eq($$select revision from public.workspaces where id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'$$, array[1], 'denied own update leaves A row intact');
select throws_ok('delete from public.workspace_events', '42501', null, 'a user cannot delete audit history');
set local request.jwt.claim.sub = '';
select is_empty('select * from public.workspaces', 'authenticated role with no subject cannot read private rows');

set local role service_role;
select results_eq('select count(*)::integer from public.workspaces', array[2], 'service can read canonical state after API verifies identity');
select throws_ok('update public.workspace_events set payload = payload', '42501', null, 'service cannot rewrite a committed audit event');
select * from finish();
rollback;
