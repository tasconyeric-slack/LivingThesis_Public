# Living Investment Thesis

A bilingual (English/中文) application for recording an investment thesis, tracking its drivers and falsifiers, assessing evidence, and making explicit human decisions. It includes a public NVIDIA baseline and historical replay, a separate synthetic demo, and optional authenticated, durable workspaces.

**Live demo:** https://livingthesis.byliyz.com/ — the existing site is deployed from a separate private source repository, not from this snapshot. This repository is an independent code release and is not an investment recommendation.

## Run locally

Requires Node.js and npm, Python 3.11+, and Git. From the repository root:

```sh
npm ci
npm run build
python -m venv .venv
. .venv/bin/activate  # Windows: .venv\Scripts\activate
python -m pip install -r requirements.txt
python -m hosted.dev
```

Open http://127.0.0.1:3000. The public baseline, replay, and synthetic demo work without credentials. Anonymous workspace state lives in the browser session. Custom thesis structuring and evidence assessment require a server-side `DEEPSEEK_API_KEY`; they make model calls and may incur charges. Assessment does not automatically change a thesis: a human decision is required. Never put server keys in browser code or commit them.

## Durable workspaces and deployment

The browser UI in `hosted/public` talks to the FastAPI application in `api/` and `hosted/`; backend prompts and the NVIDIA evidence-check code live in `backend/`. `supabase/migrations` contains the database schema and access policies; `supabase/tests` contains database tests. For an independent deployment, provision your own Supabase project, configure its authentication and apply the migrations. Set `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, and server-only `SUPABASE_SECRET_KEY` in your deployment environment. Add only your own Supabase origin to the `connect-src` directive in `vercel.json` before deploying. The build's cloud preflight checks the configured schema; production builds require complete configuration. Never connect this release to an existing production project without separately deciding to do so.

The NVIDIA update check uses SEC/EDGAR data and a model service where configured. Set an appropriate `SEC_USER_AGENT` for SEC requests. External services, email authentication and model calls require separately configured accounts and may have their own terms. Local tests use fixtures and make no paid model calls.

## Data and limitations

The NVIDIA baseline contains research hypotheses, source citations, monitoring gaps and recorded approval metadata. Its content hash can be checked against the shipped content; the private approval ledger is not included, so the original approval cannot be independently verified from this snapshot alone. Historical Replay is a recorded, read-only public projection of primary-source runs, not a synthetic performance result; the separately labelled historical scenario is not the owner's thesis. Source records and internal review files are omitted. The synthetic demo is clearly labelled and is not historical evidence. No screenshots, proprietary vendor data or private research exports are included. Historical data may be stale and model outputs may be wrong; verify sources independently.

## Tests

```sh
npm test
python -m pip install pytest
python -m pytest -q hosted/tests/test_hosted_api.py hosted/tests/test_durable_api.py hosted/tests/test_durable_domain.py hosted/tests/test_check_for_updates.py hosted/tests/test_evidence_check_hosted.py hosted/tests/test_baseline_provenance.py
```

These cover the public UI, baseline, anonymous demo, API and simulated authentication/ownership and check flows. Tests that compared against private approval records or internal exports are excluded or narrowed to shipped artifacts; their original provenance assertions cannot be reproduced here. The older standalone backend research tooling and its private fixtures are not included.

No license grant is asserted for this snapshot; check third-party terms before reuse. No production credentials or databases are included.
