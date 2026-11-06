-- v0.7: Auth owns identity; the hosted Python service owns domain validation.
-- Apply to the provisioned Preview database before deploying v0.7 API code.
begin;

create schema if not exists private;
revoke all on schema private from public, anon, authenticated;
grant usage on schema private to service_role;

create table public.workspaces (
    id uuid primary key,
    user_id uuid not null references auth.users(id),
    ticker text not null check (char_length(ticker) between 1 and 12),
    schema_version integer not null default 1 check (schema_version = 1),
    revision integer not null default 1 check (revision >= 1),
    active_thesis_version integer not null check (active_thesis_version between 1 and 10000),
    current_state jsonb not null check (jsonb_typeof(current_state) = 'object'
        and octet_length(current_state::text) <= 4194304),
    create_key text not null check (char_length(create_key) between 1 and 128),
    create_digest text not null check (create_digest ~ '^[0-9a-f]{64}$'),
    import_key text check (char_length(import_key) between 1 and 128),
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    archived_at timestamptz,
    unique (user_id, create_key),
    unique (user_id, import_key)
);
create index workspaces_owner_updated_idx on public.workspaces(user_id, updated_at desc);

create table public.workspace_events (
    id uuid primary key default gen_random_uuid(),
    workspace_id uuid not null references public.workspaces(id),
    sequence bigint not null check (sequence >= 1),
    event_type text not null check (event_type in (
        'workspace_created', 'session_imported', 'evidence_added', 'assessment_created',
        'decision_accepted', 'decision_edited', 'decision_rejected',
        'decision_kept_unresolved', 'thesis_revised', 'workspace_archived'
    )),
    payload jsonb not null check (jsonb_typeof(payload) = 'object'),
    idempotency_key text not null check (char_length(idempotency_key) between 1 and 128),
    created_at timestamptz not null default now(),
    unique (workspace_id, sequence)
);
-- The sequence constraint already indexes workspace_id for ownership/history queries.

-- One command may append multiple domain events. Its retry outcome belongs in a
-- separate private table, not a uniqueness constraint on those individual events.
create table private.workspace_mutations (
    workspace_id uuid not null references public.workspaces(id),
    idempotency_key text not null check (char_length(idempotency_key) between 1 and 128),
    request_digest text not null check (request_digest ~ '^[0-9a-f]{64}$'),
    result jsonb not null check (jsonb_typeof(result) = 'object'),
    created_at timestamptz not null default now(),
    primary key (workspace_id, idempotency_key)
);

alter table public.workspaces enable row level security;
alter table public.workspace_events enable row level security;
alter table private.workspace_mutations enable row level security;
revoke all on public.workspaces, public.workspace_events, private.workspace_mutations
    from public, anon, authenticated, service_role;
grant select on public.workspaces, public.workspace_events to authenticated;
grant select, insert, update on public.workspaces to service_role;
grant select, insert on public.workspace_events, private.workspace_mutations to service_role;

create policy workspace_owner_read on public.workspaces
    for select to authenticated using ((select auth.uid()) = user_id);
create policy workspace_event_owner_read on public.workspace_events
    for select to authenticated using (exists (
        select 1 from public.workspaces as workspace
        where workspace.id = workspace_id and workspace.user_id = (select auth.uid())
    ));
-- No client DML policy or grant: owning a row does not authorize bypassing the
-- Python engine's explicit human decision validation. The private outcomes table
-- has no client grants or policies; RLS defaults to deny for ordinary roles.

create function private.v07_workspace_result(p_workspace public.workspaces)
returns jsonb language sql stable security invoker set search_path = '' as $$
    select jsonb_build_object(
        'id', p_workspace.id,
        'revision', p_workspace.revision,
        'active_thesis_version', p_workspace.active_thesis_version,
        'current_state', p_workspace.current_state,
        'created_at', p_workspace.created_at,
        'updated_at', p_workspace.updated_at,
        'archived_at', p_workspace.archived_at
    );
$$;

create function private.v07_validate_command(
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
                'decision_kept_unresolved', 'thesis_revised', 'workspace_archived'
            ) then
            raise sqlstate 'PT400' using message = 'invalid_workspace_events';
        end if;
    end loop;
    return v_version;
end;
$$;

