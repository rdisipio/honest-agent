import os

import httpx
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from logprobs import attach_logprob_confidence
from nhl import fetch_game_details, fetch_team_stats

LLAMA_SERVER_URL = os.environ.get("LLAMA_SERVER_URL", "http://localhost:8080")
ALLOWED_ORIGIN = os.environ.get("ALLOWED_ORIGIN", "http://localhost:5173")

app = FastAPI()
app.add_middleware(
    CORSMiddleware,
    allow_origins=[ALLOWED_ORIGIN],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
async def health():
    try:
        async with httpx.AsyncClient(timeout=5) as client:
            res = await client.get(f"{LLAMA_SERVER_URL}/health")
        return {"backend": "ok", "llama_server": "ok" if res.status_code == 200 else "unreachable"}
    except httpx.HTTPError:
        return JSONResponse(status_code=503, content={"backend": "ok", "llama_server": "unreachable"})


@app.get("/nhl/game_details")
async def nhl_game_details(team1: str, team2: str, date: str):
    return await fetch_game_details(team1, team2, date)


@app.get("/nhl/team_stats")
async def nhl_team_stats(team: str):
    return await fetch_team_stats(team)


@app.post("/v1/chat/completions")
async def chat_completions(request: Request):
    body = await request.json()
    body["logprobs"] = True
    body["top_logprobs"] = 5

    try:
        async with httpx.AsyncClient(timeout=120) as client:
            res = await client.post(f"{LLAMA_SERVER_URL}/v1/chat/completions", json=body)
    except httpx.HTTPError as e:
        return JSONResponse(status_code=502, content={"error": f"llama-server unreachable: {e}"})

    if res.status_code != 200:
        return JSONResponse(status_code=res.status_code, content=res.json())

    return attach_logprob_confidence(res.json())
