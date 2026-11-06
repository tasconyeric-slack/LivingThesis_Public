import { validStanding, findByTicker } from "./session.js";

// Server artifacts and transient UI state have separate ownership.
export function hydrateWorkspace(wrapper, previous = {}) {
  if (
    !wrapper || typeof wrapper.id !== "string" ||
    !Number.isInteger(wrapper.revision) || wrapper.revision < 1 ||
    !validStanding(wrapper.current_state?.standing) ||
    wrapper.active_thesis_version !== wrapper.current_state.standing.version ||
    !["versions", "evidence", "assessments", "decisions", "history"].every(
      (key) => Array.isArray(wrapper.current_state[key]),
    )
  ) throw new Error("invalid_cloud_state");
  return {
    ...structuredClone(wrapper.current_state),
    id: wrapper.id,
    createdAt: wrapper.created_at,
    updatedAt: wrapper.updated_at,
    draft: structuredClone(previous.draft || {}),
    action: previous.action ?? (wrapper.current_state.pendingId ? "review" : null),
    error: wrapper.current_state.pendingId && wrapper.current_state.pendingId === previous.staleAssessmentId ? "stale_assessment" : "",
    staleAssessmentId: wrapper.current_state.pendingId === previous.staleAssessmentId ? previous.staleAssessmentId : null,
    cloudRevision: wrapper.revision,
    cloudArchived: wrapper.archived_at,
  };
}

export function newestWorkspace(wrapper, previous = {}) {
  // Idempotency returns the original outcome, which can predate a later load.
  // Keep that acknowledgement from regressing the known materialized state.
  return previous.cloudRevision > wrapper.revision ? previous : hydrateWorkspace(wrapper, previous);
}

export function importCandidates(state, imported = {}) {
  return state.workspaces.filter(
    (item) => item.mode === "custom" && !imported[item.id] &&
      typeof item.authored === "string" && ["en", "zh"].includes(item.language),
  );
}

// One workspace per ticker: a local thesis cannot be imported next to the
// account's existing workspace for the same company.
export const importConflict = (item, accountWorkspaces) =>
  !!findByTicker(accountWorkspaces, item.standing.ticker);

// Same logical retry gets the same key; a changed request gets a different key.
export class MutationKeys {
  constructor(uuid = () => crypto.randomUUID()) {
    this.uuid = uuid;
    this.keys = new Map();
  }
  key(scope, payload) {
    const fingerprint = JSON.stringify(payload);
    const previous = this.keys.get(scope);
    if (previous?.fingerprint === fingerprint) return previous.key;
    const key = this.uuid();
    this.keys.set(scope, { fingerprint, key });
    return key;
  }
  // True while this exact request is an unfinished command being retried.
  retrying(scope, payload) {
    return this.keys.get(scope)?.fingerprint === JSON.stringify(payload);
  }
  complete(scope) { this.keys.delete(scope); }
  clear() { this.keys.clear(); }
  snapshot() { return [...this.keys]; }
  restore(entries) {
    this.keys = new Map(Array.isArray(entries) ? entries.filter(
      (item) => Array.isArray(item) && typeof item[0] === "string" &&
        typeof item[1]?.fingerprint === "string" && typeof item[1]?.key === "string",
    ) : []);
  }
}

export async function connectCloud(onAuth, {
  fetcher = fetch,
  loadSdk = () => import("./supabase.js"),
  origin = location.origin,
} = {}) {
  const response = await fetcher("/api/auth/config", { cache: "no-store" });
  if (!response.ok) return null;
  const config = await response.json();
  if (!config.available) return null;
  const { createClient } = await loadSdk();
  const client = createClient(config.supabase_url, config.publishable_key, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
  });
  client.auth.onAuthStateChange((_event, session) => {
    // Avoid async work inside the SDK's auth storage lock.
    queueMicrotask(() => onAuth(session));
  });
  const initial = await client.auth.getSession();
  if (initial.error) throw new Error("auth_unavailable");
  onAuth(initial.data.session);
  return {
    client,
    async send(email) {
      const result = await client.auth.signInWithOtp({
        email,
        options: { emailRedirectTo: new URL("/", origin).href },
      });
      if (result.error) throw new Error("auth_failed");
    },
    async verify(email, token) {
      const result = await client.auth.verifyOtp({ email, token, type: "email" });
      if (result.error) throw new Error("auth_failed");
    },
    async signOut() {
      const result = await client.auth.signOut();
      if (result.error) throw new Error("auth_failed");
    },
    async request(path, body) {
      const { data, error } = await client.auth.getSession();
      if (error || !data.session) throw new Error("auth_required");
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 55000);
      try {
        const reply = await fetcher(path, {
          method: body === undefined ? "GET" : "POST",
          cache: "no-store",
          headers: {
            Authorization: `Bearer ${data.session.access_token}`,
            ...(body === undefined ? {} : { "Content-Type": "application/json" }),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          signal: controller.signal,
        });
        const value = await reply.json().catch(() => ({}));
        if (!reply.ok) {
          const failure = new Error(value.error?.code || "cloud_unavailable");
          failure.status = reply.status;
          throw failure;
        }
        return value;
      } catch (error) {
        if (error.name === "AbortError") throw new Error("model_timeout");
        if (error instanceof TypeError) throw new Error("network");
        throw error;
      } finally { clearTimeout(timeout); }
    },
  };
}
