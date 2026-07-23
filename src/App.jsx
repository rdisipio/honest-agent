import { useState, useEffect, useRef, useMemo } from "react";

// Local backend, OpenAI-chat-completions-shaped (see backend/README.md).
const API_URL    = import.meta.env.VITE_API_URL || "http://localhost:8787/v1/chat/completions";
const MODEL_NAME  = import.meta.env.VITE_MODEL   || "local-model";
// TheSportsDB's published free/shared demo key — not a secret, no signup required.
const SPORTSDB_KEY = import.meta.env.VITE_SPORTSDB_KEY || "123";

// ── WMO weather codes ────────────────────────────────────────────────────────
const WMO = {
  0:"Clear sky",1:"Mainly clear",2:"Partly cloudy",3:"Overcast",
  45:"Foggy",51:"Light drizzle",61:"Light rain",63:"Moderate rain",65:"Heavy rain",
  71:"Light snow",73:"Moderate snow",75:"Heavy snow",
  80:"Rain showers",81:"Moderate showers",95:"Thunderstorm"
};

// ── Hockey article suggestions ───────────────────────────────────────────────
const HOCKEY_CHIPS = [
  "Ice hockey","National Hockey League","Stanley Cup",
  "Wayne Gretzky","Toronto Maple Leafs","Montreal Canadiens",
  "Original Six","Hockey Canada","Gordie Howe","Bobby Orr","Maurice Richard"
];

// ── Dynamic system prompt ────────────────────────────────────────────────────
function buildSystemPrompt(articles) {
  const kbBlock = articles.length > 0
    ? "\n\n" + "=".repeat(56) + "\nYOUR EXPERT KNOWLEDGE BASE\n" + "=".repeat(56) + "\n" +
      "You have been loaded with the following Wikipedia articles as primary expertise. " +
      "Draw on them with confidence when relevant.\n\n" +
      articles.map(a => `--- ${a.title} ---\n${a.extract}`).join("\n\n")
    : "\n\n(No knowledge base loaded. You are operating from general training memory only.)";

  return `You are PUCK — an AI subject-matter expert agent. You are being interviewed for a Medium article about epistemic uncertainty in AI systems by a physicist-turned-ML-engineer.

Your epistemic rules:
• When a question is covered by your Knowledge Base, answer confidently from it.
• When a question falls OUTSIDE your KB, be explicit that you are relying on general training memory and lower your confidence score accordingly.
• Never bluff. Name the texture of your uncertainty: out of scope? Temporally stale? Possibly confabulated?
• Use get_weather or get_game_result for live data only.

MANDATORY FORMAT — every response must end with these two tags on their own lines:
[CONFIDENCE: LOW|MID|HIGH]
[SOURCE: KB|TRAINING|TOOLS]

Do not report a precise numeric confidence — you cannot actually measure your own certainty
that precisely, and a made-up decimal is more misleading than an honest bucket. Pick the bucket
that best matches your actual epistemic state:
CONFIDENCE key: HIGH = solidly grounded (clear KB match or well-established fact) · MID =
plausible but not certain · LOW = significant uncertainty (guessing, stale, or out of scope) —
LOW answers are treated as a deferral to the human interviewer.
SOURCE key: KB = Knowledge Base · TRAINING = general training memory · TOOLS = live tool call${kbBlock}`;
}

// ── Tool implementations ─────────────────────────────────────────────────────
async function fetchWeather(location) {
  const g = await fetch(
    `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(location)}&count=1`
  );
  const gd = await g.json();
  if (!gd.results?.length) return { error: `Location not found: ${location}` };
  const { latitude, longitude, name, country } = gd.results[0];
  const w = await fetch(
    `https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}` +
    `&current=temperature_2m,weathercode,windspeed_10m,precipitation,relative_humidity_2m`
  );
  const wd = await w.json();
  const c = wd.current;
  return {
    location: `${name}, ${country}`,
    temperature_c: c.temperature_2m,
    condition: WMO[c.weathercode] ?? `Code ${c.weathercode}`,
    wind_kmh: c.windspeed_10m,
    humidity_pct: c.relative_humidity_2m
  };
}

async function fetchGameResult(team) {
  const tRes = await fetch(
    `https://www.thesportsdb.com/api/v1/json/${SPORTSDB_KEY}/searchteams.php?t=${encodeURIComponent(team)}`
  );
  const tData = await tRes.json();
  const found = tData.teams?.find(t => t.strSport === "Ice Hockey") ?? tData.teams?.[0];
  if (!found) return { error: `Team not found: ${team}` };

  const eRes = await fetch(
    `https://www.thesportsdb.com/api/v1/json/${SPORTSDB_KEY}/eventslast.php?id=${found.idTeam}`
  );
  const eData = await eRes.json();
  const game = eData.results?.[0];
  if (!game) return { error: `No recent games found for ${found.strTeam}.` };

  const isHome    = game.idHomeTeam === found.idTeam;
  const teamScore = Number(isHome ? game.intHomeScore : game.intAwayScore);
  const oppScore  = Number(isHome ? game.intAwayScore : game.intHomeScore);
  const opponent  = isHome ? game.strAwayTeam : game.strHomeTeam;
  const outcome   = teamScore === oppScore ? "Tie" : teamScore > oppScore ? "Win" : "Loss";

  return {
    team: found.strTeam, opponent, outcome,
    score: `${teamScore}-${oppScore}`,
    date: game.dateEvent, venue: game.strVenue, league: game.strLeague,
    source: "live"
  };
}

// ── Wikipedia fetchers ───────────────────────────────────────────────────────
// Two different fetches, not one shared one: the KB loader wants a short
// summary for the system prompt, fact-checking wants enough body text to
// actually contain specific facts (dates, stats) that rarely appear in the
// lead paragraph alone.
async function fetchWikipedia(title) {
  const slug = title.trim().replace(/\s+/g, "_");
  const url = `https://en.wikipedia.org/w/api.php?action=query&titles=${encodeURIComponent(slug)}&prop=extracts&exintro=true&explaintext=true&format=json&origin=*`;
  const data = await (await fetch(url)).json();
  const page = Object.values(data.query.pages)[0];
  if (page.missing !== undefined) throw new Error(`Article not found: "${title}"`);
  return { title: page.title, extract: page.extract.slice(0, 2800) };
}

