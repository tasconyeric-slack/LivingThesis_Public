"""Vercel ASGI entrypoint. No ArtifactStore, provider collection, or local server."""
import asyncio
import os
from pathlib import Path
from typing import Literal

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse, FileResponse
from starlette.exceptions import HTTPException
from starlette.staticfiles import StaticFiles

from hosted.models import DefineRequest, AssessRequest, DecisionRequest
from hosted import service
from hosted.durable_api import router as durable_router
from backend.src.living_thesis.mvp_models import StrictModel

app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)
app.include_router(durable_router)
PUBLIC = Path(__file__).resolve().parents[1] / "hosted/public"


def error(code, message, status):
    return JSONResponse({"error": {"code": code, "message": message}}, status_code=status,
                        headers={"Cache-Control": "no-store"})


@app.middleware("http")
async def product_boundary(request: Request, call_next):
    try:
        if request.method == "POST":
            # Bound actual bytes, including requests with no Content-Length.
            body = await request.body()
            if len(body) > 96000:
                return error("input_too_large", "This evidence is too long. Paste a shorter source excerpt.", 413)
        response = await call_next(request)
        if request.url.path.startswith("/api"):
            response.headers["Cache-Control"] = "no-store"
        response.headers["X-Content-Type-Options"] = "nosniff"
        return response
    except Exception:
        return error("service_error", "Something went wrong. Your thesis is unchanged; please try again.", 500)


@app.exception_handler(service.ProductError)
async def product_error(request, exc):
    return error(exc.code, exc.message, exc.status)


@app.exception_handler(RequestValidationError)
async def invalid_input(request, exc):
    return error("invalid_input", "Check your ticker, thesis and evidence fields, then try again.", 422)


@app.exception_handler(HTTPException)
async def route_error(request, exc):
    return error("route_unavailable", "This action is not available.", exc.status_code)


@app.get("/api/health")
async def health():
    return {"ok": True, "mode": "hosted_product", "demo_available": True,
            "custom_available": bool(os.environ.get("DEEPSEEK_API_KEY", "").strip())}


@app.post("/api/thesis")
async def define(request: DefineRequest):
    return await service.define(request)


@app.post("/api/evidence")
async def assess(request: AssessRequest):
    return await service.assess(request)


@app.post("/api/decision")
async def decide(request: DecisionRequest):
    return service.decide(request)


class EvidenceCheckStage(StrictModel):
    stage: Literal["triage", "assess"]
    context: dict


CHECK_ERRORS = {"stale_standing": 422, "invalid_scope": 422, "invalid_stage": 422, "model_timeout": 504,
                "provider_unavailable": 502, "invalid_model_output": 502, "model_unavailable": 503}

def _route_token_verifier() -> str | None:
    """Preview inference is closed unless a token verifier is explicitly configured.

    Configure EVIDENCE_CHECK_TOKEN_SHA256 in Preview only; unset/disabled means fail closed.
    There is no committed fallback credential or verifier.
    """
    configured = os.environ.get("EVIDENCE_CHECK_TOKEN_SHA256", "").strip().lower()
    return configured if configured and configured != "disabled" else None


@app.post("/api/evidence-check/model")
async def evidence_check_model(request: Request):
    """One model stage of the evidence check, built from the approved Standing by the shared core.

    Preview (or explicit local opt-in) only: Production keeps this route closed until the check is
    connected to the authenticated workspace. Within Preview, a bearer token is required and checked
    before the body is parsed. Thesis text comes from the committed Standings; the caller supplies only
    typed, bounded event and research context, which the prompt treats as data.
    """
    environment = os.environ.get("VERCEL_ENV", "")
    # Allow-list: Preview deployments, or an explicit local opt-in. Production is always closed.
    if environment == "production" or not (environment == "preview" or os.environ.get("EVIDENCE_CHECK_MODEL_ROUTE") == "enabled"):
        raise service.ProductError("route_unavailable", "This action is not available.", 404)
    try:
        # Imported on use: the product API must boot even if the check module cannot load.
        from backend.src.living_thesis import evidence_check
    except Exception as exc:
        detail = getattr(exc, "name", None) or type(exc).__name__
        raise service.ProductError("evidence_check_unavailable", f"The evidence check is unavailable ({detail}).", 503) from None
    if not evidence_check.route_token_valid(request.headers.get("authorization"), _route_token_verifier()):
        response = error("unauthorized", "This action requires Preview access.", 401)
        response.headers["WWW-Authenticate"] = "Bearer"
        return response
    try:
        body = EvidenceCheckStage.model_validate_json(await request.body())
    except ValueError:
        raise service.ProductError("invalid_input", "The evidence check context is invalid.", 422) from None
    key = service.api_key()
    try:
        return await asyncio.to_thread(evidence_check.run_model_stage_server, body.stage, body.context, key)
    except evidence_check.CheckError as exc:
        raise service.ProductError(exc.code, "The evidence check stage could not run.", CHECK_ERRORS.get(exc.code, 502)) from None
    except ValueError:  # pydantic validation of the stage context
        raise service.ProductError("invalid_input", "The evidence check context is invalid.", 422) from None


@app.get("/")
async def home():
    return FileResponse(PUBLIC / "index.html")


# Local development only; Vercel's CDN serves this directory in hosted mode.
if (PUBLIC / "assets").is_dir():
    app.mount("/assets", StaticFiles(directory=PUBLIC / "assets"), name="assets")