create function public.v07_create_workspace(
    p_owner_id uuid, p_workspace_id uuid, p_ticker text,
    p_idempotency_key text, p_request_digest text,
    p_initial_state jsonb, p_events jsonb, p_import_key text default null
) returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
    v_workspace public.workspaces;
    v_version integer;
    v_result jsonb;
begin
    if p_owner_id is null or p_workspace_id is null then
        raise sqlstate 'PT400' using message = 'invalid_workspace_identity';
    end if;
    v_version := private.v07_validate_command(p_idempotency_key, p_request_digest, p_initial_state, p_events);
    if p_initial_state->>'id' is distinct from p_workspace_id::text then
        raise sqlstate 'PT400' using message = 'workspace_state_identity_mismatch';
    end if;
    if p_ticker is null or p_ticker is distinct from p_initial_state #>> '{standing,ticker}'
        or (p_import_key is not null and (char_length(p_import_key) not between 1 and 128 or btrim(p_import_key) = '')) then
        raise sqlstate 'PT400' using message = 'invalid_workspace_identity';
    end if;
    -- Serialize only this owner's inexpensive create/import operations. This also
    -- protects deduplication when two attempts use different retry keys.
    perform pg_advisory_xact_lock(hashtextextended(p_owner_id::text, 7));
    if p_import_key is not null then
        select * into v_workspace from public.workspaces
        where user_id = p_owner_id and import_key = p_import_key;
        if found then
            if v_workspace.create_digest <> p_request_digest then
                raise sqlstate 'PT409' using message = 'import_snapshot_conflict';
            end if;
            return private.v07_workspace_result(v_workspace);
        end if;
    end if;
    select * into v_workspace from public.workspaces
    where user_id = p_owner_id and create_key = p_idempotency_key;
    if found then
        if v_workspace.create_digest <> p_request_digest or v_workspace.import_key is distinct from p_import_key then
            raise sqlstate 'PT409' using message = 'idempotency_conflict';
        end if;
        select result into v_result from private.workspace_mutations
        where workspace_id = v_workspace.id and idempotency_key = p_idempotency_key;
        return v_result;
    end if;
    if exists (select 1 from public.workspaces where id = p_workspace_id) then
        raise sqlstate 'PT409' using message = 'workspace_identity_conflict';
    end if;
    begin
        insert into public.workspaces(id, user_id, ticker, active_thesis_version,
            current_state, create_key, create_digest, import_key)
        values (p_workspace_id, p_owner_id, p_ticker, v_version,
            p_initial_state, p_idempotency_key, p_request_digest, p_import_key)
        returning * into v_workspace;
    exception when unique_violation then
        raise sqlstate 'PT409' using message = 'workspace_identity_conflict';
    end;
    insert into public.workspace_events(workspace_id, sequence, event_type, payload, idempotency_key)
    select p_workspace_id, ordinal, event->>'event_type', event->'payload', p_idempotency_key
    from jsonb_array_elements(p_events) with ordinality as item(event, ordinal);
    v_result := private.v07_workspace_result(v_workspace);
    insert into private.workspace_mutations(workspace_id, idempotency_key, request_digest, result)
    values (p_workspace_id, p_idempotency_key, p_request_digest, v_result);
    return v_result;
end;
$$;

create function public.v07_mutation_result(
    p_owner_id uuid, p_workspace_id uuid, p_idempotency_key text, p_request_digest text
) returns jsonb language plpgsql stable security invoker set search_path = '' as $$
declare
    v_mutation private.workspace_mutations;
begin
    -- Do not disclose even a previously committed outcome to the wrong owner.
    if not exists (select 1 from public.workspaces where id = p_workspace_id and user_id = p_owner_id) then
        raise sqlstate 'PT404' using message = 'workspace_not_found';
    end if;
    select * into v_mutation from private.workspace_mutations
    where workspace_id = p_workspace_id and idempotency_key = p_idempotency_key;
    if not found then return null; end if;
    if v_mutation.request_digest is distinct from p_request_digest then
        raise sqlstate 'PT409' using message = 'idempotency_conflict';
    end if;
    return v_mutation.result;
end;
$$;

create function public.v07_commit_workspace(
    p_owner_id uuid, p_workspace_id uuid,
    p_expected_revision integer, p_expected_thesis_version integer,
    p_idempotency_key text, p_request_digest text, p_next_state jsonb, p_events jsonb
) returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
    v_workspace public.workspaces;
    v_mutation private.workspace_mutations;
    v_version integer;
    v_sequence bigint;
    v_archived_at timestamptz;
    v_result jsonb;
