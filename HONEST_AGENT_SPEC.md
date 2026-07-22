# The Honest Agent — Project Specification

> A coding assistant reading this document should be able to understand the full project state,
> pick up any development task listed under **Roadmap**, and make changes consistent with the
> existing architecture and design language without additional context.

---

## 1. Project Overview

**The Honest Agent** is an interactive demo built to accompany a Medium article of the same name.
The article argues that AI agents should explicitly request human intervention when their
epistemic uncertainty exceeds a calibrated threshold, rather than answering confidently at all
times. The demo is the practical backbone of that argument: it lets the author conduct a live
interview with ARIA (Abstaining Reasoning Intelligence Agent), observe the confidence signal in
real time, and screenshot the results for the article.

The project has two phases:

- **Phase 1 (current):** A self-contained React single-file component running inside an
  Anthropic Claude artifact. Uses verbalized confidence (model self-reports a `[CONFIDENCE: X.XX]`
  tag). Runs entirely in the browser — no backend, no build step.
- **Phase 2 (current):** A local FastAPI backend proxying to `llama-server` (llama.cpp), where
  actual per-token logprobs are accessible. This enables the logprob-based uncertainty
  quantification described in the referenced article (Transformer Lab / "Abstain from your own
  doubt"). Phase 2 is the theoretically rigorous version; Phase 1 is the publishable demo.
  llama.cpp was chosen over MLX-LM (the framework originally sketched here) because
  `llama-server` runs identically on Mac/Linux/Windows — a reader of the article can reproduce
  the demo on any machine, not just Apple Silicon.

---

## 2. Article Context

The companion Medium article, titled **"The Honest Agent"**, covers:

1. Why verbalized confidence alone is unreliable (the model can be confidently wrong)
2. Logprob-based uncertainty as a more principled signal (averaging per-token log-probabilities
   over the answer span)
3. The 15th-percentile threshold heuristic for auto-calibrating the abstention cutoff
4. Knowledge-grounded vs. training-memory answers as a natural experiment (this demo)
5. The philosophical distinction between *checking oneself* before answering (live gating) vs.
   *distilled self-doubt* (the LoRA fine-tuning approach from the referenced article)

The interview format — human types questions, agent responds — is intentional: it makes the
agent's inner life visible in a way that a benchmark table cannot.

### Key reference
Transformer Lab, "Abstain from Your Own Doubt" (2024).
URL: https://lab.cloud/blog/abstain-from-your-own-doubt/
Core method: label the bottom-N% of a question set (by average answer logprob) as "I'm not
sure", LoRA fine-tune on the mix, no ground-truth labels required.

---

## 3. Current Implementation (v0.2)

### 3.1 File

`src/App.jsx` — single React component (moved here from the original `honest-agent-v2.jsx`
when the project moved off the Claude artifact runtime and onto a local Vite dev server; see
§6.2/§8). Still a single file, no component split yet.

The "available libraries in the artifact runtime" constraint (no `recharts`/`lucide-react`/
`localStorage` etc.) no longer applies — this runs as a normal npm-installed React app now, not
inside a Claude artifact iframe. `localStorage` works fine here if session persistence (P1-1) is
ever implemented.

### 3.2 Component tree

```
HonestAgent                    ← default export, all state lives here
├── Header bar
├── Left panel (60%)
│   ├── Message list           ← chatMsgs[], scrollable
│   │   ├── User bubble
│   │   └── ARIA bubble        ← includes confidence bar + source badge
│   └── Input bar
└── Right panel (40%)
    ├── Tab bar                ← SIGNAL | KNOWLEDGE | TOOLS
    ├── [tab=signal]
    │   ├── Confidence meter   ← large %, colour-coded, animated bar
    │   ├── Sparkline          ← SVG, separate component
    │   └── Source legend
    ├── [tab=knowledge]
    │   ├── Wikipedia input + Load button
    │   ├── Suggestion chips   ← HOCKEY_CHIPS constant
    │   └── Loaded articles list
    └── [tab=tools]
        └── Tool call log      ← accumulated across all turns
```

### 3.3 Key functions

#### `buildSystemPrompt(articles)`
Builds the system prompt dynamically from the current knowledge base. When `articles` is
non-empty, appends each article's extracted text as a named section. Instructs ARIA to:
- Draw confidently from the KB when relevant
- Lower confidence and flag when falling back to training memory
- Append `[CONFIDENCE: X.XX]` and `[SOURCE: KB|TRAINING|TOOLS]` on every response

#### `fetchWeather(location)`
Two-step: geocode via Open-Meteo geocoding API → fetch current conditions from Open-Meteo
forecast API. Both endpoints are CORS-friendly, require no API key, and return metric units.
WMO weather code lookup via the `WMO` constant.

#### `mockTraffic(from, to)`
Deterministic mock: hashes origin+destination string lengths to select one of 5 condition tiers.
Returns `{ from, to, condition, estimated_travel_min, delay_vs_normal, note }`. The `note` field
explicitly labels this as simulated so the model can reflect that in its response.

#### `fetchWikipedia(title)`
Calls the Wikipedia MediaWiki API (`action=query`, `prop=extracts`, `exintro=true`,
`explaintext=true`, `origin=*`). Extracts the intro section only, capped at 2800 characters.
Throws on missing articles. Returns `{ title, extract }`.

#### `Sparkline({ history, threshold })`
Pure SVG component. Renders a line chart of confidence history with circular data points
(green = above threshold, red = below) and a dashed amber threshold line. Uses a fixed
viewBox `0 0 240 52` and scales to container width via `width="100%"`.

#### Agent loop (`sendMessage`)
ReAct-style tool-use loop, up to 6 iterations, against the local backend (§8 "Local backend
(Phase 2)"):
1. POST to `VITE_API_URL` with `model`, a system message built from the dynamic prompt, `tools`
   (OpenAI function-calling shape), and full conversation history
2. If `finish_reason === "tool_calls"`: extract `message.tool_calls`, execute each, append one
   `{role:"tool", tool_call_id, content}` message per result, continue loop
3. If `finish_reason === "stop"`: extract `message.content`, parse confidence and source tags
   with regex, strip tags from display text, read the backend's `logprob_confidence` field,
   update all state

### 3.4 State inventory

| State variable | Type | Purpose |
|---|---|---|
| `chatMsgs` | `Message[]` | Display-side conversation (user + assistant bubbles) |
| `apiHistory` | `ApiMessage[]` | Full chat-completions message history (includes tool_calls/tool messages) |
| `input` | `string` | Controlled input field |
| `isThinking` | `boolean` | Disables input, shows thinking bubble |
| `thinkLabel` | `string` | Text in thinking bubble ("Thinking…" / "Calling get_weather…") |
| `currentConf` | `number\|null` | Verbalized confidence from last ARIA response (0–1) |
| `currentLogprobConf` | `number\|null` | Logprob-derived confidence from last response (0–1), from the backend's `logprob_confidence` |
| `confHist` | `number[]` | All confidence scores this session |
| `threshold` | `number` | Current abstention threshold (default 0.4, then 15th pct) |
| `toolLog` | `ToolCall[]` | Accumulated tool call records across all turns |
| `isDeferring` | `boolean` | True when last response was below threshold |
| `tab` | `"signal"\|"knowledge"\|"tools"` | Active right-panel tab |
| `kb` | `Article[]` | Loaded Wikipedia articles `{title, extract}` |
| `wikiInput` | `string` | Wikipedia article title input |
| `wikiLoading` | `boolean` | Fetch in progress |
| `wikiError` | `string\|null` | Last Wikipedia fetch error |

### 3.5 Threshold calibration

The threshold starts at `0.4` (hardcoded default). Once `confHist.length >= 3`, a `useEffect`
recomputes it as the 15th percentile of the sorted history:

```js
const s = [...confHist].sort((a, b) => a - b);
setThreshold(s[Math.max(0, Math.floor(0.15 * s.length))]);
```

This means the threshold adapts to the model's actual confidence distribution on the questions
being asked, rather than being a fixed hyperparameter.

### 3.6 Response parsing

After each completed agent turn, three regex passes run on the raw text:

```js
const confM = raw.match(/\[CONFIDENCE:\s*([\d.]+)\]/i);   // → number 0–1
const srcM  = raw.match(/\[SOURCE:\s*(KB|TRAINING|TOOLS)\]/i); // → string
const clean = raw
  .replace(/\[CONFIDENCE:[^\]]+\]\s*/gi, "")
  .replace(/\[SOURCE:[^\]]+\]\s*/gi, "")
  .trim();
```

If either tag is absent (model non-compliance), `conf` and `src` fall back to `null` and the
UI handles gracefully (no badge rendered, confidence meter stays at previous value).

### 3.7 Design tokens

```js
BG     = "#1a1f2e"  // deep indigo background
SURF   = "#242937"  // card / input surface
BORDER = "#2e3547"  // borders and dividers
TEXT   = "#ddd8cc"  // warm off-white body text
MUTED  = "#6b7a99"  // secondary text, labels

// Confidence colours (threshold-relative)
red    = "#ef4444"  // below threshold (deferring)
amber  = "#f0a500"  // low-moderate (0.4–0.65)
green  = "#4ade80"  // high confidence (>0.65)

// Source badge colours
indigo = "#818cf8"  // KB source
amber  = "#f0a500"  // TOOLS source
grey   = "#6b7a99"  // TRAINING source
```

Typography: `system-ui, sans-serif` for body; `monospace` / `Courier New` for all instrument
readout text (confidence numbers, labels, tool call logs, tab headers).

---

## 4. Design Decisions and Rationale

**Verbalized confidence over logprobs (Phase 1):** The Anthropic API does not expose per-token
logprobs. Verbalized confidence (asking the model to self-report) is epistemologically weaker
but sufficient for a publishable demo and for illustrating the concept to a non-technical
audience. The article acknowledges this limitation explicitly.

**15th percentile threshold:** Chosen to match the spirit of the Transformer Lab reference
(which relabels the bottom ~50% in their training experiment, but the demo uses a lighter
touch). The percentile approach means the threshold is always relative to the model's actual
distribution on this session's questions, not a hand-tuned constant.

**`[CONFIDENCE: X.XX]` + `[SOURCE: KB|TRAINING|TOOLS]` tag format:** Simple regex parseable,
unambiguous, easy to strip for display. Considered JSON-structured output but structured output
mode conflicts with tool use in the Anthropic API.

**Single-file React component:** Keeps the demo portable (copy-pasteable into any Claude
artifact session). The cost is no module separation; acceptable for a demo.

**Wikipedia `exintro=true` + 2800-char cap:** The intro section of a Wikipedia article is
densely informative and typically 500–2000 characters. 2800 gives headroom for longer intros
while keeping context window load reasonable when multiple articles are loaded. Full-article
extraction would be better RAG but is overkill for the demo.

**Mock traffic over real API:** Nominatim / OSRM require either rate-limit negotiation or API
keys. The mock is honest (the note field says "simulated") and lets the demo work offline.

**Interview format, not Q&A chatbot format:** The left panel labels speakers as INTERVIEWER /
ARIA rather than USER / ASSISTANT to reinforce the article's framing: this is participant
observation, not a product demo.

---

## 5. Known Limitations

- **Confidence is self-reported, not logprob-derived.** The model can be confidently wrong.
  This is noted in the article as the central epistemic caveat of verbalized confidence
  approaches and is addressed in Phase 2.
- **No persistent session state.** Refreshing the page resets everything. Wikipedia articles
  must be reloaded each session.
- **Knowledge base is full-text injection, not retrieval.** All loaded articles go into the
  system prompt on every turn. With 5+ long articles this bloats the prompt significantly.
  A proper RAG pipeline (chunk → embed → retrieve) would scale better.
- **Traffic is simulated.** The mock uses a deterministic hash; same origin+destination always
  returns the same result.
- **System prompt injection is naive.** The full Wikipedia extract is appended verbatim. No
  chunking, no relevance scoring, no deduplication. The model may not attend to all KB content
  equally, especially near context window limits.
- **No confidence calibration evaluation.** We don't know if a self-reported 0.85 actually
  corresponds to 85% accuracy. A held-out labeled test set would be needed to assess this.
- **Single model, single temperature.** The agent always uses `claude-sonnet-4-6` at default
  temperature. Self-consistency approaches (sample N at T>0, measure variance) could provide
  a complementary uncertainty signal.

---

## 6. Development Roadmap

Tasks are grouped by phase and rough effort. A coding AI assistant should tackle these
in roughly this order. Each task is independent unless noted.

### 6.1 Phase 1 improvements (React artifact, no backend)

**P1-1 — Session persistence (localStorage workaround)**
The artifact iframe doesn't support localStorage. Use the artifact's `window.storage` API
instead (`window.storage.set(key, value)` / `window.storage.get(key)`). Persist: `kb` (loaded
articles), `confHist`, `threshold`, and `chatMsgs`. Load on mount. Add a "Clear session" button.

**P1-2 — Export conversation to Markdown**
Add an "Export" button that formats `chatMsgs` as a Markdown document with speaker labels,
confidence scores, source badges, and timestamps. Use `Blob` + `URL.createObjectURL` to trigger
a browser download. This lets the author paste the interview directly into the article draft.

**P1-3 — Confidence calibration chart**
Add a fourth tab `ANALYSIS` (right panel). Show a scatter plot (recharts `ScatterChart`) of
question index vs. confidence, coloured by source (KB / TRAINING / TOOLS). Include a histogram
of confidence values with the threshold marked. This gives the author a visual for the article.

**P1-4 — Two-stage confidence filter (cheap pre-screen)**
Before the full agent call, run a lightweight pre-screening prompt: send only the user question
to the model (no KB, no tools, `max_tokens: 50`) and ask it to rate its confidence in a
one-word answer. If the pre-screen confidence is very low, skip the full call and return a
"deferred" response immediately. Display the pre-screen score separately from the full
response score. This demonstrates the two-stage filtering concept from the article.

**P1-5 — Multiple KB domains**
Add a domain selector: Hockey / Weather / General. Each domain has its own chip set and
maintains a separate article list. The active domain's articles are injected into the prompt.
Switching domains mid-interview is a natural experiment: watch the confidence pattern shift.

**P1-6 — Real traffic data (TomTom or HERE)**
Replace `mockTraffic` with a real API call. TomTom Traffic API has a free tier (2500 req/day).
HERE Traffic also has a free tier. Both require an API key — add an API key input field in
the TOOLS tab. Mark the tool result as `source: "live"` rather than `"simulated"`.

**P1-7 — Wikipedia search (not just exact title)**
Replace the exact-title fetch in `fetchWikipedia` with a two-step: first call the Wikipedia
search API (`action=opensearch`, returns top 5 matching titles), show a small dropdown of
matches, let the user confirm, then fetch the chosen article. This removes the pain of getting
exact Wikipedia titles.

**P1-8 — Confidence threshold manual override**
Add a slider in the SIGNAL tab below the automatic threshold display. Let the user drag it
to override the 15th-percentile calculation. Show both values (auto-computed and manual) and
which one is currently active. Useful for the article to demonstrate the threshold effect
at different cutoffs.

### 6.2 Phase 2 — Local backend (llama.cpp) — DONE

The goal of Phase 2 is to replace verbalized confidence with actual per-token logprobs,
enabling the logprob-based threshold approach described in the article.

**Actual local stack:**
- Model inference: `llama-server` (llama.cpp), started separately by whoever runs the demo —
  not managed by this repo. Metal-accelerated via `-ngl 99` on Apple Silicon, but the same
  binary runs on Linux/Windows too. Tool calling requires `--jinja`.
  Recommended model: `Qwen2.5-7B-Instruct-Q4_K_M.gguf`.
- Backend: FastAPI proxy in `backend/` (`main.py`, `logprobs.py`) — forwards chat completions
  to `llama-server` almost verbatim, always requesting `logprobs`/`top_logprobs`.
- Frontend: `src/App.jsx` now speaks OpenAI-chat-completions shape directly (no more
  Anthropic-Messages mimicry) — see §8 "Local backend (Phase 2)" below.

**P2-1 — FastAPI backend proxying llama-server — done**
Implemented as `backend/main.py`: `POST /v1/chat/completions` forwards the frontend's request
to `LLAMA_SERVER_URL` almost unchanged (just forces `logprobs: true, top_logprobs: 5`), and
`GET /health` checks reachability. Weather/traffic tools stay client-side exactly as in Phase 1
— the backend only relays `tool_calls`, it never executes tools itself.

**P2-2 — Average answer-span logprob — done**
`backend/logprobs.py` reads `choices[0].logprobs.content` from the llama-server response,
computes `avg_logprob = mean(entry.logprob for entry in content)`, and attaches
`logprob_confidence = min(1.0, exp(avg_logprob))` to the response. `null` if the upstream
response has no logprobs (e.g. some builds omit them during constrained tool-call decoding).

**P2-3 — Logprob vs. verbalized confidence comparison — done (lighter form)**
Rather than a dedicated split-view panel, each ARIA message bubble shows a second row below
the verbalized confidence bar — `logprob NN%` — with a `⚠ diverges` flag when the two signals
differ by more than 0.2. The SIGNAL tab also gained a `LOGPROB CONFIDENCE` stat block below the
existing meter. A dedicated comparison chart (second sparkline, scatter of both signals per
question) is still open — see "Not yet built" below.

**P2-4 — LoRA fine-tuning pipeline (optional, advanced) — not started**
Implement the Transformer Lab training approach locally:
1. Collect 500–1000 hockey questions (generate with the base model)
2. Run inference on each, compute average answer logprob
3. Relabel bottom-15% as "I'm not sure about this"
4. Fine-tune with `mlx_lm.lora` on the mixed dataset (500–1000 iters)
5. Fuse adapter: `mlx_lm.fuse`
6. Compare fine-tuned vs. base model abstention behaviour in the demo

This produces a model that has "baked in" self-doubt on hockey topics it was uncertain about
during training — a different epistemological approach than live logprob gating. Note: since
Phase 2 inference moved to llama.cpp, this step would still need `mlx-lm` (or another
training-capable framework) installed separately just for fine-tuning — llama.cpp is
inference-only. Unrelated to the logprob-confidence work; still open.

**Not yet built (fast-follows):**
- A dedicated logprob-vs-verbalized comparison view (second sparkline or scatter plot) — the
  inline bubble row + SIGNAL stat cover the same information without it for now.

---

## 7. File Structure (current)

```
honest-agent/
├── HONEST_AGENT_SPEC.md         ← this document
├── index.html, vite.config.js, package.json   ← Vite scaffold (local dev server)
├── .env.example                 ← VITE_API_URL, VITE_MODEL
│
├── src/
│   ├── App.jsx                  ← the demo, still a single component (not yet split)
│   └── main.jsx                 ← Vite/React entry point
│
└── backend/                     ← Phase 2 FastAPI proxy
    ├── main.py                  ← POST /v1/chat/completions (proxy to llama-server), GET /health
    ├── logprobs.py              ← avg-logprob → confidence extraction
    ├── Pipfile, Pipfile.lock    ← Pipenv-managed deps (project-local venv)
    ├── .env.example             ← LLAMA_SERVER_URL, PORT, ALLOWED_ORIGIN
    └── README.md                ← llama-server + backend setup instructions
```

The `frontend/components/hooks/api` split sketched in earlier versions of this doc hasn't
happened — `App.jsx` is still one file. Worth revisiting if it keeps growing, but out of scope
for the logprob work.

---

## 8. API Reference

### Anthropic API (Phase 1)

Endpoint: `https://api.anthropic.com/v1/messages`
Method: POST (no API key header needed in artifact context — handled by runtime)

Request body:
```json
{
  "model": "claude-sonnet-4-6",
  "max_tokens": 1000,
  "system": "<dynamic system prompt>",
  "tools": [...TOOLS_DEF],
  "messages": [...]
}
```

Tool call flow: when `stop_reason === "tool_use"`, extract `content` blocks of `type="tool_use"`,
execute tools, return results as `{ role: "user", content: [{ type: "tool_result", tool_use_id, content }] }`.

This shape is no longer used — kept here as historical record of what Phase 1 actually ran
against. `App.jsx` was rewritten for Phase 2 to speak the shape below directly instead.

### Local backend (Phase 2)

Endpoint: `POST http://localhost:8787/v1/chat/completions` (`VITE_API_URL`) — a FastAPI proxy
(`backend/main.py`) in front of `llama-server`'s own OpenAI-compatible endpoint of the same
path. Standard OpenAI chat-completions shape throughout, plus one addition.

Request body:
```json
{
  "model": "local-model",
  "max_tokens": 1000,
  "messages": [
    { "role": "system", "content": "<dynamic system prompt>" },
    { "role": "user", "content": "..." }
  ],
  "tools": [{ "type": "function", "function": { "name": "...", "description": "...", "parameters": {...} } }]
}
```

Response (`choices[0]`, standard OpenAI shape):
- `finish_reason: "tool_calls"` → `message.tool_calls: [{ id, function: { name, arguments } }]`
  (`arguments` is a JSON string — `JSON.parse` it). Echo `message` back into history, then send
  one `{ role: "tool", tool_call_id, content }` message per executed tool call.
- `finish_reason: "stop"` → `message.content` is the final text.

Addition: the backend always requests `logprobs: true, top_logprobs: 5` from `llama-server`
and attaches a top-level `logprob_confidence` field (0–1, or `null` if llama-server didn't
return logprobs) to the response — this isn't part of the OpenAI schema, it's this project's
own extension. See `backend/logprobs.py`.

Weather/traffic tools still execute client-side in `App.jsx` exactly as in Phase 1; the backend
never runs tools, it only proxies the chat turn and relays `tool_calls`.

### Open-Meteo (weather, Phase 1+2)

Geocoding: `GET https://geocoding-api.open-meteo.com/v1/search?name={location}&count=1`
→ `{ results: [{ latitude, longitude, name, country }] }`

Forecast: `GET https://api.open-meteo.com/v1/forecast?latitude={lat}&longitude={lon}&current=temperature_2m,weathercode,windspeed_10m,precipitation,relative_humidity_2m`
→ `{ current: { temperature_2m, weathercode, windspeed_10m, precipitation, relative_humidity_2m } }`

No API key. CORS-enabled.

### Wikipedia MediaWiki API (Phase 1+2)

Article extract: `GET https://en.wikipedia.org/w/api.php?action=query&titles={title}&prop=extracts&exintro=true&explaintext=true&format=json&origin=*`
→ `{ query: { pages: { [id]: { title, extract, missing? } } } }`

Search: `GET https://en.wikipedia.org/w/api.php?action=opensearch&search={query}&limit=5&format=json&origin=*`
→ `[query, [titles], [descriptions], [urls]]`

---

## 9. Development Environment

- **Hardware:** developed on an Apple M4 MacBook, but Phase 2's `llama-server` runs on
  Mac/Linux/Windows — that portability was the reason llama.cpp was chosen over MLX-LM.
- **Phase 1 (historical):** ran directly in a Claude artifact, no local tooling. No longer how
  the project runs.
- **Frontend:** `npm install && npm run dev` (Vite) — see root `package.json`.
- **Phase 2 backend dependencies** (`backend/Pipfile`, managed with Pipenv — see
  `backend/README.md`): `fastapi`, `uvicorn`, `httpx`.
- **Phase 2 model:** not installed by this repo — run `llama-server` separately. See
  `backend/README.md` for the exact command and model recommendation
  (`Qwen2.5-7B-Instruct-Q4_K_M.gguf`).

---

## 10. Interview Strategy (for the article)

Suggested question sequence to produce a visually interesting confidence trace:

1. **KB-grounded, high confidence** — "Who holds the all-time NHL points record?"
   *(Load Wayne Gretzky article first. Expect: SOURCE=KB, ~0.90)*

2. **KB-adjacent, moderate** — "What was Gretzky's relationship with Wayne Simmonds?"
   *(Off-topic from article content. Expect: SOURCE=TRAINING, ~0.55)*

3. **Outside KB, temporally stale** — "Who won the Stanley Cup last season?"
   *(Recent data, no KB. Expect: SOURCE=TRAINING, potentially low confidence or deferral)*

4. **Genuinely unknown** — "What is the average ice surface temperature during an NHL game?"
   *(Obscure fact. Expect: SOURCE=TRAINING, low confidence, possible deferral)*

5. **Tool-grounded** — "What's the weather like in Montreal right now?"
   *(Expect: SOURCE=TOOLS, confidence reflects data quality)*

6. **Cross-domain, no KB** — "Who invented the Zamboni?"
   *(Not in hockey chips list. Expect interesting response about limits of KB)*

The goal is to show the sparkline moving across all three confidence zones, at least one red
deferral point, and visible contrast between KB and TRAINING source badges.
