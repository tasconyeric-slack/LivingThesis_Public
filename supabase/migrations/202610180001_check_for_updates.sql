-- Issue #21: authenticated NVIDIA Check for Updates.
-- Check state lives in workspaces.current_state and is written only through
-- v07_commit_workspace (owner scope, revision CAS, idempotency). This migration
-- only allows the new append-only event types that carry Run Record parts and
-- adds a schema probe so the API fails closed until it is applied.
begin;

alter table public.workspace_events drop constraint workspace_events_event_type_check;
alter table public.workspace_events add constraint workspace_events_event_type_check check (event_type in (
    'workspace_created', 'session_imported', 'evidence_added', 'assessment_created',
    'decision_accepted', 'decision_edited', 'decision_rejected',
    'decision_kept_unresolved', 'thesis_revised', 'workspace_archived',
    'baseline_adopted', 'monitoring_confirmed', 'check_started', 'check_stage_recorded', 'check_completed'
));

create or replace function private.v07_validate_command(
    p_idempotency_key text, p_request_digest text, p_state jsonb, p_events jsonb
) returns integer language plpgsql security invoker set search_path = '' as $$
declare
    v_version integer;
    v_event jsonb;
begin
    if p_idempotency_key is null or char_length(p_idempotency_key) not between 1 and 128
        or btrim(p_idempotency_key) = '' or p_request_digest is null
        or p_request_digest !~ '^[0-9a-f]{64}$' then
        raise sqlstate 'PT400' using message = 'invalid_command_identity';
    end if;
    if p_state is null or jsonb_typeof(p_state) is distinct from 'object'
        or octet_length(p_state::text) > 4194304
        or jsonb_typeof(p_state->'standing') is distinct from 'object'
        or jsonb_typeof(p_state #> '{standing,version}') is distinct from 'number'
        or coalesce(p_state #>> '{standing,version}', '') !~ '^[1-9][0-9]{0,4}$'
        or jsonb_typeof(p_state #> '{standing,statement}') is distinct from 'string'
        or char_length(coalesce(p_state #>> '{standing,statement}', '')) not between 10 and 2000
        or jsonb_typeof(p_state #> '{standing,ticker}') is distinct from 'string'
        or char_length(coalesce(p_state #>> '{standing,ticker}', '')) not between 1 and 12 then
        raise sqlstate 'PT400' using message = 'invalid_workspace_state';
    end if;
    v_version := (p_state #>> '{standing,version}')::integer;
    if v_version > 10000 then
        raise sqlstate 'PT400' using message = 'invalid_thesis_version';
    end if;
    if p_events is null or jsonb_typeof(p_events) is distinct from 'array' then
        raise sqlstate 'PT400' using message = 'invalid_workspace_events';
    end if;
    if jsonb_array_length(p_events) not between 1 and 32
        or octet_length(p_events::text) > 1048576 then
        raise sqlstate 'PT400' using message = 'invalid_workspace_events';
    end if;
    for v_event in select value from jsonb_array_elements(p_events) loop
        if jsonb_typeof(v_event) is distinct from 'object'
            or jsonb_typeof(v_event->'payload') is distinct from 'object'
            or coalesce(v_event->>'event_type', '') not in (
                'workspace_created', 'session_imported', 'evidence_added', 'assessment_created',
                'decision_accepted', 'decision_edited', 'decision_rejected',
                'decision_kept_unresolved', 'thesis_revised', 'workspace_archived',
                'baseline_adopted', 'monitoring_confirmed', 'check_started', 'check_stage_recorded', 'check_completed'
            ) then
            raise sqlstate 'PT400' using message = 'invalid_workspace_events';
        end if;
    end loop;
    return v_version;
end;
$$;

create function public.v08_check_schema_version() returns integer
language sql immutable security invoker set search_path = '' as $$ select 1; $$;

revoke all on function public.v08_check_schema_version() from public, anon, authenticated;
grant execute on function public.v08_check_schema_version() to service_role;
-- create or replace keeps v07_validate_command's existing grants (service_role only).

notify pgrst, 'reload schema';
commit;