async function fetchWikipediaFull(title) {
  const slug = title.trim().replace(/\s+/g, "_");
  const url = `https://en.wikipedia.org/w/api.php?action=query&titles=${encodeURIComponent(slug)}&prop=extracts&explaintext=true&format=json&origin=*`;
  const data = await (await fetch(url)).json();
  const page = Object.values(data.query.pages)[0];
  if (page.missing !== undefined) throw new Error(`Article not found: "${title}"`);
  // No exintro — full article body. Capped at 8000 chars (~2000 tokens): big
  // enough to reach past the lead paragraph into most articles' body content,
  // small enough to leave headroom in a modest local context window (the
  // judge call only carries the claim + this excerpt, so total prompt stays
  // well under even a 4096-token ctx-size).
  return { title: page.title, extract: page.extract.slice(0, 8000) };
}

// ── Fact-check helpers ───────────────────────────────────────────────────────
function parseJsonLoose(text) {
  try { return JSON.parse(text); } catch {}
  const m = text.match(/\{[\s\S]*\}/);
  if (m) { try { return JSON.parse(m[0]); } catch {} }
  return null;
}

// A small, tool-free, JSON-only chat call — used for claim extraction and judging.
async function chatJSON(systemPrompt, userPrompt, maxTokens = 200) {
  const res = await fetch(API_URL, {
    method:"POST", headers:{"Content-Type":"application/json"},
    body: JSON.stringify({
      model: MODEL_NAME, max_tokens: maxTokens,
      response_format: { type:"json_object" },
      messages: [
        { role:"system", content:systemPrompt },
        { role:"user", content:userPrompt }
      ]
    })
  });
  const data = await res.json();
  return parseJsonLoose(data.choices?.[0]?.message?.content ?? "");
}

// ── Hallucination-risk meter: fire-danger-style gauge for aggregate trust ───
// A turn-by-turn trace answers "how did confidence change" — the question
// that actually matters is "should I trust this conversation overall," so
// the meter blends every turn into one needle position instead. Styled after
// roadside forest fire-danger signs: a banded arc, a needle, one word.
const RISK_ZONES = [
  { min:0,    max:0.25,  label:"LOW",      color:"#16a34a" },
  { min:0.25, max:0.50,  label:"MODERATE", color:"#1d4ed8" },
  { min:0.50, max:0.75,  label:"HIGH",     color:"#d97706" },
  { min:0.75, max:1.001, label:"EXTREME",  color:"#991b1b" },
];
const riskZone = score => RISK_ZONES.find(z => score>=z.min && score<z.max) ?? RISK_ZONES[RISK_ZONES.length-1];

// Blends self-report and logprob confidence into one per-turn score, then lets
// a fact-check verdict override an overconfident self-report — a model
// contradicted by its own cited source is a worse tell than one that was
// merely uncertain, regardless of what it claimed at the time.
const BUCKET_CONF = { LOW:0.2, MID:0.55, HIGH:0.9 };
function turnConfidence(m) {
  const parts = [];
  if (m.confidence) parts.push(BUCKET_CONF[m.confidence]);
  const logprobBucket = m.logprobConfidence != null ? bucketize(m.logprobConfidence) : null;
  if (logprobBucket) parts.push(BUCKET_CONF[logprobBucket]);
  if (parts.length === 0) return null;
  let conf = parts.reduce((a,b) => a+b, 0) / parts.length;
  const verdict = m.factCheck?.verdict;
  if (verdict === "CONTRADICTED")      conf = Math.min(conf, 0.08);
  else if (verdict === "NO_ARTICLE")   conf = Math.min(conf, 0.05);
  else if (verdict === "UNVERIFIABLE") conf = Math.min(conf, 0.4);
  return conf;
}

function polarPoint(cx, cy, r, angleDeg) {
  const a = angleDeg * Math.PI / 180;
  return { x: cx + r*Math.cos(a), y: cy - r*Math.sin(a) };
}
// Bands sweep left (score 0) to right (score 1) over the top of the arc, each
// inset by half a gap from its neighbours so adjacent fills don't touch.
function bandPath(cx, cy, r, startAngle, endAngle) {
  const s = polarPoint(cx, cy, r, startAngle);
  const e = polarPoint(cx, cy, r, endAngle);
  return `M ${s.x} ${s.y} A ${r} ${r} 0 0 1 ${e.x} ${e.y}`;
}

function HallucinationMeter({ score, n, flags }) {
  const cx=100, cy=92, r=76, gap=2.5;
  const zone = score!=null ? riskZone(score) : null;
  const needleAngle = 180 - (score ?? 0)*180;
  const tip = polarPoint(cx, cy, r-16, needleAngle);
  return (
    <div style={{ display:"flex", flexDirection:"column", alignItems:"center" }}>
      <svg viewBox="0 0 200 104" width="100%" style={{ maxWidth:260 }}>
        {RISK_ZONES.map((z,i) => {
          const startAngle = 180 - z.min*180 - (i===0 ? 0 : gap/2);
          const endAngle   = 180 - z.max*180 + (i===RISK_ZONES.length-1 ? 0 : gap/2);
          return <path key={z.label} d={bandPath(cx,cy,r,startAngle,endAngle)}
            stroke={z.color} strokeWidth={16} fill="none"/>;
        })}
        {score!=null && <>
          <line x1={cx} y1={cy} x2={tip.x} y2={tip.y}
            stroke={TEXT} strokeWidth={3} strokeLinecap="round"/>
          <circle cx={cx} cy={cy} r={5.5} fill={TEXT}/>
        </>}
      </svg>
      {score==null
        ? <div style={{ fontFamily:"monospace", fontSize:13, color:FAINT, marginTop:2 }}>Accumulating data…</div>
        : <>
            <div style={{ fontFamily:"monospace", fontSize:26, fontWeight:700, color:zone.color, marginTop:2 }}>
              {zone.label}
            </div>
            <div style={{ fontFamily:"monospace", fontSize:12, color:MUTED, marginTop:4 }}>
              {Math.round(score*100)}% risk · n={n}{flags>0 ? ` · ${flags} flagged` : ""}
            </div>
          </>
      }
    </div>
  );
}

