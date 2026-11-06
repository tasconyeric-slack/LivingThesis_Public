-- Issue #21: Check for Updates event types, probe and owner scoping on actual PostgreSQL.
begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
select plan(12);
insert into auth.users (id, email) values
    ('33333333-3333-4333-8333-333333333333', 'v08-check-a@example.invalid'),
    ('44444444-4444-4444-8444-444444444444', 'v08-check-b@example.invalid');
set local v08.state = '{"id":"dddddddd-dddd-4ddd-8ddd-dddddddddddd","standing":{"ticker":"NVDA","version":1,"statement":"Adopted approved baseline statement text."},"lineage":{"kind":"owner_approved_baseline"}}';

set local role service_role;
select is(public.v08_check_schema_version(), 1, 'service role sees the check schema probe');
select lives_ok($$select public.v07_create_workspace(
    '33333333-3333-4333-8333-333333333333','dddddddd-dddd-4ddd-8ddd-dddddddddddd','NVDA',
    'adopt-1',repeat('a',64),current_setting('v08.state')::jsonb,
    '[{"event_type":"workspace_created","payload":{}},{"event_type":"baseline_adopted","payload":{"lineage":{}}}]')$$,
    'adoption appends workspace_created and baseline_adopted atomically');
select lives_ok($$select public.v07_commit_workspace(
    '33333333-3333-4333-8333-333333333333','dddddddd-dddd-4ddd-8ddd-dddddddddddd',1,1,
    'check-1',repeat('b',64),current_setting('v08.state')::jsonb,
    '[{"event_type":"check_started","payload":{"run_id":"chk_20261018T000000Z_aaaaaa"}},{"event_type":"check_stage_recorded","payload":{"run_id":"chk_20261018T000000Z_aaaaaa"}},{"event_type":"check_completed","payload":{"run_id":"chk_20261018T000000Z_aaaaaa"}}]')$$,
    'a check step commits its Run Record parts with the state');
select is((select revision from public.workspaces where id='dddddddd-dddd-4ddd-8ddd-dddddddddddd'), 2, 'a check step is one CAS revision');
select is((select active_thesis_version from public.workspaces where id='dddddddd-dddd-4ddd-8ddd-dddddddddddd'), 1, 'a check never advances the Standing version');
select lives_ok($$select public.v07_commit_workspace(
    '33333333-3333-4333-8333-333333333333','dddddddd-dddd-4ddd-8ddd-dddddddddddd',2,1,
    'confirm-1',repeat('c',64),current_setting('v08.state')::jsonb,
    '[{"event_type":"monitoring_confirmed","payload":{}}]')$$, 'monitoring confirmation is an allowed event');
select throws_ok($$select public.v07_commit_workspace(
    '33333333-3333-4333-8333-333333333333','dddddddd-dddd-4ddd-8ddd-dddddddddddd',3,1,
    'bad-1',repeat('d',64),current_setting('v08.state')::jsonb,
    '[{"event_type":"check_deleted","payload":{}}]')$$, 'PT400', 'invalid_workspace_events', 'unknown event types are still refused');
select throws_ok($$select public.v07_commit_workspace(
    '44444444-4444-4444-8444-444444444444','dddddddd-dddd-4ddd-8ddd-dddddddddddd',3,1,
    'attack-1',repeat('e',64),current_setting('v08.state')::jsonb,
    '[{"event_type":"check_started","payload":{}}]')$$, 'PT404', 'workspace_not_found', 'another owner cannot write a check');
select throws_ok($$insert into public.workspace_events(workspace_id, sequence, event_type, payload, idempotency_key)
    values ('dddddddd-dddd-4ddd-8ddd-dddddddddddd', 99, 'check_deleted', '{}', 'x')$$, '23514', null,
    'the table constraint refuses unknown event types');
select results_eq($$select event_type from public.workspace_events where workspace_id='dddddddd-dddd-4ddd-8ddd-dddddddddddd' order by sequence$$,
    array['workspace_created','baseline_adopted','check_started','check_stage_recorded','check_completed','monitoring_confirmed'],
    'Run Record parts are append-only and ordered');

reset role;
set local role authenticated;
set local request.jwt.claim.sub = '44444444-4444-4444-8444-444444444444';
select is((select count(*)::integer from public.workspace_events where workspace_id='dddddddd-dddd-4ddd-8ddd-dddddddddddd'), 0,
    'RLS hides another owner''s check records');
select throws_ok($$select public.v08_check_schema_version()$$, '42501', null, 'browser roles cannot call the probe');

select * from finish();
rollback;
