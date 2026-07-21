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
- **Phase 2 (planned):** A local Python stack on an M4 MacBook using MLX-LM or Ollama, where
  actual per-token logprobs are accessible. This enables the logprob-based uncertainty
  quantification described in the referenced article (Transformer Lab / "Abstain from your own
  doubt"). Phase 2 is the theoretically rigorous version; Phase 1 is the publishable demo.

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

`honest-agent-v2.jsx` — single React component, ~565 lines, no external dependencies beyond
what is available in the Claude artifact runtime.

**Available libraries in the artifact runtime:**
`react`, `recharts`, `lucide-react`, `lodash`, `d3`, `mathjs`, `papaparse`, `xlsx`, `tone`,
`three`, `tailwindcss` (base utilities only, no compiler). Do **not** use `localStorage` or
`sessionStorage` — they are not supported in the artifact iframe.

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
ReAct-style tool-use loop, up to 6 iterations:
1. POST to `https://api.anthropic.com/v1/messages` with model `claude-sonnet-4-6`, dynamic
   system prompt, `TOOLS_DEF`, and full conversation history
2. If `stop_reason === "tool_use"`: extract tool call blocks, execute each, append results as
   `tool_result` content, continue loop
3. If `stop_reason === "end_turn"`: extract text, parse confidence and source tags with regex,
   strip tags from display text, update all state

### 3.4 State inventory

| State variable | Type | Purpose |
|---|---|---|
| `chatMsgs` | `Message[]` | Display-side conversation (user + assistant bubbles) |
| `apiHistory` | `ApiMessage[]` | Full Anthropic API message history (includes tool blocks) |
| `input` | `string` | Controlled input field |
| `isThinking` | `boolean` | Disables input, shows thinking bubble |
| `thinkLabel` | `string` | Text in thinking bubble ("Thinking…" / "Calling get_weather…") |
| `currentConf` | `number\|null` | Confidence from last ARIA response (0–1) |
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

### 6.2 Phase 2 — Local Python stack (M4 MacBook)

The goal of Phase 2 is to replace verbalized confidence with actual per-token logprobs,
enabling the logprob-based threshold approach described in the article.

**Recommended local stack:**
- Model inference: `mlx-lm` (Apple's MLX framework, native Apple Silicon)
  - Install: `pip install mlx-lm`
  - Models: `mlx-community/Qwen2.5-7B-Instruct-4bit` or `mlx-community/Llama-3.1-8B-Instruct-4bit`
  - Logprobs: available via `mlx_lm.utils.stream_generate` (yields `GenerationResponse` with
    `.logprobs` field per token)
- Backend: FastAPI (`pip install fastapi uvicorn`)
- Frontend: keep the React component but point API calls at `http://localhost:8000`
  instead of `https://api.anthropic.com/v1/messages`

**P2-1 — FastAPI backend with MLX-LM**
Create `backend/main.py`. Implement:
```
POST /v1/generate       → runs mlx_lm.generate, returns text + logprobs
POST /v1/tools/weather  → wraps fetchWeather logic in Python (httpx)
POST /v1/tools/traffic  → mock or real
```
The `/v1/generate` endpoint should accept `{ prompt, max_tokens, temperature }` and return
`{ text, tokens: [{token, logprob}] }`.

**P2-2 — Average answer-span logprob**
In the backend, after generation, identify the "answer span" (tokens after the prompt ends)
and compute `avg_logprob = mean(logprob for tok in answer_tokens)`. Convert to a 0–1
confidence signal: `conf = exp(avg_logprob)` (or a calibrated sigmoid). This is the core
method from the Transformer Lab reference.

**P2-3 — Logprob vs. verbalized confidence comparison**
Add a split display in the frontend showing both signals side by side: the logprob-derived
score (from the model's output distribution) and the verbalized self-report (from the
`[CONFIDENCE: X.XX]` tag). Highlight cases where they diverge. This is the empirical heart
of the article's argument.

**P2-4 — LoRA fine-tuning pipeline (optional, advanced)**
Implement the Transformer Lab training approach locally:
1. Collect 500–1000 hockey questions (generate with the base model)
2. Run inference on each, compute average answer logprob
3. Relabel bottom-15% as "I'm not sure about this"
4. Fine-tune with `mlx_lm.lora` on the mixed dataset (500–1000 iters)
5. Fuse adapter: `mlx_lm.fuse`
6. Compare fine-tuned vs. base model abstention behaviour in the demo

This produces a model that has "baked in" self-doubt on hockey topics it was uncertain about
during training — a different epistemological approach than live logprob gating.

---

## 7. File Structure (current + planned)

```
honest-agent/
├── honest-agent-v2.jsx          ← current Phase 1 demo (single file, artifact-ready)
├── HONEST_AGENT_SPEC.md         ← this document
│
├── backend/                     ← Phase 2 (not yet created)
│   ├── main.py                  ← FastAPI app
│   ├── inference.py             ← MLX-LM wrapper + logprob extraction
│   ├── tools.py                 ← weather, traffic, wikipedia implementations
│   ├── kb.py                    ← knowledge base chunking + retrieval (future)
│   └── requirements.txt
│
└── frontend/                    ← Phase 2 (split from single file)
    ├── src/
    │   ├── App.jsx
    │   ├── components/
    │   │   ├── ChatPanel.jsx
    │   │   ├── SignalPanel.jsx
    │   │   ├── KnowledgePanel.jsx
    │   │   ├── ToolsPanel.jsx
    │   │   └── Sparkline.jsx
    │   ├── hooks/
    │   │   ├── useAgentLoop.js
    │   │   └── useThreshold.js
    │   └── api/
    │       └── client.js
    └── package.json
```

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

- **Hardware:** Apple M4 MacBook (unified memory, Apple Silicon)
- **Phase 1:** No local tooling needed. The `.jsx` file runs directly in a Claude artifact.
  Paste content into claude.ai → New artifact → React component.
- **Phase 2 Python dependencies:**
  ```
  mlx-lm>=0.19.0
  fastapi>=0.110.0
  uvicorn>=0.29.0
  httpx>=0.27.0
  numpy>=1.26.0
  ```
  Install with `pip install <package> --break-system-packages` on macOS Sonoma/Sequoia.
- **Phase 2 model download:**
  ```bash
  # Downloads to ~/.cache/huggingface/hub/
  python -c "from mlx_lm import load; load('mlx-community/Qwen2.5-7B-Instruct-4bit')"
  ```

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