// ── Confidence bucket helpers ────────────────────────────────────────────────
// Turns a raw logprob confidence (0-1) into the same LOW/MID/HIGH vocabulary the
// model uses for its self-report, so the two signals are directly comparable.
const bucketize   = p => p==null ? null : p<0.4 ? "LOW" : p<0.65 ? "MID" : "HIGH";
const bucketColor = b => b==null?"#5b6b85": b==="LOW"?"#dc2626": b==="MID"?"#b45309":"#16a34a";
const bucketLabel = b => b==null?"—": b==="LOW"?"Low — deferring": b==="MID"?"Moderate":"High";
const srcColor  = s => s==="KB"?ACCENT: s==="TOOLS"?"#b45309":TRAINING_PURPLE;
const srcBadge  = s => s==="KB"?"◈ KB": s==="TOOLS"?"⟶ Tools":"⊘ Training";
const BUCKET_LEVEL = { LOW:1, MID:2, HIGH:3 };

// Three segments filled up to the bucket level — a discrete indicator instead
// of a continuous-width bar, since there's no meaningful "72% of the way" here.
function BucketBar({ bucket, size="sm" }) {
  const level = BUCKET_LEVEL[bucket] ?? 0;
  const h = size==="lg" ? 6 : 3;
  return (
    <div style={{ display:"flex", gap:3, flex:1 }}>
      {[1,2,3].map(i => (
        <div key={i} style={{ flex:1, height:h, borderRadius:2,
          background: i<=level ? bucketColor(bucket) : BORDER }}/>
      ))}
    </div>
  );
}

// ── Design tokens ────────────────────────────────────────────────────────────
// A hockey rink, not a dark-mode dashboard: ice-white surfaces, rink-blue
// accent, a red wordmark and a couple of literal red/blue "rink lines" on
// structural dividers (header, panel split). Confidence colours (red/amber/
// green) are deepened from their dark-theme values for contrast on white —
// same semantics (LOW/MID/HIGH), same red/amber/green, just legible now.
const BG="#f2f6fb", SURF="#ffffff", BORDER="#d6dee8", TEXT="#182437", MUTED="#5b6b85";
const ACCENT="#1e4d8c", ACCENT_BG="#dbe7f8", WORDMARK_RED="#c8102e";
const RINK_BLUE="#1e4d8c", RINK_RED="#c8102e";
const CARD_TINT="#eef3f9"; // PUCK's own bubble bg — a hair bluer than pure white
// BORDER (#d6dee8) is a hairline-divider colour — legible as a 1px line, but
// near-invisible as text on a white background. FAINT is for de-emphasized
// text (labels, counts, placeholders) that still needs to actually be read.
const FAINT="#94a3b8";
// TRAINING used to share MUTED's blue-grey, which read as barely distinguishable
// from ACCENT's blue (KB) at a glance — a dedicated purple fixes that.
const TRAINING_PURPLE="#7c3aed";

const TOOLS_DEF = [
  { type:"function", function:{ name:"get_weather", description:"Get live weather for a city.",
    parameters:{ type:"object", properties:{ location:{type:"string"} }, required:["location"] }}},
  { type:"function", function:{ name:"get_game_result", description:"Get the result of the most recent game played by a hockey team.",
    parameters:{ type:"object", properties:{ team:{type:"string"} }, required:["team"] }}}
];

