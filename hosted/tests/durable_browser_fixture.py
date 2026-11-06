"""Local deterministic durable/Auth fixture. Excluded from deployed functions."""
import os
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from hosted.tests.browser_fixture import app
from hosted.tests.durable_fixture import MemoryRepository
from hosted import durable_api
from hosted import durable_repository
from hosted import check_service
from hosted.tests import check_fixture
from contextlib import asynccontextmanager

os.environ["SUPABASE_URL"] = "https://fixture.supabase.invalid"
os.environ["SUPABASE_PUBLISHABLE_KEY"] = "fixture-publishable"
os.environ["SUPABASE_SECRET_KEY"] = "fixture-only-never-production"
repo = MemoryRepository()
# SYNTHETIC SEC filings and scripted model outputs for Check for Updates (never real evidence).
check_runtime = check_fixture.runtime(transport=check_fixture.Transport(assessment=check_fixture.REVISE))
check_service.runtime = lambda: check_runtime


async def fixture_repository():
    yield repo


async def fixture_config():
    return {"available": True, "supabase_url": os.environ["SUPABASE_URL"],
            "publishable_key": os.environ["SUPABASE_PUBLISHABLE_KEY"]}


app.dependency_overrides[durable_api.repository] = fixture_repository
@asynccontextmanager
async def open_fixture_repository():
    yield repo
durable_repository.open_repository = open_fixture_repository

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="127.0.0.1", port=int(sys.argv[1]))
