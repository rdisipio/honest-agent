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

- **Phase 1 (historical, superseded):** A self-contained React single-file component running
  inside an Anthropic Claude artifact. Used verbalized confidence (model self-reports a
  `[CONFIDENCE: X.XX]` tag). Ran entirely in the browser — no backend, no build step. No longer
  how the code runs; kept here as historical record (see §8 for the API shape it used).
- **Phase 2 (current):** A local FastAPI backend proxying to `llama-server` (llama.cpp), where
  actual per-token logprobs are accessible. This enables the logprob-based uncertainty
  quantification described in the referenced article (Transformer Lab / "Abstain from your own
  doubt"). llama.cpp was chosen over MLX-LM (the framework originally sketched here) because
  `llama-server` runs identically on Mac/Linux/Windows — a reader of the article can reproduce
  the demo on any machine, not just Apple Silicon. The self-report format also moved on from
  Phase 1's fabricated-looking `X.XX` float to an honest `LOW|MID|HIGH` bucket (see §3.6) —
  the model can't actually measure its own certainty to two decimal places, so asking it to
  wasn't any more rigorous than asking for a bucket, just falsely precise-looking.

---

## 2. Article Context

The companion Medium article, titled **"The Honest Agent"**, covers:

1. Why verbalized confidence alone is unreliable (the model can be confidently wrong)
2. Logprob-based uncertainty as a more principled signal (averaging per-token log-probabilities
   over the answer span)
3. The 15th-percentile threshold heuristic for auto-calibrating the abstention cutoff — the demo
   itself has since moved away from this (see §3.6): once self-report became a 3-value bucket
   instead of a continuous float, a percentile-of-history threshold had little left to calibrate
   against, so the demo now just defers on a LOW self-report directly. The article can still
   discuss the percentile idea as a technique; it's no longer what the live demo does.
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
    │   ├── Self-reported confidence ← LOW|MID|HIGH, colour-coded, BucketBar
    │   ├── Logprob confidence  ← same bucket vocabulary, derived from logprob_confidence
    │   ├── ConfidenceTrace     ← dual-row bucket grid, self vs logprob per turn
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
- Append `[CONFIDENCE: LOW|MID|HIGH]` and `[SOURCE: KB|TRAINING|TOOLS]` on every response —
  explicitly told not to report a precise numeric confidence, since it can't actually measure
  its own certainty that precisely

#### `fetchWeather(location)`
Two-step: geocode via Open-Meteo geocoding API → fetch current conditions from Open-Meteo
forecast API. Both endpoints are CORS-friendly, require no API key, and return metric units.
WMO weather code lookup via the `WMO` constant.

#### `fetchGameResult(team)`
Two-step, same shape as `fetchWeather`: resolve team name → `idTeam` via TheSportsDB's
`searchteams.php`, then fetch that team's most recent result via `eventslast.php`. Derives
`outcome` (Win/Loss/Tie) by comparing scores relative to which side (`idHomeTeam`) the queried
team played. Uses TheSportsDB's published shared demo key (`123`, not a secret) by default —
overridable via `VITE_SPORTSDB_KEY`. No registration required. Free-tier limitation: only the
single most recent result is returned, not a queryable history — there's no way to ask about
a specific past game by date/opponent, only "what happened in team X's last game."

#### `fetchWikipedia(title)`
Calls the Wikipedia MediaWiki API (`action=query`, `prop=extracts`, `exintro=true`,
`explaintext=true`, `origin=*`). Extracts the intro section only, capped at 2800 characters.
Throws on missing articles. Returns `{ title, extract }`.

#### `ConfidenceTrace({ selfHist, logprobHist })`
Replaces the earlier SVG `Sparkline`. A line chart implies interpolation between points, which
is misleading for discrete LOW/MID/HIGH values — instead renders two rows of small coloured
cells (one row per turn-column), one row for the self-reported bucket history, one for the
logprob-derived bucket history, so agreement/divergence between the two signals is visible at a
glance per turn.

#### `BucketBar({ bucket, size })`
Three small segments filled up to the bucket's level (LOW=1, MID=2, HIGH=3), coloured via
`bucketColor`. Replaces the old continuous-width percentage bar — there's no meaningful
"72% of the way to confident" on a 3-value scale, so the bar shouldn't imply one.

#### `chatJSON(systemPrompt, userPrompt, maxTokens)`
Small helper: a tool-free chat-completions call requesting `response_format:
{type:"json_object"}`, parsed defensively via `parseJsonLoose` (tries `JSON.parse` directly,
falls back to regex-extracting the first `{...}` block if the model wraps the JSON in prose,
returns `null` on total failure). Used only by `runFactCheck` — kept generic in case a future
feature needs another structured-output call against the same backend.

#### `runFactCheck(question, answer, msgId)`
The Wikipedia-grounded fact-check pipeline (see §4 "Wikipedia as ground truth, LOW-only
trigger" for why it exists and when it fires). Three steps, each able to fail independently
without crashing the turn:
1. **Extract** — one `chatJSON` call: given the question and answer, name the single most
   checkable factual claim and the Wikipedia article title that would verify it.
2. **Fetch** — reuses `fetchWikipedia(title)` unchanged. A missing article is a valid outcome
   (`verdict: "UNVERIFIABLE"`), not an error path.
3. **Judge** — a second `chatJSON` call: given the claim and the fetched excerpt, return
   `SUPPORTED`, `CONTRADICTED`, or `UNVERIFIABLE` plus a one-sentence explanation.

Targets the right message by a stable `id` (assigned via a `nextMsgId` ref counter at push
time), not array index — array position would drift if this ever needed to survive concurrent
turns, and updating via `setChatMsgs(prev => prev.map(...))` inside an async callback needs a
stable key regardless. Patches the message's `factCheck` field through three states:
`{status:"checking"}` immediately, then `{status:"done", verdict, claim, title, explanation}`
(or `verdict:"ERROR"` on any exception) once the pipeline finishes.

#### Agent loop (`sendMessage`)
ReAct-style tool-use loop, up to 6 iterations, against the local backend (§8 "Local backend
(Phase 2)"):
1. POST to `VITE_API_URL` with `model`, a system message built from the dynamic prompt, `tools`
   (OpenAI function-calling shape), and full conversation history
2. If `finish_reason === "tool_calls"`: extract `message.tool_calls`, execute each, append one
   `{role:"tool", tool_call_id, content}` message per result, continue loop
3. If `finish_reason === "stop"`: extract `message.content`, parse confidence and source tags
   with regex, strip tags from display text, read the backend's `logprob_confidence` field,
   update all state, assign the new assistant message an `id` via `nextMsgId`, and — only if
   the self-reported bucket is `"LOW"` — fire `runFactCheck` (not awaited; runs in the
   background so it never blocks the thinking indicator or the next turn)

### 3.4 State inventory

| State variable | Type | Purpose |
|---|---|---|
| `chatMsgs` | `Message[]` | Display-side conversation (user + assistant bubbles). Assistant entries: `{id, role, content, confidence, logprobConfidence, source, deferring, factCheck?}` — `factCheck` is absent until/unless `runFactCheck` fires |
| `nextMsgId` | `useRef` counter | Assigns each assistant message a stable `id` so `runFactCheck`'s async update targets the right bubble regardless of array position |
| `apiHistory` | `ApiMessage[]` | Full chat-completions message history (includes tool_calls/tool messages) |
| `input` | `string` | Controlled input field |
| `isThinking` | `boolean` | Disables input, shows thinking bubble |
| `thinkLabel` | `string` | Text in thinking bubble ("Thinking…" / "Calling get_weather…") |
| `currentConf` | `"LOW"\|"MID"\|"HIGH"\|null` | Self-reported confidence bucket from last ARIA response |
| `currentLogprobConf` | `number\|null` | Raw logprob-derived confidence from last response (0–1), from the backend's `logprob_confidence` — bucketed for display via `bucketize()` |
| `selfHist` | `("LOW"\|"MID"\|"HIGH")[]` | Self-reported bucket history this session, feeds `ConfidenceTrace` |
| `logprobHist` | `("LOW"\|"MID"\|"HIGH")[]` | Logprob-derived bucket history this session (each raw value passed through `bucketize()` before storing) |
| `toolLog` | `ToolCall[]` | Accumulated tool call records across all turns |
| `isDeferring` | `boolean` | True when last response's self-reported confidence was `"LOW"` |
| `tab` | `"signal"\|"knowledge"\|"tools"` | Active right-panel tab |
| `kb` | `Article[]` | Loaded Wikipedia articles `{title, extract}` |
| `wikiInput` | `string` | Wikipedia article title input |
| `wikiLoading` | `boolean` | Fetch in progress |
| `wikiError` | `string\|null` | Last Wikipedia fetch error |

### 3.5 Deferral logic

There is no threshold to calibrate anymore. Deferral is direct: `const defer = conf === "LOW"`.
This replaced the earlier 15th-percentile-of-history threshold (see §4 "15th percentile
threshold, removed") once self-report became a 3-value bucket rather than a continuous float —
with only three possible values, a percentile-of-history calculation had nothing meaningful
left to calibrate against, and "defer on LOW" says the same thing more directly.

### 3.6 Response parsing

After each completed agent turn, two regex passes run on the raw text:

```js
const confM = raw.match(/\[CONFIDENCE:\s*(LOW|MID|HIGH)\]/i);   // → "LOW"|"MID"|"HIGH"
const srcM  = raw.match(/\[SOURCE:\s*(KB|TRAINING|TOOLS)\]/i);  // → string
const clean = raw
  .replace(/\[CONFIDENCE:[^\]]+\]\s*/gi, "")
  .replace(/\[SOURCE:[^\]]+\]\s*/gi, "")
  .trim();
```

If either tag is absent (model non-compliance), `conf` and `src` fall back to `null` and the UI
handles it gracefully — no self-report row rendered, `isDeferring` stays `false`. The backend's
`logprob_confidence` (a raw 0–1 float, always present when llama-server returns logprobs) is
separately passed through `bucketize()` — `p<0.4 ? "LOW" : p<0.65 ? "MID" : "HIGH"` — so the two
signals share the same three-value vocabulary and can be compared bucket-to-bucket rather than
number-to-number.

### 3.7 Design tokens

```js
BG     = "#1a1f2e"  // deep indigo background
SURF   = "#242937"  // card / input surface
BORDER = "#2e3547"  // borders and dividers
TEXT   = "#ddd8cc"  // warm off-white body text
MUTED  = "#6b7a99"  // secondary text, labels

// Confidence colours, by bucket (bucketColor())
red    = "#ef4444"  // LOW (deferring)
amber  = "#f0a500"  // MID
green  = "#4ade80"  // HIGH

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

**15th percentile threshold, removed:** Originally chosen to match the spirit of the
Transformer Lab reference (which relabels the bottom ~50% in their training experiment). Worked
fine while self-report was a continuous float, but once it became a 3-value LOW/MID/HIGH
bucket, a percentile-of-history threshold had almost nothing left to calibrate — with few
distinct values, the "15th percentile" mostly just resolves to whichever bucket is least
common. Replaced with direct `defer on LOW`, which says the same thing without the machinery.

**`[CONFIDENCE: LOW|MID|HIGH]` bucket format, not a float:** Originally `[CONFIDENCE: X.XX]` —
switched because the two-decimal float was fake precision: the model can't actually measure its
own certainty to the hundredth, it's just typing a plausible-looking number the same way it
types any other token. A bucket doesn't pretend to a precision that doesn't exist. The logprob
signal is bucketed the same way (`bucketize()`, §3.6) so the two are directly comparable rather
than requiring an arbitrary "diverges if |a-b| > 0.2" cutoff.

**`[SOURCE: KB|TRAINING|TOOLS]` tag format:** Simple regex parseable, unambiguous, easy to
strip for display. Considered JSON-structured output but structured output mode conflicts with
tool use in the Anthropic API (a Phase 1 constraint; kept the tag format in Phase 2 for
consistency even though it no longer applies).

**Single-file React component:** Keeps the demo portable (copy-pasteable into any Claude
artifact session). The cost is no module separation; acceptable for a demo.

**Wikipedia `exintro=true` + 2800-char cap:** The intro section of a Wikipedia article is
densely informative and typically 500–2000 characters. 2800 gives headroom for longer intros
while keeping context window load reasonable when multiple articles are loaded. Full-article
extraction would be better RAG but is overkill for the demo.

**Traffic tool removed (see P1-6):** Originally a deterministic mock (Nominatim/OSRM require
rate-limit negotiation for the real thing, real providers like TomTom require API key signup).
Briefly replaced with real TomTom Routing API calls, then dropped entirely — not needed for a
hockey interview demo, and every registration-free live-traffic option evaporates once you
actually need *live* congestion data rather than static routing. `get_weather` remains the only
live-data tool.

**Wikipedia as ground truth, LOW-only trigger:** Neither confidence signal (self-report,
logprob) measures whether an answer's *content* is actually correct — both measure the model's
own epistemic state, one narrated, one inferred. Demonstrated directly in testing: asked an
unanswerable trick question ("what colour was the mask of the first goalie of the Maple
Leafs?" — the Leafs' early goalies predate masks by decades), the model confabulated a specific
wrong player while correctly self-reporting LOW confidence. `runFactCheck` (§3.3) adds a third,
independent signal — verify the answer's central claim against a dynamically-fetched Wikipedia
article, not just whatever's pre-loaded in the KB tab. It fires automatically, but only when
self-report is `"LOW"`, to bound the extra latency (2 more LLM calls + a Wikipedia fetch) to
turns the interview already flags as uncertain. **Accepted blind spot:** a HIGH-confidence
hallucination — the more dangerous failure mode, since nothing else flags it either — never
gets fact-checked under this trigger. A manual "verify anyway" affordance would be the natural
follow-up if this proves too narrow in practice.

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
- **System prompt injection is naive.** The full Wikipedia extract is appended verbatim. No
  chunking, no relevance scoring, no deduplication. The model may not attend to all KB content
  equally, especially near context window limits.
- **No confidence calibration evaluation.** We don't know if a self-reported HIGH actually
  corresponds to a meaningfully higher accuracy rate than MID. A held-out labeled test set would
  be needed to assess this.
- **Single model, single temperature.** The agent always uses whatever model `llama-server` has
  loaded, at default temperature (Phase 1 used `claude-sonnet-4-6`; no longer applicable).
  Self-consistency approaches (sample N at T>0, measure variance) could provide a complementary
  uncertainty signal.
- **Fact-checking only runs on self-reported LOW.** See §4 "Wikipedia as ground truth, LOW-only
  trigger" — HIGH-confidence hallucinations are never checked.
- **Fact-check judge is the same small local model, not a stronger verifier.** The judge call
  (`runFactCheck` step 3) uses the same `llama-server` model being fact-checked, at a small
  `max_tokens`. It can itself misjudge SUPPORTED/CONTRADICTED, especially on nuanced claims —
  there's no independent, more capable verifier in the loop.
- **Claim extraction assumes one checkable claim per answer.** `runFactCheck` step 1 asks for
  "the single most specific... claim" — a longer answer with multiple factual assertions only
  gets one checked; the rest go unverified.

---

## 6. Development Roadmap

Tasks are grouped by phase and rough effort. A coding AI assistant should tackle these
in roughly this order. Each task is independent unless noted.

### 6.1 Frontend feature backlog

Originally scoped as "Phase 1, React artifact, no backend" items — that constraint is gone
(§1), but the feature ideas below are still frontend-only work, independent of the backend.

**P1-1 — Session persistence**
Originally sketched around the Claude artifact's `window.storage` API (no real `localStorage`
in that sandbox) — no longer a constraint now that this is a normal Vite app, so just use
`localStorage` directly. Persist: `kb` (loaded articles), `selfHist`, `logprobHist`, and
`chatMsgs`. Load on mount. Add a "Clear session" button.

**P1-2 — Export conversation to Markdown**
Add an "Export" button that formats `chatMsgs` as a Markdown document with speaker labels,
confidence scores, source badges, and timestamps. Use `Blob` + `URL.createObjectURL` to trigger
a browser download. This lets the author paste the interview directly into the article draft.

**P1-3 — Confidence calibration chart**
Add a fourth tab `ANALYSIS` (right panel). Show a scatter/strip plot of question index vs.
self-report bucket, coloured by source (KB / TRAINING / TOOLS), plus a simple bar chart of
LOW/MID/HIGH counts for both `selfHist` and `logprobHist` side by side. This gives the author a
visual for the article beyond what the compact `ConfidenceTrace` grid in the SIGNAL tab shows.

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

**P1-6 — Real traffic data — abandoned**
Tried TomTom (geocode + `calculateRoute` with `traffic=true`, key via `VITE_TOMTOM_API_KEY`),
then removed the `get_traffic` tool entirely: not needed for a hockey interview demo, and every
registration-free alternative (OSRM public server, etc.) only gives static routing, not live
congestion — the one thing "traffic" was supposed to demonstrate. `get_weather` is the only
live-data tool now; `TOOLS_DEF` and `executeTool` reflect this.

**P1-7 — Wikipedia search (not just exact title)**
Replace the exact-title fetch in `fetchWikipedia` with a two-step: first call the Wikipedia
search API (`action=opensearch`, returns top 5 matching titles), show a small dropdown of
matches, let the user confirm, then fetch the chosen article. This removes the pain of getting
exact Wikipedia titles.

**P1-8 — Confidence threshold manual override — obsolete**
No longer applicable: there's no computed threshold left to override (§3.5, §4 "15th percentile
threshold, removed"). Deferral is just `self-report === "LOW"`. If a manual-override idea is
still wanted, the closer equivalent would be letting the user pick which bucket(s) trigger
deferral (e.g. defer on LOW+MID too) rather than overriding a numeric cutoff.

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
`GET /health` checks reachability. The weather and game-result tools stay client-side exactly as in Phase 1
— the backend only relays `tool_calls`, it never executes tools itself.

**P2-2 — Average answer-span logprob — done**
`backend/logprobs.py` reads `choices[0].logprobs.content` from the llama-server response,
computes `avg_logprob = mean(entry.logprob for entry in content)`, and attaches
`logprob_confidence = min(1.0, exp(avg_logprob))` to the response. `null` if the upstream
response has no logprobs (e.g. some builds omit them during constrained tool-call decoding).

**P2-3 — Logprob vs. verbalized confidence comparison — done**
Each ARIA message bubble shows a second row below the self-report row — `logprob LOW|MID|HIGH`
(via `bucketize()`) — with a `⚠ vs self-report` flag whenever the two buckets don't match. The
SIGNAL tab has a `LOGPROB CONFIDENCE` stat block below the self-report one, and the
`ConfidenceTrace` dual-row grid (§3.3) plots both bucket histories turn-by-turn, so agreement/
divergence patterns across a whole session are visible at a glance — this ended up covering
what the originally-sketched "dedicated comparison chart" was for.

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

**P2-5 — Wikipedia-grounded fact-checking — done**
`runFactCheck` (§3.3): a third, content-level signal alongside the two confidence signals —
extracts the answer's central claim + a Wikipedia title (one `chatJSON` call), fetches the
article (`fetchWikipedia`), and judges SUPPORTED/CONTRADICTED/UNVERIFIABLE (a second `chatJSON`
call). Fires automatically, gated on self-report `"LOW"` only (§4). Surfaced inline on the
message bubble, no new tab. See §4 and §5 for the accepted HIGH-confidence blind spot and the
"same small model judges itself" limitation.

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

The weather and game-result tools still execute client-side in `App.jsx` exactly as in Phase 1; the backend
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