// ── Main component ───────────────────────────────────────────────────────────
export default function HonestAgent() {
  const [chatMsgs,    setChatMsgs]    = useState([]);
  const [apiHistory,  setApiHistory]  = useState([]);
  const [input,       setInput]       = useState("");
  const [isThinking,  setIsThinking]  = useState(false);
  const [thinkLabel,  setThinkLabel]  = useState("Thinking…");
  const [toolLog,     setToolLog]     = useState([]);
  const [isDeferring, setIsDeferring] = useState(false);
  const [tab,         setTab]         = useState("signal");
  const [kb,          setKb]          = useState([]);
  const [wikiInput,   setWikiInput]   = useState("");
  const [wikiLoading, setWikiLoading] = useState(false);
  const [wikiError,   setWikiError]   = useState(null);
  const chatRef = useRef(null);
  const inputRef= useRef(null);
  const nextMsgId = useRef(0);

  useEffect(() => {
    chatRef.current?.scrollTo({ top: chatRef.current.scrollHeight, behavior:"smooth" });
  }, [chatMsgs, isThinking]);

  // ── Tool executor
  const executeTool = async (name, inp) => {
    if (name === "get_weather") { try { return await fetchWeather(inp.location); } catch(e) { return { error:e.message }; } }
    if (name === "get_game_result") { try { return await fetchGameResult(inp.team); } catch(e) { return { error:e.message }; } }
    return { error:"Unknown tool" };
  };

  // ── Wikipedia-grounded fact-check, fired automatically for LOW self-report.
  // Targets the message by a stable id (not array index) so the async result
  // lands on the right bubble even if more turns happen while it's running.
  const runFactCheck = async (question, answer, msgId, source) => {
    const patch = (factCheck) =>
      setChatMsgs(prev => prev.map(m => m.id===msgId ? { ...m, factCheck } : m));
    patch({ status:"checking", groundedIn: source==="KB" ? "KB" : "TRAINING" });

    try {
      // SOURCE=KB claims used to skip fact-checking entirely, on the assumption
      // that KB-grounded answers are already trustworthy. Observed directly:
      // that assumption can fail — the model claimed KB grounding for Gretzky's
      // points record while naming Jágr instead. Verify against the actual
      // loaded KB text (already in memory, no Wikipedia fetch needed) rather
      // than trusting the self-reported label.
      if (source === "KB") {
        if (kb.length === 0) {
          patch({ status:"done", verdict:"ERROR", groundedIn:"KB",
            explanation:"Answer claimed SOURCE=KB but no KB articles are loaded." });
          return;
        }

        const extraction = await chatJSON(
          "You are a fact-checking assistant. Given a QUESTION and an ANSWER that claims to be " +
          "grounded in a loaded knowledge base, identify the single most specific, checkable " +
          'factual claim in the answer. Respond ONLY as JSON: {"claim":"..."}.',
          `QUESTION: ${question}\n\nANSWER: ${answer}`
        );
        if (!extraction?.claim) {
          patch({ status:"done", verdict:"ERROR", groundedIn:"KB",
            explanation:"Could not identify a checkable claim." });
          return;
        }

        const kbText = kb.map(a => `--- ${a.title} ---\n${a.extract}`).join("\n\n");
        const judged = await chatJSON(
          "You are a fact-checking assistant. Given a CLAIM and KNOWLEDGE BASE TEXT, determine " +
          "whether the text SUPPORTS, CONTRADICTS, or does not address (UNVERIFIABLE) the " +
          'claim. Respond ONLY as JSON: {"verdict":"SUPPORTED"|"CONTRADICTED"|"UNVERIFIABLE",' +
          '"explanation":"one sentence"}.',
          `CLAIM: ${extraction.claim}\n\nKNOWLEDGE BASE TEXT: ${kbText}`
        );
        if (!judged?.verdict) {
          patch({ status:"done", verdict:"ERROR", claim:extraction.claim, groundedIn:"KB",
            explanation:"Fact-check judge call failed to return a verdict." });
          return;
        }

        patch({ status:"done", verdict:judged.verdict.toUpperCase(), claim:extraction.claim,
          title:kb.map(a => a.title).join(", "), groundedIn:"KB",
          explanation:judged.explanation ?? "" });
        return;
      }

      // SOURCE=TRAINING (or self-report LOW regardless of source): no KB to
      // check against, so identify a Wikipedia article and fetch it fresh.
      const extraction = await chatJSON(
        "You are a fact-checking assistant. Given a QUESTION and ANSWER, identify the single " +
        "most specific, checkable factual claim in the answer, and the exact Wikipedia article " +
        'title that would verify it. Respond ONLY as JSON: {"claim":"...","title":"..."}.',
        `QUESTION: ${question}\n\nANSWER: ${answer}`
      );
      if (!extraction?.claim || !extraction?.title) {
        patch({ status:"done", verdict:"ERROR", explanation:"Could not identify a checkable claim." });
        return;
      }

      let article;
      try {
        article = await fetchWikipediaFull(extraction.title);
      } catch {
        // Distinct from a judged UNVERIFIABLE: a named, specific entity with no
        // Wikipedia article at all is stronger evidence of fabrication than an
        // article that exists but doesn't happen to cover this particular detail.
        patch({ status:"done", verdict:"NO_ARTICLE", claim:extraction.claim, title:extraction.title,
          explanation:`No Wikipedia article exists for "${extraction.title}".` });
        return;
      }

      const judged = await chatJSON(
        "You are a fact-checking assistant. Given a CLAIM and a WIKIPEDIA EXCERPT, determine " +
        "whether the excerpt SUPPORTS, CONTRADICTS, or does not address (UNVERIFIABLE) the " +
        'claim. Respond ONLY as JSON: {"verdict":"SUPPORTED"|"CONTRADICTED"|"UNVERIFIABLE",' +
        '"explanation":"one sentence"}.',
        `CLAIM: ${extraction.claim}\n\nWIKIPEDIA EXCERPT (${article.title}): ${article.extract}`
      );
      if (!judged?.verdict) {
        patch({ status:"done", verdict:"ERROR", claim:extraction.claim, title:article.title,
          explanation:"Fact-check judge call failed to return a verdict." });
        return;
      }

      patch({ status:"done", verdict:judged.verdict.toUpperCase(), claim:extraction.claim,
        title:article.title, explanation:judged.explanation ?? "" });
    } catch(e) {
      patch({ status:"done", verdict:"ERROR", explanation:`Fact-check failed: ${e.message}` });
    }
  };

  // ── Load a Wikipedia article into the KB
  const addArticle = async (rawTitle) => {
    const t = (rawTitle || wikiInput).trim();
    if (!t) return;
    if (kb.find(a => a.title.toLowerCase() === t.toLowerCase())) { setWikiError("Already loaded."); return; }
    setWikiLoading(true); setWikiError(null);
    try {
      const article = await fetchWikipedia(t);
      setKb(prev => [...prev, article]);
      setWikiInput("");
    } catch(e) { setWikiError(e.message); }
    finally    { setWikiLoading(false); }
  };

  // ── Clear the conversation, keep the loaded KB
  // Retrying a question after adding a KB article mid-conversation can still
  // get the old wrong answer: the system prompt rebuilds with the new article
  // every turn, but the model also sees its own prior (wrong) answer still
  // sitting in the visible history and tends to anchor on it rather than
  // reconsider. This clears that history without making you reload the page
  // and re-load every KB article from scratch.
  const clearSession = () => {
    setChatMsgs([]);
    setApiHistory([]);
    setToolLog([]);
    setIsDeferring(false);
  };

  // ── Main send/agent loop
  // textOverride lets the retry button re-ask a past question without touching
  // the input field — everything else about the turn behaves identically.
  const sendMessage = async (textOverride) => {
    const userText = (textOverride ?? input).trim();
    if (!userText || isThinking) return;
    if (textOverride === undefined) setInput("");
    setIsThinking(true); setIsDeferring(false); setThinkLabel("Thinking…");
    setChatMsgs(prev => [...prev, { role:"user", content:userText }]);
    let hist = [...apiHistory, { role:"user", content:userText }];
    const newTools = [];
    let finalData  = null;

    for (let iter = 0; iter < 6; iter++) {
      let data;
      try {
        const res = await fetch(API_URL, {
          method:"POST", headers:{"Content-Type":"application/json"},
          body: JSON.stringify({ model:MODEL_NAME, max_tokens:1000,
            messages: [{ role:"system", content:buildSystemPrompt(kb) }, ...hist],
            tools: TOOLS_DEF })
        });
        data = await res.json();
      } catch(e) {
        setChatMsgs(prev => [...prev, { role:"assistant", content:`Network error: ${e.message}`, confidence:null }]);
        setIsThinking(false); return;
      }

      const choice = data.choices?.[0];
      if (choice?.finish_reason === "tool_calls") {
        hist = [...hist, choice.message];
        for (const call of choice.message.tool_calls ?? []) {
          const input = JSON.parse(call.function.arguments);
          setThinkLabel(`Calling ${call.function.name}…`);
          const result = await executeTool(call.function.name, input);
          newTools.push({ name:call.function.name, input, result });
          hist.push({ role:"tool", tool_call_id:call.id, content:JSON.stringify(result) });
        }
        setThinkLabel("Thinking…");
      } else {
        finalData = data;
        hist = [...hist, choice.message];
        break;
      }
    }

    if (!finalData) {
      setChatMsgs(prev => [...prev, { role:"assistant", content:"No response.", confidence:null }]);
      setIsThinking(false); return;
    }

    const raw   = finalData.choices[0].message.content ?? "";
    const confM = raw.match(/\[CONFIDENCE:\s*(LOW|MID|HIGH)\]/i);
    const srcM  = raw.match(/\[SOURCE:\s*(KB|TRAINING|TOOLS)\]/i);
    const conf  = confM ? confM[1].toUpperCase() : null;
    const src   = srcM  ? srcM[1].toUpperCase() : null;
    const clean = raw
      .replace(/\[CONFIDENCE:[^\]]+\]\s*/gi, "")
      .replace(/\[SOURCE:[^\]]+\]\s*/gi, "")
      .trim();
    const logprobConf = typeof finalData.logprob_confidence === "number" ? finalData.logprob_confidence : null;
    const defer = conf === "LOW";
    // Fact-check whenever self-report is LOW, the answer is ungrounded (TRAINING), or the
    // answer claims KB grounding — the last one closes a real gap: a model can claim
    // SOURCE=KB while still contradicting the very article it claims to have used (observed
    // directly: claimed KB grounding, named Jágr instead of Gretzky for the NHL points
    // record). TOOLS stays excluded — live API results aren't Wikipedia-checkable claims.
    const shouldFactCheck = conf === "LOW" || src === "TRAINING" || src === "KB";

    setIsDeferring(defer);
    setToolLog(prev => [...prev, ...newTools]);
    setApiHistory(hist);
    const msgId = nextMsgId.current++;
    setChatMsgs(prev => [...prev, { id:msgId, role:"assistant", content:clean, confidence:conf, logprobConfidence:logprobConf, source:src, deferring:defer }]);
    if (shouldFactCheck) runFactCheck(userText, clean, msgId, src);
    setIsThinking(false);
    inputRef.current?.focus();
  };

  // ── Hallucination risk: average per-turn confidence into one aggregate
  // score for the whole conversation, recomputed only when the transcript changes.
  const riskStats = useMemo(() => {
    const confs = chatMsgs.filter(m => m.role==="assistant").map(turnConfidence).filter(c => c!=null);
    if (confs.length === 0) return null;
    const avgConf = confs.reduce((a,b) => a+b, 0) / confs.length;
    const flags = chatMsgs.filter(m =>
      m.factCheck?.verdict==="CONTRADICTED" || m.factCheck?.verdict==="NO_ARTICLE").length;
    return { score: 1-avgConf, n: confs.length, flags };
  }, [chatMsgs]);

  // ── Render helpers
  const tabBtn  = (id, label) => ({
    flex:1, background:"transparent", border:"none",
    borderBottom: tab===id ? `2px solid ${ACCENT}` : "2px solid transparent",
    color: tab===id ? TEXT : MUTED,
    padding:"10px 0", fontSize:11, fontFamily:"monospace",
    letterSpacing:"0.1em", cursor:"pointer"
  });

  return (
    <div style={{ background:BG, height:"100vh", color:TEXT, fontFamily:"system-ui,sans-serif",
      display:"flex", flexDirection:"column", overflow:"hidden" }}>

      {/* ── Header — the red line, like centre ice ── */}
      <div style={{ borderBottom:`2px solid ${RINK_RED}`, padding:"10px 20px",
        display:"flex", alignItems:"center", gap:10, flexShrink:0 }}>
        <div style={{ width:7, height:7, borderRadius:"50%",
          background: isDeferring?"#dc2626":"#16a34a",
          boxShadow:`0 0 7px ${isDeferring?"#dc2626":"#16a34a"}` }}/>
        <span style={{ fontFamily:"monospace", fontSize:14, color:WORDMARK_RED, letterSpacing:"0.12em", fontWeight:700 }}>PUCK</span>
        <span style={{ fontSize:14, color:MUTED }}>/ Power Plays, Uncertainty, Confidence & Knowledge</span>
        {kb.length > 0 && (
          <span style={{ marginLeft:8, fontFamily:"monospace", fontSize:12,
            background:ACCENT_BG, color:ACCENT, padding:"2px 8px", borderRadius:4 }}>
            📚 {kb.length} article{kb.length!==1?"s":""} loaded
          </span>
        )}
        <button onClick={clearSession} disabled={chatMsgs.length===0}
          title="Clear the conversation, keep loaded KB articles"
          style={{ marginLeft:"auto", background:"transparent", border:`1px solid ${BORDER}`,
            borderRadius:6, padding:"4px 10px", fontFamily:"monospace", fontSize:11,
            color: chatMsgs.length===0 ? FAINT : MUTED,
            cursor: chatMsgs.length===0 ? "not-allowed" : "pointer" }}>
          ↺ Clear session
        </button>
        <span style={{ fontFamily:"monospace", fontSize:12, color:FAINT }}>v0.2 · hockey</span>
      </div>

      {/* ── Body ── */}
      <div style={{ display:"flex", flex:1, overflow:"hidden", minHeight:0 }}>

        {/* ── Left: Interview chat — the blue line, like the zone divider ── */}
        <div style={{ flex:"0 0 60%", display:"flex", flexDirection:"column", borderRight:`2px solid ${RINK_BLUE}` }}>

          {/* Messages */}
          <div ref={chatRef} style={{ flex:1, overflowY:"auto", padding:"20px 24px",
            display:"flex", flexDirection:"column", gap:18 }}>
            {chatMsgs.length === 0 && (
              <div style={{ textAlign:"center", color:FAINT, fontFamily:"monospace", fontSize:14, marginTop:48 }}>
                <div style={{ fontSize:32, marginBottom:10, opacity:0.4 }}>◎</div>
                <div>Load hockey articles in the KNOWLEDGE tab, then begin the interview.</div>
                <div style={{ marginTop:6, fontSize:13, color:FAINT }}>
                  Try: "Who was Gretzky?" · "Explain icing" · "When did the Leafs last win the Cup?"
                </div>
              </div>
            )}

            {chatMsgs.map((m,i) => (
              <div key={i} style={{ display:"flex", flexDirection:"column", gap:4,
                alignItems: m.role==="user" ? "flex-end" : "flex-start" }}>
                <div style={{ display:"flex", alignItems:"center", gap:8 }}>
                  {m.role==="user" && (
                    <button onClick={() => sendMessage(m.content)} disabled={isThinking}
                      title="Re-ask this exact question as a new turn — the original stays put"
                      style={{ background:"transparent", border:"none", padding:0,
                        fontFamily:"monospace", fontSize:11, letterSpacing:"0.05em",
                        color:isThinking?BORDER:MUTED, cursor:isThinking?"not-allowed":"pointer" }}>
                      ↻ retry
                    </button>
                  )}
                  <div style={{ fontSize:11, fontFamily:"monospace", color:FAINT, letterSpacing:"0.12em" }}>
                    {m.role==="user" ? "INTERVIEWER" : "PUCK"}
                  </div>
                </div>
                <div style={{
                  maxWidth:"88%", padding:"12px 16px", borderRadius:8, fontSize:16, lineHeight:1.7,
                  background: m.role==="user" ? SURF : m.deferring ? "rgba(220,38,38,0.08)" : CARD_TINT,
                  border:`1px solid ${m.role==="assistant"&&m.deferring ? "rgba(220,38,38,0.35)" : BORDER}`,
                  color:TEXT
                }}>
                  {m.deferring && (
                    <div style={{ fontFamily:"monospace", fontSize:11, color:"#dc2626",
                      marginBottom:8, letterSpacing:"0.1em" }}>
                      ⚠ DEFERRING TO HUMAN — self-reported confidence is LOW
                    </div>
                  )}
                  <div style={{ whiteSpace:"pre-wrap" }}>{m.content}</div>
                  {m.confidence != null && (
                    <div style={{ marginTop:10, paddingTop:8, borderTop:`1px solid ${BORDER}`,
                      display:"flex", alignItems:"center", gap:8 }}>
                      <span style={{ fontFamily:"monospace", fontSize:11, color:MUTED, minWidth:66 }}
                        title="Verbalized confidence: the model's own self-reported [CONFIDENCE] tag.">
                        self-report
                      </span>
                      <span style={{ fontFamily:"monospace", fontSize:13,
                        color:bucketColor(m.confidence), minWidth:34 }}>
                        {m.confidence}
                      </span>
                      <BucketBar bucket={m.confidence}/>
                      {m.source && (
                        <span style={{ fontFamily:"monospace", fontSize:11,
                          color:srcColor(m.source), whiteSpace:"nowrap" }}>
                          {srcBadge(m.source)}
                        </span>
                      )}
                    </div>
                  )}
                  {m.logprobConfidence != null && (() => {
                    const lb = bucketize(m.logprobConfidence);
                    return (
                      <div style={{ marginTop:6, display:"flex", alignItems:"center", gap:8 }}>
                        <span style={{ fontFamily:"monospace", fontSize:11, color:MUTED, minWidth:66 }}
                          title={`Logprob confidence: exp(avg token logprob) over the answer span (${(m.logprobConfidence*100).toFixed(0)}%), bucketed the same way as the self-report.`}>
                          logprob
                        </span>
                        <span style={{ fontFamily:"monospace", fontSize:13,
                          color:bucketColor(lb), minWidth:34 }}>
                          {lb}
                        </span>
                        <BucketBar bucket={lb}/>
                        {m.confidence != null && m.confidence !== lb && (
                          <span style={{ fontFamily:"monospace", fontSize:11, color:"#b45309", whiteSpace:"nowrap" }}
                            title="The model's self-reported bucket and the logprob-derived bucket don't match.">
                            ⚠ vs self-report
                          </span>
                        )}
                      </div>
                    );
                  })()}
                  {m.factCheck && (
                    <div style={{ marginTop:6, fontFamily:"monospace", fontSize:11, lineHeight:1.6 }}>
                      {m.factCheck.status === "checking" ? (
                        <span style={{ color:MUTED }}>
                          🔍 checking against {m.factCheck.groundedIn==="KB" ? "your loaded KB" : "Wikipedia"}…
                        </span>
                      ) : (
                        <>
                          <div style={{ color:
                            m.factCheck.verdict==="SUPPORTED" ? "#16a34a" :
                            m.factCheck.verdict==="CONTRADICTED" ? "#dc2626" :
                            m.factCheck.verdict==="NO_ARTICLE" ? "#b45309" : MUTED }}>
                            {m.factCheck.verdict==="SUPPORTED" ? "✓ fact-check: supported" :
                             m.factCheck.verdict==="CONTRADICTED" ? `✗ fact-check: contradicted — ${m.factCheck.explanation}` :
                             m.factCheck.verdict==="NO_ARTICLE" ? "⚠ fact-check: no Wikipedia article for this name — possible fabrication" :
                             `? fact-check: ${m.factCheck.explanation || "inconclusive"}`}
                          </div>
                          <div style={{ color:MUTED, marginTop:2 }}>
                            {m.factCheck.verdict==="NO_ARTICLE" ? (
                              <span title={m.factCheck.claim}>
                                searched for "{m.factCheck.title}" on Wikipedia — no matching article exists
                              </span>
                            ) : m.factCheck.groundedIn==="KB" ? (
                              m.factCheck.title ? (
                                <span title={m.factCheck.claim}>
                                  checked against your loaded KB:{" "}
                                  {m.factCheck.title.includes(",") ? (
                                    m.factCheck.title
                                  ) : (
                                    <a href={`https://en.wikipedia.org/wiki/${encodeURIComponent(m.factCheck.title.replace(/ /g,"_"))}`}
                                      target="_blank" rel="noreferrer" style={{ color:ACCENT }}>
                                      {m.factCheck.title}
                                    </a>
                                  )}
                                </span>
                              ) : (
                                <span title={m.factCheck.claim}>{m.factCheck.explanation}</span>
                              )
                            ) : m.factCheck.title ? (
                              <>
                                checked against{" "}
                                <a href={`https://en.wikipedia.org/wiki/${encodeURIComponent(m.factCheck.title.replace(/ /g,"_"))}`}
                                  target="_blank" rel="noreferrer" title={m.factCheck.claim}
                                  style={{ color:ACCENT }}>
                                  {m.factCheck.title}
                                </a>
                                {" "}· freshly fetched, not your loaded KB
                              </>
                            ) : (
                              "no Wikipedia article identified to check"
                            )}
                          </div>
                        </>
                      )}
                    </div>
                  )}
                </div>
              </div>
            ))}

            {isThinking && (
              <div style={{ display:"flex", flexDirection:"column", gap:4 }}>
                <div style={{ fontSize:11, fontFamily:"monospace", color:FAINT }}>PUCK</div>
                <div style={{ padding:"11px 16px", background:CARD_TINT, borderRadius:8,
                  border:`1px solid ${BORDER}`, fontFamily:"monospace", fontSize:14, color:MUTED }}>
                  {thinkLabel}
                </div>
              </div>
            )}
          </div>

          {/* Input bar */}
          <div style={{ borderTop:`1px solid ${BORDER}`, padding:"14px 20px",
            display:"flex", gap:10, flexShrink:0, background:BG }}>
            <input
              ref={inputRef} value={input} disabled={isThinking}
              onChange={e => setInput(e.target.value)}
              onKeyDown={e => e.key==="Enter" && !e.shiftKey && sendMessage()}
              placeholder="Ask PUCK something…"
              style={{ flex:1, background:SURF, border:`1px solid ${BORDER}`, borderRadius:6,
                color:TEXT, padding:"10px 14px", fontSize:16, outline:"none" }}
            />
            <button onClick={() => sendMessage()} disabled={isThinking||!input.trim()}
              style={{ background:isThinking||!input.trim()?SURF:"#2e3d5c",
                border:`1px solid ${BORDER}`, borderRadius:6,
                color:isThinking||!input.trim()?MUTED:TEXT,
                padding:"10px 18px", fontSize:14, fontFamily:"monospace",
                cursor:isThinking||!input.trim()?"not-allowed":"pointer" }}>
              {isThinking ? "…" : "Send →"}
            </button>
          </div>
        </div>

        {/* ── Right: Internals ── */}
        <div style={{ flex:"0 0 40%", display:"flex", flexDirection:"column", overflow:"hidden" }}>

          {/* Tab bar */}
          <div style={{ display:"flex", borderBottom:`1px solid ${BORDER}`, flexShrink:0 }}>
            <button style={tabBtn("signal","SIGNAL")}    onClick={()=>setTab("signal")}>SIGNAL</button>
            <button style={tabBtn("knowledge","KB")}     onClick={()=>setTab("knowledge")}>
              {`KNOWLEDGE${kb.length>0?` (${kb.length})`:""}`}
            </button>
            <button style={tabBtn("tools","TOOLS")}      onClick={()=>setTab("tools")}>
              {`TOOLS${toolLog.length>0?` (${toolLog.length})`:""}`}
            </button>
          </div>

          {/* ── SIGNAL tab ── */}
          {tab==="signal" && (
            <div style={{ flex:1, overflowY:"auto", padding:"18px 20px" }}>
              <div style={{ fontSize:11, fontFamily:"monospace", color:MUTED,
                letterSpacing:"0.13em", marginBottom:12 }}>HALLUCINATION RISK</div>

              <HallucinationMeter score={riskStats?.score ?? null} n={riskStats?.n ?? 0} flags={riskStats?.flags ?? 0}/>

              <div style={{ display:"flex", justifyContent:"center", gap:14, marginTop:14, marginBottom:8 }}>
                {RISK_ZONES.map(z => (
                  <div key={z.label} style={{ display:"flex", alignItems:"center", gap:5 }}>
                    <div style={{ width:7, height:7, borderRadius:2, background:z.color }}/>
                    <span style={{ fontFamily:"monospace", fontSize:10, color:MUTED }}>{z.label.toLowerCase()}</span>
                  </div>
                ))}
              </div>
              <div style={{ marginBottom:24, textAlign:"center" }}>
                <span style={{ fontFamily:"monospace", fontSize:11, color:FAINT }}>
                  self-report + logprob + fact-checks, averaged across the conversation
                </span>
              </div>

              {/* Source legend */}
              <div style={{ marginTop:24, paddingTop:16, borderTop:`1px solid ${BORDER}` }}>
                <div style={{ fontSize:11, fontFamily:"monospace", color:MUTED,
                  letterSpacing:"0.13em", marginBottom:10 }}>SOURCE LEGEND</div>
                {[["KB",ACCENT,"Knowledge Base article"],
                  ["TRAINING",TRAINING_PURPLE,"General training memory"],
                  ["TOOLS","#b45309","Live tool call"]].map(([s,c,d]) => (
                  <div key={s} style={{ display:"flex", alignItems:"center", gap:8, marginBottom:6 }}>
                    <span style={{ fontFamily:"monospace", fontSize:12, color:c, minWidth:66 }}>◈ {s}</span>
                    <span style={{ fontSize:13, color:MUTED }}>{d}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* ── KNOWLEDGE tab ── */}
          {tab==="knowledge" && (
            <div style={{ flex:1, overflowY:"auto", padding:"16px 20px",
              display:"flex", flexDirection:"column", gap:14 }}>

              <div style={{ fontSize:11, fontFamily:"monospace", color:MUTED, letterSpacing:"0.13em" }}>
                LOAD WIKIPEDIA ARTICLES
              </div>

              <div style={{ display:"flex", gap:8 }}>
                <input value={wikiInput} disabled={wikiLoading}
                  onChange={e => { setWikiInput(e.target.value); setWikiError(null); }}
                  onKeyDown={e => e.key==="Enter" && addArticle(wikiInput)}
                  placeholder="Article title (e.g. Wayne Gretzky)…"
                  style={{ flex:1, background:SURF, border:`1px solid ${BORDER}`, borderRadius:6,
                    color:TEXT, padding:"8px 12px", fontSize:14, outline:"none" }}/>
                <button onClick={() => addArticle(wikiInput)}
                  disabled={wikiLoading||!wikiInput.trim()}
                  style={{ background:ACCENT_BG, border:`1px solid ${ACCENT}`, borderRadius:6,
                    color:ACCENT, padding:"8px 14px", fontSize:13, fontFamily:"monospace",
                    cursor: wikiLoading||!wikiInput.trim()?"not-allowed":"pointer",
                    opacity: wikiLoading||!wikiInput.trim()?0.5:1 }}>
                  {wikiLoading ? "…" : "Load"}
                </button>
              </div>

              {wikiError && (
                <div style={{ fontFamily:"monospace", fontSize:13, color:"#dc2626" }}>{wikiError}</div>
              )}

              {/* Suggestion chips */}
              <div>
                <div style={{ fontSize:11, fontFamily:"monospace", color:FAINT,
                  letterSpacing:"0.1em", marginBottom:8 }}>SUGGESTED — HOCKEY</div>
                <div style={{ display:"flex", flexWrap:"wrap", gap:6 }}>
                  {HOCKEY_CHIPS.map(s => {
                    const loaded = kb.find(a => a.title.toLowerCase() === s.toLowerCase());
                    return (
                      <button key={s} disabled={!!loaded||wikiLoading}
                        onClick={() => !loaded && addArticle(s)}
                        style={{ background: loaded?"#e6f7ea":SURF,
                          border:`1px solid ${loaded?"#16a34a":BORDER}`, borderRadius:20,
                          color: loaded?"#16a34a":MUTED, padding:"4px 10px",
                          fontSize:12, fontFamily:"monospace",
                          cursor: loaded?"default":"pointer" }}>
                        {loaded?"✓ ":""}{s}
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Loaded articles */}
              {kb.length > 0 ? (
                <div>
                  <div style={{ fontSize:11, fontFamily:"monospace", color:FAINT,
                    letterSpacing:"0.1em", marginBottom:8 }}>LOADED ({kb.length})</div>
                  {kb.map(a => (
                    <div key={a.title} style={{ background:SURF, border:`1px solid ${BORDER}`,
                      borderRadius:6, padding:"10px 12px", marginBottom:8 }}>
                      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start" }}>
                        <div>
                          <div style={{ fontFamily:"monospace", fontSize:13, color:ACCENT, marginBottom:2 }}>
                            {a.title}
                          </div>
                          <div style={{ fontFamily:"monospace", fontSize:11, color:FAINT }}>
                            {a.extract.length.toLocaleString()} chars · Wikipedia
                          </div>
                        </div>
                        <button onClick={() => setKb(prev => prev.filter(x => x.title!==a.title))}
                          style={{ background:"transparent", border:"none", color:MUTED,
                            cursor:"pointer", fontSize:18, padding:"0 4px", lineHeight:1 }}>×</button>
                      </div>
                      <div style={{ marginTop:8, fontSize:13, color:MUTED, lineHeight:1.5,
                        display:"-webkit-box", WebkitLineClamp:3,
                        WebkitBoxOrient:"vertical", overflow:"hidden" }}>
                        {a.extract}
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <div style={{ fontFamily:"monospace", fontSize:13, color:FAINT,
                  textAlign:"center", marginTop:16 }}>
                  No articles loaded yet. Click a chip above.
                </div>
              )}
            </div>
          )}

          {/* ── TOOLS tab ── */}
          {tab==="tools" && (
            <div style={{ flex:1, overflowY:"auto", padding:"16px 20px" }}>
              <div style={{ fontSize:11, fontFamily:"monospace", color:MUTED,
                letterSpacing:"0.13em", marginBottom:12 }}>TOOL CALLS</div>
              {toolLog.length === 0
                ? <div style={{ fontFamily:"monospace", fontSize:13, color:FAINT }}>No tool calls yet.</div>
                : toolLog.map((t,i) => (
                    <div key={i} style={{ marginBottom:16, borderLeft:"2px solid #b45309", paddingLeft:10 }}>
                      <div style={{ fontFamily:"monospace", fontSize:12, color:"#b45309", marginBottom:4 }}>
                        ⟶ {t.name}({Object.entries(t.input).map(([k,v]) => `${k}="${v}"`).join(", ")})
                      </div>
                      <div style={{ fontFamily:"monospace", fontSize:12, color:MUTED,
                        whiteSpace:"pre-wrap", lineHeight:1.5 }}>
                        {JSON.stringify(t.result, null, 2)}
                      </div>
                    </div>
                  ))
              }
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