begin
    select * into v_workspace from public.workspaces
    where id = p_workspace_id and user_id = p_owner_id for update;
    if not found then
        raise sqlstate 'PT404' using message = 'workspace_not_found';
    end if;
    select * into v_mutation from private.workspace_mutations
    where workspace_id = p_workspace_id and idempotency_key = p_idempotency_key;
    if found then
        if v_mutation.request_digest is distinct from p_request_digest then
            raise sqlstate 'PT409' using message = 'idempotency_conflict';
        end if;
        return v_mutation.result;
    end if;
    if v_workspace.revision is distinct from p_expected_revision then
        raise sqlstate 'PT409' using message = 'stale_workspace_revision';
    end if;
    if v_workspace.active_thesis_version is distinct from p_expected_thesis_version then
        raise sqlstate 'PT409' using message = 'stale_thesis_version';
    end if;
    if v_workspace.archived_at is not null then
        raise sqlstate 'PT409' using message = 'workspace_archived';
    end if;
    v_version := private.v07_validate_command(p_idempotency_key, p_request_digest, p_next_state, p_events);
    if p_next_state->>'id' is distinct from p_workspace_id::text then
        raise sqlstate 'PT400' using message = 'workspace_state_identity_mismatch';
    end if;
    if p_next_state #>> '{standing,ticker}' is distinct from v_workspace.ticker then
        raise sqlstate 'PT400' using message = 'workspace_ticker_changed';
    end if;
    if v_version not in (v_workspace.active_thesis_version, v_workspace.active_thesis_version + 1)
        or ((p_next_state #>> '{standing,statement}' is distinct from v_workspace.current_state #>> '{standing,statement}')
            is distinct from (v_version = v_workspace.active_thesis_version + 1)) then
        raise sqlstate 'PT400' using message = 'invalid_thesis_version_transition';
    end if;
    select coalesce(max(sequence), 0) into v_sequence from public.workspace_events where workspace_id = p_workspace_id;
    v_archived_at := case when exists (
        select 1 from jsonb_array_elements(p_events) as item(event)
        where event->>'event_type' = 'workspace_archived'
    ) then now() else null end;
    update public.workspaces set current_state = p_next_state, revision = revision + 1,
        active_thesis_version = v_version, updated_at = now(), archived_at = v_archived_at
    where id = p_workspace_id and user_id = p_owner_id and revision = p_expected_revision
    returning * into v_workspace;
    if not found then
        raise sqlstate 'PT409' using message = 'stale_workspace_revision';
    end if;
    insert into public.workspace_events(workspace_id, sequence, event_type, payload, idempotency_key)
    select p_workspace_id, v_sequence + ordinal, event->>'event_type', event->'payload', p_idempotency_key
    from jsonb_array_elements(p_events) with ordinality as item(event, ordinal);
    v_result := private.v07_workspace_result(v_workspace);
    insert into private.workspace_mutations(workspace_id, idempotency_key, request_digest, result)
    values (p_workspace_id, p_idempotency_key, p_request_digest, v_result);
    return v_result;
end;
$$;

create function public.v07_schema_version() returns integer
language sql immutable security invoker set search_path = '' as $$ select 1; $$;

revoke all on function private.v07_workspace_result(public.workspaces),
    private.v07_validate_command(text, text, jsonb, jsonb),
    public.v07_create_workspace(uuid, uuid, text, text, text, jsonb, jsonb, text),
    public.v07_mutation_result(uuid, uuid, text, text),
    public.v07_commit_workspace(uuid, uuid, integer, integer, text, text, jsonb, jsonb),
    public.v07_schema_version() from public, anon, authenticated;
grant execute on function private.v07_workspace_result(public.workspaces),
    private.v07_validate_command(text, text, jsonb, jsonb),
    public.v07_create_workspace(uuid, uuid, text, text, text, jsonb, jsonb, text),
    public.v07_mutation_result(uuid, uuid, text, text),
    public.v07_commit_workspace(uuid, uuid, integer, integer, text, text, jsonb, jsonb),
    public.v07_schema_version() to service_role;

notify pgrst, 'reload schema';
commit;
