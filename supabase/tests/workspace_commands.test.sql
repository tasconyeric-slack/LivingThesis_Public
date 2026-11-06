-- Atomic commands/idempotency tests against actual PostgreSQL functions.
begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
select plan(48);
insert into auth.users (id, email) values
    ('11111111-1111-4111-8111-111111111111', 'v07-command-a@example.invalid'),
    ('22222222-2222-4222-8222-222222222222', 'v07-command-b@example.invalid');
create temporary table v07_test_results (label text primary key, result jsonb);
grant select, insert on v07_test_results to service_role;
set local v07.test_initial = '{"id":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","standing":{"ticker":"NVDA","version":1,"statement":"Original exact investment thesis text."},"history":[]}';
set local v07.test_changed = '{"id":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","standing":{"ticker":"NVDA","version":2,"statement":"Revised exact investment thesis text."},"history":[{"version":1,"statement":"Original exact investment thesis text."}]}';
set local v07.test_import = '{"id":"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb","standing":{"ticker":"MSFT","version":3,"statement":"Imported original investment thesis text."},"history":[]}';
set local v07.test_import_changed = '{"id":"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb","standing":{"ticker":"MSFT","version":4,"statement":"Newer canonical investment thesis text."},"history":[{"version":3,"statement":"Imported original investment thesis text."}]}';

set local role service_role;
select is(public.v07_schema_version(), 1, 'service readiness advertises schema v1');
insert into v07_test_results values ('created', public.v07_create_workspace(
    '11111111-1111-4111-8111-111111111111', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'NVDA',
    'create-a', repeat('a',64), current_setting('v07.test_initial')::jsonb,
    '[{"event_type":"workspace_created","payload":{"confirmed":true}}]'));
select is((select (result->>'revision')::integer from v07_test_results where label='created'), 1, 'creation starts at workspace revision 1');
select is((select (result->>'active_thesis_version')::integer from v07_test_results where label='created'), 1, 'creation retains initial Standing version');
select is((select result->'current_state' from v07_test_results where label='created'), current_setting('v07.test_initial')::jsonb, 'creation preserves exact supported domain state');
select is(public.v07_create_workspace(
    '11111111-1111-4111-8111-111111111111', 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', 'NVDA',
    'create-a', repeat('a',64), jsonb_set(current_setting('v07.test_initial')::jsonb,'{id}','"cccccccc-cccc-4ccc-8ccc-cccccccccccc"'),
    '[{"event_type":"workspace_created","payload":{}}]'),
    (select result from v07_test_results where label='created'), 'retried create returns original result despite a newly generated workspace UUID');
select throws_ok($$select public.v07_create_workspace(
    '11111111-1111-4111-8111-111111111111','cccccccc-cccc-4ccc-8ccc-cccccccccccc','NVDA',
    'create-a',repeat('b',64),jsonb_set(current_setting('v07.test_initial')::jsonb,'{id}','"cccccccc-cccc-4ccc-8ccc-cccccccccccc"'),
    '[{"event_type":"workspace_created","payload":{}}]')$$, 'PT409', 'idempotency_conflict', 'same create key cannot authorize a different request');
select is((select count(*)::integer from public.workspaces), 1, 'create retries do not duplicate a workspace');
select throws_ok($$select public.v07_create_workspace(
    '11111111-1111-4111-8111-111111111111','cccccccc-cccc-4ccc-8ccc-cccccccccccc','NVDA',
    'wrong-state-id',repeat('b',64),current_setting('v07.test_initial')::jsonb,
    '[{"event_type":"workspace_created","payload":{}}]')$$, 'PT400', 'workspace_state_identity_mismatch', 'create binds materialized state identity to workspace UUID');

insert into v07_test_results values ('assessed', public.v07_commit_workspace(
    '11111111-1111-4111-8111-111111111111','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',1,1,
    'assess-a',repeat('c',64),current_setting('v07.test_initial')::jsonb,
    '[{"event_type":"evidence_added","payload":{"evidence_id":"E1"}},{"event_type":"assessment_created","payload":{"assessment_id":"A1"}}]'));
