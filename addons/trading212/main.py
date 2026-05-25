"""Stateless proxy for the Trading 212 public API.

The add-on holds the API credentials (in Wealthfolio's OS keyring) and sends them
on every request via the ``Authorization`` header. This proxy only exists to bypass
the browser CORS restriction that prevents the Wealthfolio add-on from calling
``*.trading212.com`` directly. It stores no credentials and keeps no state.

The upstream environment (live / demo) is chosen from a fixed allow-list via the
``env`` query parameter, so a caller can never point the proxy at an arbitrary host.
"""

import os
from typing import Optional

import httpx
from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

app = FastAPI(
    title="Trading 212 Proxy",
    description="Stateless CORS proxy for the Trading 212 public API",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
    # Without this the browser cannot read the rate-limit headers, so the
    # add-on can't honor x-ratelimit-reset and backs off too little on 429.
    expose_headers=[
        "x-ratelimit-limit",
        "x-ratelimit-remaining",
        "x-ratelimit-reset",
        "x-ratelimit-period",
        "x-ratelimit-used",
        "retry-after",
    ],
)

# env -> upstream base URL. Fixed allow-list prevents SSRF.
BASE_URLS = {
    "live": "https://live.trading212.com",
    "demo": "https://demo.trading212.com",
}

API_PREFIX = "/api/v0/equity"

# Path suffix exposed by this proxy -> upstream path under API_PREFIX.
ENDPOINTS = {
    "account/summary": "/account/summary",
    "positions": "/positions",
    "instruments": "/metadata/instruments",
    "orders": "/history/orders",
    "dividends": "/history/dividends",
    "transactions": "/history/transactions",
}

# Rate-limit headers worth surfacing back to the add-on for client-side backoff.
RATE_LIMIT_HEADERS = (
    "x-ratelimit-limit",
    "x-ratelimit-remaining",
    "x-ratelimit-reset",
    "x-ratelimit-period",
    "x-ratelimit-used",
    "retry-after",
)

# Request-timeout (seconds). The instruments payload is large (~5 MB).
TIMEOUT = httpx.Timeout(60.0)


def _auth_header(request: Request) -> str:
    auth = request.headers.get("Authorization", "")
    if not auth:
        raise HTTPException(status_code=401, detail="Missing Authorization header")
    return auth


def _base_url(env: Optional[str]) -> str:
    key = (env or "live").lower()
    if key not in BASE_URLS:
        raise HTTPException(status_code=400, detail=f"Unknown env '{env}'")
    return BASE_URLS[key]


async def _proxy(request: Request, suffix: str) -> JSONResponse:
    upstream = f"{_base_url(request.query_params.get('env'))}{API_PREFIX}{ENDPOINTS[suffix]}"

    # Forward all query params except our own routing param.
    params = {k: v for k, v in request.query_params.items() if k != "env"}

    async with httpx.AsyncClient(timeout=TIMEOUT) as client:
        resp = await client.get(
            upstream,
            params=params,
            headers={"Authorization": _auth_header(request)},
        )

    passthrough = {
        h: resp.headers[h] for h in RATE_LIMIT_HEADERS if h in resp.headers
    }

    if resp.status_code == 401:
        raise HTTPException(status_code=401, detail="Trading 212 rejected the API key")
    if resp.status_code == 429:
        return JSONResponse(
            status_code=429,
            content={"detail": "Trading 212 rate limit hit"},
            headers=passthrough,
        )
    if not resp.is_success:
        raise HTTPException(status_code=resp.status_code, detail=resp.text)

    return JSONResponse(content=resp.json(), headers=passthrough)


@app.get("/health")
async def health():
    return {"status": "ok"}


@app.get("/account/summary")
async def account_summary(request: Request):
    return await _proxy(request, "account/summary")


@app.get("/positions")
async def positions(request: Request):
    return await _proxy(request, "positions")


@app.get("/instruments")
async def instruments(request: Request):
    return await _proxy(request, "instruments")


@app.get("/orders")
async def orders(request: Request):
    return await _proxy(request, "orders")


@app.get("/dividends")
async def dividends(request: Request):
    return await _proxy(request, "dividends")


@app.get("/transactions")
async def transactions(request: Request):
    return await _proxy(request, "transactions")


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=int(os.getenv("PORT", "8000")))
