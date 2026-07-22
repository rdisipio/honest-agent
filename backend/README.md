# Backend

A thin FastAPI proxy between the frontend and a local `llama-server`. It
forwards chat completions almost verbatim, always requesting logprobs, and
attaches a `logprob_confidence` field (`exp(avg_logprob)` over the answer
span) to the response.

## 1. Run llama-server

Build or install `llama.cpp` (e.g. `brew install llama.cpp`, or build from
[ggml-org/llama.cpp](https://github.com/ggml-org/llama.cpp)), download a
tool-calling-capable GGUF model — `Qwen2.5-7B-Instruct-Q4_K_M` is a good
default — then start the server with:

```bash
llama-server -m Qwen2.5-7B-Instruct-Q4_K_M.gguf -ngl 99 --jinja --port 8080
```

- `-ngl 99` offloads all layers to Metal on Apple Silicon.
- `--jinja` is required for OpenAI-style tool calling (`get_weather`,
  `get_traffic`) to work — it uses the model's built-in chat template to
  parse/emit `tool_calls`.

## 2. Run this backend

Dependencies are managed with [Pipenv](https://pipenv.pypa.io/), which creates its own
project-local virtualenv (separate from any other Python project on your machine):

```bash
cd backend
pipenv install
cp .env.example .env   # adjust LLAMA_SERVER_URL if llama-server isn't on :8080
pipenv run uvicorn main:app --port 8787 --env-file .env
```

Check `curl localhost:8787/health` — it should report both `backend` and
`llama_server` as `ok`.

The frontend's default `VITE_API_URL` (`http://localhost:8787/v1/chat/completions`)
already matches this port, so no frontend config is needed for the default setup.

## Notes

- If `llama-server` doesn't return per-token logprobs alongside a tool-call
  response (this varies by version/build), `logprob_confidence` comes back
  `null` — the frontend already treats that the same as a model declining to
  self-report a verbalized confidence.
- Weather/traffic tools still execute client-side in the browser
  (`src/App.jsx`); this backend never runs tools itself, it only proxies the
  chat turn and relays `tool_calls` back to the frontend to execute.
