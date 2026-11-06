// Deployment gate; credentials are passed only to the configured provider.
export async function verifyCloud(env = process.env, fetcher = fetch) {
  const configured = env.SUPABASE_URL || env.SUPABASE_SECRET_KEY || env.SUPABASE_PUBLISHABLE_KEY;
  if (!configured && env.VERCEL_ENV !== "production") return;
  if (!env.SUPABASE_URL || !env.SUPABASE_SECRET_KEY || !env.SUPABASE_PUBLISHABLE_KEY)
    throw new Error("Incomplete cloud configuration; provision the integration and schema before deployment.");
  let ready = false;
  try {
    const response = await fetcher(`${env.SUPABASE_URL.replace(/\/$/, "")}/rest/v1/rpc/v07_schema_version`, {
      method: "POST", signal: AbortSignal.timeout(15000),
      headers: { apikey: env.SUPABASE_SECRET_KEY, "Content-Type": "application/json" },
      body: "{}",
    });
    ready = response.ok && (await response.json()) === 1;
  } catch {}
  if (!ready) throw new Error("Durable schema v1 is not ready. Apply/test the migration before deployment.");
}