select is((select (result->>'revision')::integer from v07_test_results where label='assessed'), 2, 'two-event assessment advances one command revision');
select is((select (result->>'active_thesis_version')::integer from v07_test_results where label='assessed'), 1, 'assessment never advances Standing version');
select results_eq($$select sequence::integer from public.workspace_events where workspace_id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' order by sequence$$, array[1,2,3], 'multiple events append consecutive sequence numbers');
select is(public.v07_commit_workspace(
    '11111111-1111-4111-8111-111111111111','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',1,1,
    'assess-a',repeat('c',64),null,null),
    (select result from v07_test_results where label='assessed'), 'identical retry returns outcome before stale/consumed-state validation');
select is(public.v07_mutation_result('11111111-1111-4111-8111-111111111111','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','assess-a',repeat('c',64)),
    (select result from v07_test_results where label='assessed'), 'pre-validation lookup returns original committed outcome');
select is(public.v07_mutation_result('11111111-1111-4111-8111-111111111111','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','not-committed',repeat('c',64)), null::jsonb, 'uncommitted key has no outcome');
select throws_ok($$select public.v07_mutation_result('22222222-2222-4222-8222-222222222222','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','assess-a',repeat('c',64))$$, 'PT404', 'workspace_not_found', 'outcome lookup verifies owner before revealing retry state');
select throws_ok($$select public.v07_mutation_result('11111111-1111-4111-8111-111111111111','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','assess-a',repeat('d',64))$$, 'PT409', 'idempotency_conflict', 'outcome lookup rejects reused key with a different digest');
select throws_ok($$select public.v07_commit_workspace(
    '22222222-2222-4222-8222-222222222222','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',1,1,
    'assess-a',repeat('c',64),null,null)$$, 'PT404', 'workspace_not_found', 'wrong owner cannot replay another user outcome');
select throws_ok($$select public.v07_commit_workspace(
    '11111111-1111-4111-8111-111111111111','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',1,1,
    'stale-tab',repeat('d',64),current_setting('v07.test_initial')::jsonb,
    '[{"event_type":"assessment_created","payload":{}}]')$$, 'PT409', 'stale_workspace_revision', 'second tab at old revision fails closed');
select throws_ok($$select public.v07_commit_workspace(
    '11111111-1111-4111-8111-111111111111','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',2,99,
    'wrong-version',repeat('d',64),current_setting('v07.test_initial')::jsonb,
    '[{"event_type":"assessment_created","payload":{}}]')$$, 'PT409', 'stale_thesis_version', 'matching revision still requires exact Standing version');
select is((select revision from public.workspaces where id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'), 2, 'denied stale mutations leave current revision intact');

insert into v07_test_results values ('rejected', public.v07_commit_workspace(
    '11111111-1111-4111-8111-111111111111','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',2,1,
    'reject-a',repeat('d',64),current_setting('v07.test_initial')::jsonb,
    '[{"event_type":"decision_rejected","payload":{"assessment_id":"A1"}}]'));
select is((select (result->>'active_thesis_version')::integer from v07_test_results where label='rejected'), 1, 'Reject appends a decision without a fake Standing version');
insert into v07_test_results values ('unchanged', public.v07_commit_workspace(
    '11111111-1111-4111-8111-111111111111','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',3,1,
    'unchanged-a',repeat('e',64),current_setting('v07.test_initial')::jsonb,
    '[{"event_type":"decision_accepted","payload":{"text_changed":false}}]'));
select is((select (result->>'active_thesis_version')::integer from v07_test_results where label='unchanged'), 1, 'unchanged Accept creates no fake Standing version');
insert into v07_test_results values ('changed', public.v07_commit_workspace(
    '11111111-1111-4111-8111-111111111111','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',4,1,
    'changed-a',repeat('f',64),current_setting('v07.test_changed')::jsonb,
    '[{"event_type":"decision_accepted","payload":{"text_changed":true}},{"event_type":"thesis_revised","payload":{"version":2}}]'));
select is((select (result->>'active_thesis_version')::integer from v07_test_results where label='changed'), 2, 'changed Accept advances exactly one Standing version');
select is(public.v07_commit_workspace(
    '11111111-1111-4111-8111-111111111111','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',4,1,
    'changed-a',repeat('f',64),current_setting('v07.test_changed')::jsonb,
    '[{"event_type":"decision_accepted","payload":{}}]'),
    (select result from v07_test_results where label='changed'), 'duplicate decision returns original result');
select is((select revision from public.workspaces where id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'), 5, 'duplicate decision advances neither revision nor Standing again');
select is((select count(*)::integer from public.workspace_events where workspace_id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' and event_type='thesis_revised'), 1, 'duplicate decision appends no second thesis revision event');
select throws_ok($$select public.v07_commit_workspace(
    '11111111-1111-4111-8111-111111111111','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',5,2,
    'fake-version',repeat('a',64),jsonb_set(current_setting('v07.test_changed')::jsonb,'{standing,version}','3'),
    '[{"event_type":"thesis_revised","payload":{}}]')$$, 'PT400', 'invalid_thesis_version_transition', 'SQL rejects version increment without text change');
select throws_ok($$select public.v07_commit_workspace(
    '11111111-1111-4111-8111-111111111111','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',5,2,
    'unversioned-text',repeat('a',64),jsonb_set(current_setting('v07.test_changed')::jsonb,'{standing,statement}','"Different statement without a version."'),
    '[{"event_type":"thesis_revised","payload":{}}]')$$, 'PT400', 'invalid_thesis_version_transition', 'SQL rejects text change without version increment');
select throws_ok($$select public.v07_commit_workspace(
    '11111111-1111-4111-8111-111111111111','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',5,2,
    'ticker-change',repeat('a',64),jsonb_set(current_setting('v07.test_changed')::jsonb,'{standing,ticker}','"MSFT"'),
    '[{"event_type":"thesis_revised","payload":{}}]')$$, 'PT400', 'workspace_ticker_changed', 'workspace ticker cannot silently change');
select throws_ok($$select public.v07_commit_workspace(
    '11111111-1111-4111-8111-111111111111','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',5,2,
    'wrong-state-id',repeat('a',64),jsonb_set(current_setting('v07.test_changed')::jsonb,'{id}','"cccccccc-cccc-4ccc-8ccc-cccccccccccc"'),
    '[{"event_type":"decision_rejected","payload":{}}]')$$, 'PT400', 'workspace_state_identity_mismatch', 'commit cannot substitute another workspace identity');
select throws_ok($$select public.v07_commit_workspace(
    '11111111-1111-4111-8111-111111111111','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',5,2,
    'invalid-event',repeat('a',64),current_setting('v07.test_changed')::jsonb,
    '[{"event_type":"unknown","payload":{}}]')$$, 'PT400', 'invalid_workspace_events', 'unknown event is rejected');
select throws_ok($$select public.v07_commit_workspace(
    '11111111-1111-4111-8111-111111111111','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',5,2,
    'missing-payload',repeat('a',64),current_setting('v07.test_changed')::jsonb,
    '[{"event_type":"decision_rejected"}]')$$, 'PT400', 'invalid_workspace_events', 'missing event payload is rejected');

-- Force an error during event append, after the UPDATE inside the command. The
-- calling statement must roll back state, sequence, and retry receipt together.
reset role;
create function pg_temp.v07_abort_event() returns trigger language plpgsql as $$
begin
    if new.payload ? 'abort_after_update' then raise exception 'injected_event_failure'; end if;
    return new;
end;
$$;
create trigger v07_test_abort_event before insert on public.workspace_events
    for each row execute function pg_temp.v07_abort_event();
set local role service_role;
select throws_ok($$select public.v07_commit_workspace(
    '11111111-1111-4111-8111-111111111111','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',5,2,
    'atomic-abort',repeat('a',64),current_setting('v07.test_changed')::jsonb,
    '[{"event_type":"decision_kept_unresolved","payload":{"abort_after_update":true}}]')$$,
    'P0001', 'injected_event_failure', 'event append failure aborts an otherwise valid command');
select is((select revision from public.workspaces where id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'), 5, 'event insertion failure rolls back materialized state update');
select is((select count(*)::integer from public.workspace_events where workspace_id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'), 7, 'event insertion failure leaves audit count intact');
select is(public.v07_mutation_result('11111111-1111-4111-8111-111111111111','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','atomic-abort',repeat('a',64)), null::jsonb, 'failed command cannot leave a successful retry receipt');

insert into v07_test_results values ('imported', public.v07_create_workspace(
    '11111111-1111-4111-8111-111111111111','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','MSFT',
    'import-a',repeat('b',64),current_setting('v07.test_import')::jsonb,
    '[{"event_type":"session_imported","payload":{"local_id":"local-msft"}}]','local-msft'));
select is((select (result->>'active_thesis_version')::integer from v07_test_results where label='imported'), 3, 'import retains existing Standing version without fabricating earlier versions');
insert into v07_test_results values ('import-newer', public.v07_commit_workspace(
    '11111111-1111-4111-8111-111111111111','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',1,3,
    'import-edit',repeat('c',64),current_setting('v07.test_import_changed')::jsonb,
    '[{"event_type":"decision_edited","payload":{}},{"event_type":"thesis_revised","payload":{"version":4}}]'));
select is(public.v07_create_workspace(
    '11111111-1111-4111-8111-111111111111','dddddddd-dddd-4ddd-8ddd-dddddddddddd','MSFT',
    'import-different-retry-key',repeat('b',64),jsonb_set(current_setting('v07.test_import')::jsonb,'{id}','"dddddddd-dddd-4ddd-8ddd-dddddddddddd"'),
    '[{"event_type":"session_imported","payload":{"local_id":"local-msft"}}]','local-msft'),
    (select result from v07_test_results where label='import-newer'), 'repeated import under a different retry key returns newer canonical state');
select throws_ok($$select public.v07_create_workspace(
    '11111111-1111-4111-8111-111111111111','dddddddd-dddd-4ddd-8ddd-dddddddddddd','MSFT',
    'different-import-snapshot',repeat('d',64),jsonb_set(current_setting('v07.test_import_changed')::jsonb,'{id}','"dddddddd-dddd-4ddd-8ddd-dddddddddddd"'),
    '[{"event_type":"session_imported","payload":{}}]','local-msft')$$,
    'PT409', 'import_snapshot_conflict', 'same local identity with different snapshot cannot replace server state');
select is((select count(*)::integer from public.workspaces), 2, 'import retries preserve a single server copy');
select is((select current_state from public.workspaces where id='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'), current_setting('v07.test_import_changed')::jsonb, 'repeated import does not overwrite newer state');
select is((select count(*)::integer from public.workspace_events where workspace_id='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' and event_type='session_imported'), 1, 'import audit event is appended exactly once');

insert into v07_test_results values ('archived', public.v07_commit_workspace(
    '11111111-1111-4111-8111-111111111111','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',5,2,
    'archive-a',repeat('e',64),current_setting('v07.test_changed')::jsonb,
    '[{"event_type":"workspace_archived","payload":{}}]'));
select ok((select result->>'archived_at' is not null from v07_test_results where label='archived'), 'archive command materializes archived_at');
select is(public.v07_commit_workspace(
    '11111111-1111-4111-8111-111111111111','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',5,2,
    'archive-a',repeat('e',64),null,null), (select result from v07_test_results where label='archived'), 'archive retry returns committed result');
select throws_ok($$select public.v07_commit_workspace(
    '11111111-1111-4111-8111-111111111111','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',6,2,
    'after-archive',repeat('f',64),current_setting('v07.test_changed')::jsonb,
    '[{"event_type":"assessment_created","payload":{}}]')$$,
    'PT409', 'workspace_archived', 'archived workspace rejects new mutations');
select is((select count(*)::integer from private.workspace_mutations), 8, 'one immutable outcome per successful command even with multi-event commands');
select is((select active_thesis_version from public.workspaces where id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'), 2, 'archive produces no new Standing version');
select is((select revision from public.workspaces where id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'), 6, 'archive advances one workspace revision');

select * from finish();
rollback;
