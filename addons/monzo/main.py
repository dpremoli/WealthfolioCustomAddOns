import os
import secrets
from datetime import datetime, timedelta, timezone
from typing import Optional
from urllib.parse import urlencode

import httpx
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse
from pydantic import BaseModel

load_dotenv()

app = FastAPI(
    title="Monzo Proxy",
    description="Backend proxy for Monzo API OAuth and authenticated requests",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

MONZO_AUTH_BASE = "https://auth.monzo.com/"
MONZO_TOKEN_URL = "https://api.monzo.com/oauth2/token"
MONZO_API_BASE = "https://api.monzo.com"

CLIENT_ID = os.getenv("MONZO_CLIENT_ID", "")
CLIENT_SECRET = os.getenv("MONZO_CLIENT_SECRET", "")
REDIRECT_URI = os.getenv("REDIRECT_URI", "http://localhost:8000/callback")

# Short-lived in-memory store keyed by state; cleared on first retrieval.
# Tokens live here only until the addon polls and stores them in the OS keyring.
pending_tokens: dict[str, dict] = {}


def _extract_bearer(request: Request) -> str:
    auth = request.headers.get("Authorization", "")
    if not auth.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Missing or invalid Authorization header")
    return auth[7:]


def _add_expires_at(token_data: dict) -> dict:
    expires_in = token_data.get("expires_in", 21600)
    token_data["expires_at"] = int(
        (datetime.now(timezone.utc) + timedelta(seconds=expires_in)).timestamp() * 1000
    )
    return token_data


def _html_page(title: str, message: str, success: bool = True) -> HTMLResponse:
    color = "#16a34a" if success else "#dc2626"
    icon = "&#10003;" if success else "&#10007;"
    return HTMLResponse(
        content=(
            f"<html><body style='font-family:sans-serif;text-align:center;padding:40px'>"
            f"<h2 style='color:{color}'>{icon} {title}</h2>"
            f"<p>{message}</p>"
            f"</body></html>"
        )
    )


@app.get("/health")
async def health():
    return {"status": "ok"}


@app.get("/auth")
async def get_auth_url():
    state = secrets.token_urlsafe(32)
    params = {
        "client_id": CLIENT_ID,
        "redirect_uri": REDIRECT_URI,
        "response_type": "code",
        "state": state,
    }
    url = f"{MONZO_AUTH_BASE}?{urlencode(params)}"
    return {"url": url, "state": state}


@app.get("/callback")
async def oauth_callback(
    request: Request,
    code: Optional[str] = None,
    state: Optional[str] = None,
    error: Optional[str] = None,
    error_description: Optional[str] = None,
):
    # Monzo sends ?error=... when auth fails or is denied
    if error or not code or not state:
        reason = error_description or error or "Authentication was cancelled or failed."
        return _html_page("Authentication Failed", reason, success=False)

    async with httpx.AsyncClient() as client:
        resp = await client.post(
            MONZO_TOKEN_URL,
            data={
                "grant_type": "authorization_code",
                "client_id": CLIENT_ID,
                "client_secret": CLIENT_SECRET,
                "redirect_uri": REDIRECT_URI,
                "code": code,
            },
        )
    if resp.status_code != 200:
        return _html_page(
            "Authentication Failed",
            f"Token exchange failed: {resp.text}",
            success=False,
        )

    pending_tokens[state] = _add_expires_at(resp.json())

    return _html_page(
        "Authentication successful!",
        "You can close this window and return to Wealthfolio.",
    )


@app.get("/token-status")
async def token_status(state: str):
    tokens = pending_tokens.pop(state, None)
    if tokens is None:
        return {"ready": False}
    return {"ready": True, "tokens": tokens}


class RefreshRequest(BaseModel):
    refresh_token: str


@app.post("/refresh")
async def refresh_token(body: RefreshRequest):
    async with httpx.AsyncClient() as client:
        resp = await client.post(
            MONZO_TOKEN_URL,
            data={
                "grant_type": "refresh_token",
                "client_id": CLIENT_ID,
                "client_secret": CLIENT_SECRET,
                "refresh_token": body.refresh_token,
            },
        )
    if resp.status_code != 200:
        raise HTTPException(status_code=401, detail=f"Token refresh failed: {resp.text}")
    return _add_expires_at(resp.json())


@app.get("/accounts")
async def get_accounts(request: Request, account_type: Optional[str] = None):
    access_token = _extract_bearer(request)
    params: dict = {}
    if account_type:
        params["account_type"] = account_type

    async with httpx.AsyncClient() as client:
        resp = await client.get(
            f"{MONZO_API_BASE}/accounts",
            params=params,
            headers={"Authorization": f"Bearer {access_token}"},
        )

    if resp.status_code == 401:
        raise HTTPException(status_code=401, detail="Monzo token is invalid or expired")
    if not resp.is_success:
        raise HTTPException(status_code=resp.status_code, detail=resp.text)
    return resp.json()


@app.get("/transactions")
async def get_transactions(
    request: Request,
    account_id: str,
    since: Optional[str] = None,
    before: Optional[str] = None,
):
    access_token = _extract_bearer(request)
    params: dict = {"account_id": account_id}
    if since:
        params["since"] = since
    if before:
        params["before"] = before

    async with httpx.AsyncClient() as client:
        resp = await client.get(
            f"{MONZO_API_BASE}/transactions",
            params=params,
            headers={"Authorization": f"Bearer {access_token}"},
        )

    if resp.status_code == 401:
        raise HTTPException(status_code=401, detail="Monzo token is invalid or expired")
    if not resp.is_success:
        raise HTTPException(status_code=resp.status_code, detail=resp.text)
    return resp.json()
