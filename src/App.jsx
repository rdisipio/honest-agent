import { useState, useEffect, useRef } from "react";

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

  return `You are ARIA — an AI subject-matter expert agent. You are being interviewed for a Medium article about epistemic uncertainty in AI systems by a physicist-turned-ML-engineer.

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

// ── Wikipedia fetcher ────────────────────────────────────────────────────────
async function fetchWikipedia(title) {
  const slug = title.trim().replace(/\s+/g, "_");
  const url = `https://en.wikipedia.org/w/api.php?action=query&titles=${encodeURIComponent(slug)}&prop=extracts&exintro=true&explaintext=true&format=json&origin=*`;
  const data = await (await fetch(url)).json();
  const page = Object.values(data.query.pages)[0];
  if (page.missing !== undefined) throw new Error(`Article not found: "${title}"`);
  return { title: page.title, extract: page.extract.slice(0, 2800) };
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

// ── Confidence trace: dual-row bucket grid ───────────────────────────────────
// A line chart implies interpolation between points, which is misleading for
// discrete LOW/MID/HIGH buckets — a strip of coloured cells, one row per
// signal, makes turn-by-turn agreement/divergence easy to scan instead.
function ConfidenceTrace({ selfHist, logprobHist }) {
  const n = Math.max(selfHist.length, logprobHist.length);
  if (n < 1) return null;
  const cell = (bucket, key) => (
    <div key={key} title={bucket ?? "no data"} style={{ width:10, height:10, borderRadius:2,
      background: bucket ? bucketColor(bucket) : "#2a3248" }}/>
  );
  const row = (label, hist) => (
    <div style={{ display:"flex", alignItems:"center", gap:6 }}>
      <span style={{ fontFamily:"monospace", fontSize:8, color:MUTED, minWidth:44 }}>{label}</span>
      <div style={{ display:"flex", gap:3, flexWrap:"wrap" }}>
        {Array.from({ length:n }, (_,i) => cell(hist[i], `${label}${i}`))}
      </div>
    </div>
  );
  return (
    <div style={{ display:"flex", flexDirection:"column", gap:6 }}>
      {row("self", selfHist)}
      {row("logprob", logprobHist)}
    </div>
  );
}

// ── Confidence bucket helpers ────────────────────────────────────────────────
// Turns a raw logprob confidence (0-1) into the same LOW/MID/HIGH vocabulary the
// model uses for its self-report, so the two signals are directly comparable.
const bucketize   = p => p==null ? null : p<0.4 ? "LOW" : p<0.65 ? "MID" : "HIGH";
const bucketColor = b => b==null?"#6b7a99": b==="LOW"?"#ef4444": b==="MID"?"#f0a500":"#4ade80";
const bucketLabel = b => b==null?"—": b==="LOW"?"Low — deferring": b==="MID"?"Moderate":"High";
const srcColor  = s => s==="KB"?"#818cf8": s==="TOOLS"?"#f0a500":"#6b7a99";
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
const BG="#1a1f2e", SURF="#242937", BORDER="#2e3547", TEXT="#ddd8cc", MUTED="#6b7a99";

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
  const [currentConf, setCurrentConf] = useState(null);
  const [currentLogprobConf, setCurrentLogprobConf] = useState(null);
  const [selfHist,     setSelfHist]     = useState([]);
  const [logprobHist,  setLogprobHist]  = useState([]);
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
  const runFactCheck = async (question, answer, msgId) => {
    const patch = (factCheck) =>
      setChatMsgs(prev => prev.map(m => m.id===msgId ? { ...m, factCheck } : m));
    patch({ status:"checking" });

    try {
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
        article = await fetchWikipedia(extraction.title);
      } catch {
        patch({ status:"done", verdict:"UNVERIFIABLE", claim:extraction.claim, title:extraction.title,
          explanation:`No Wikipedia article found for "${extraction.title}".` });
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

  // ── Main send/agent loop
  const sendMessage = async () => {
    const userText = input.trim();
    if (!userText || isThinking) return;
    setInput(""); setIsThinking(true); setIsDeferring(false); setThinkLabel("Thinking…");
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
    const logprobBucket = bucketize(logprobConf);
    const defer = conf === "LOW";

    if (conf !== null) setSelfHist(prev => [...prev, conf]);
    if (logprobBucket !== null) setLogprobHist(prev => [...prev, logprobBucket]);
    setCurrentConf(conf); setCurrentLogprobConf(logprobConf); setIsDeferring(defer);
    setToolLog(prev => [...prev, ...newTools]);
    setApiHistory(hist);
    const msgId = nextMsgId.current++;
    setChatMsgs(prev => [...prev, { id:msgId, role:"assistant", content:clean, confidence:conf, logprobConfidence:logprobConf, source:src, deferring:defer }]);
    if (defer) runFactCheck(userText, clean, msgId);
    setIsThinking(false);
    inputRef.current?.focus();
  };

  // ── Render helpers
  const col     = bucketColor(currentConf);
  const tabBtn  = (id, label) => ({
    flex:1, background:"transparent", border:"none",
    borderBottom: tab===id ? "2px solid #818cf8" : "2px solid transparent",
    color: tab===id ? TEXT : MUTED,
    padding:"10px 0", fontSize:9, fontFamily:"monospace",
    letterSpacing:"0.1em", cursor:"pointer"
  });

  return (
    <div style={{ background:BG, height:"100vh", color:TEXT, fontFamily:"system-ui,sans-serif",
      display:"flex", flexDirection:"column", overflow:"hidden" }}>

      {/* ── Header ── */}
      <div style={{ borderBottom:`1px solid ${BORDER}`, padding:"10px 20px",
        display:"flex", alignItems:"center", gap:10, flexShrink:0 }}>
        <div style={{ width:7, height:7, borderRadius:"50%",
          background: isDeferring?"#ef4444":"#4ade80",
          boxShadow:`0 0 7px ${isDeferring?"#ef4444":"#4ade80"}` }}/>
        <span style={{ fontFamily:"monospace", fontSize:12, color:MUTED, letterSpacing:"0.12em" }}>ARIA</span>
        <span style={{ fontSize:12, color:MUTED }}>/ Abstaining Reasoning Intelligence Agent</span>
        {kb.length > 0 && (
          <span style={{ marginLeft:8, fontFamily:"monospace", fontSize:10,
            background:"#2d2050", color:"#818cf8", padding:"2px 8px", borderRadius:4 }}>
            📚 {kb.length} article{kb.length!==1?"s":""} loaded
          </span>
        )}
        <span style={{ marginLeft:"auto", fontFamily:"monospace", fontSize:10, color:BORDER }}>v0.2 · hockey</span>
      </div>

      {/* ── Body ── */}
      <div style={{ display:"flex", flex:1, overflow:"hidden", minHeight:0 }}>

        {/* ── Left: Interview chat ── */}
        <div style={{ flex:"0 0 60%", display:"flex", flexDirection:"column", borderRight:`1px solid ${BORDER}` }}>

          {/* Messages */}
          <div ref={chatRef} style={{ flex:1, overflowY:"auto", padding:"20px 24px",
            display:"flex", flexDirection:"column", gap:18 }}>
            {chatMsgs.length === 0 && (
              <div style={{ textAlign:"center", color:BORDER, fontFamily:"monospace", fontSize:12, marginTop:48 }}>
                <div style={{ fontSize:28, marginBottom:10, opacity:0.4 }}>◎</div>
                <div>Load hockey articles in the KNOWLEDGE tab, then begin the interview.</div>
                <div style={{ marginTop:6, fontSize:11, color:"#2a3248" }}>
                  Try: "Who was Gretzky?" · "Explain icing" · "When did the Leafs last win the Cup?"
                </div>
              </div>
            )}

            {chatMsgs.map((m,i) => (
              <div key={i} style={{ display:"flex", flexDirection:"column", gap:4,
                alignItems: m.role==="user" ? "flex-end" : "flex-start" }}>
                <div style={{ fontSize:9, fontFamily:"monospace", color:BORDER, letterSpacing:"0.12em" }}>
                  {m.role==="user" ? "INTERVIEWER" : "ARIA"}
                </div>
                <div style={{
                  maxWidth:"88%", padding:"12px 16px", borderRadius:8, fontSize:14, lineHeight:1.7,
                  background: m.role==="user" ? SURF : m.deferring ? "rgba(239,68,68,0.07)" : "#1f2636",
                  border:`1px solid ${m.role==="assistant"&&m.deferring ? "rgba(239,68,68,0.3)" : BORDER}`,
                  color:TEXT
                }}>
                  {m.deferring && (
                    <div style={{ fontFamily:"monospace", fontSize:9, color:"#ef4444",
                      marginBottom:8, letterSpacing:"0.1em" }}>
                      ⚠ DEFERRING TO HUMAN — self-reported confidence is LOW
                    </div>
                  )}
                  <div style={{ whiteSpace:"pre-wrap" }}>{m.content}</div>
                  {m.confidence != null && (
                    <div style={{ marginTop:10, paddingTop:8, borderTop:`1px solid ${BORDER}`,
                      display:"flex", alignItems:"center", gap:8 }}>
                      <span style={{ fontFamily:"monospace", fontSize:9, color:MUTED, minWidth:66 }}
                        title="Verbalized confidence: the model's own self-reported [CONFIDENCE] tag.">
                        self-report
                      </span>
                      <span style={{ fontFamily:"monospace", fontSize:11,
                        color:bucketColor(m.confidence), minWidth:34 }}>
                        {m.confidence}
                      </span>
                      <BucketBar bucket={m.confidence}/>
                      {m.source && (
                        <span style={{ fontFamily:"monospace", fontSize:9,
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
                        <span style={{ fontFamily:"monospace", fontSize:9, color:MUTED, minWidth:66 }}
                          title={`Logprob confidence: exp(avg token logprob) over the answer span (${(m.logprobConfidence*100).toFixed(0)}%), bucketed the same way as the self-report.`}>
                          logprob
                        </span>
                        <span style={{ fontFamily:"monospace", fontSize:11,
                          color:bucketColor(lb), minWidth:34 }}>
                          {lb}
                        </span>
                        <BucketBar bucket={lb}/>
                        {m.confidence != null && m.confidence !== lb && (
                          <span style={{ fontFamily:"monospace", fontSize:9, color:"#f0a500", whiteSpace:"nowrap" }}
                            title="The model's self-reported bucket and the logprob-derived bucket don't match.">
                            ⚠ vs self-report
                          </span>
                        )}
                      </div>
                    );
                  })()}
                  {m.factCheck && (
                    <div style={{ marginTop:6, fontFamily:"monospace", fontSize:9 }}>
                      {m.factCheck.status === "checking" ? (
                        <span style={{ color:MUTED }}>🔍 checking against Wikipedia…</span>
                      ) : m.factCheck.verdict === "SUPPORTED" ? (
                        <span style={{ color:"#4ade80" }}
                          title={m.factCheck.claim}>
                          ✓ Wikipedia ({m.factCheck.title}) — supported
                        </span>
                      ) : m.factCheck.verdict === "CONTRADICTED" ? (
                        <span style={{ color:"#ef4444" }}
                          title={m.factCheck.claim}>
                          ✗ Wikipedia contradicts ({m.factCheck.title}): {m.factCheck.explanation}
                        </span>
                      ) : (
                        <span style={{ color:MUTED }}
                          title={m.factCheck.claim}>
                          ? Wikipedia: {m.factCheck.explanation || "inconclusive"}
                        </span>
                      )}
                    </div>
                  )}
                </div>
              </div>
            ))}

            {isThinking && (
              <div style={{ display:"flex", flexDirection:"column", gap:4 }}>
                <div style={{ fontSize:9, fontFamily:"monospace", color:BORDER }}>ARIA</div>
                <div style={{ padding:"11px 16px", background:"#1f2636", borderRadius:8,
                  border:`1px solid ${BORDER}`, fontFamily:"monospace", fontSize:12, color:MUTED }}>
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
              placeholder="Ask ARIA something…"
              style={{ flex:1, background:SURF, border:`1px solid ${BORDER}`, borderRadius:6,
                color:TEXT, padding:"10px 14px", fontSize:14, outline:"none" }}
            />
            <button onClick={sendMessage} disabled={isThinking||!input.trim()}
              style={{ background:isThinking||!input.trim()?SURF:"#2e3d5c",
                border:`1px solid ${BORDER}`, borderRadius:6,
                color:isThinking||!input.trim()?MUTED:TEXT,
                padding:"10px 18px", fontSize:12, fontFamily:"monospace",
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
              <div style={{ fontSize:9, fontFamily:"monospace", color:MUTED,
                letterSpacing:"0.13em", marginBottom:12 }}>SELF-REPORTED CONFIDENCE</div>

              <div style={{ display:"flex", alignItems:"baseline", gap:10, marginBottom:10 }}>
                <span style={{ fontFamily:"monospace", fontSize:32, fontWeight:700,
                  color:col, lineHeight:1, transition:"color 0.4s" }}>
                  {currentConf ?? "—"}
                </span>
                <span style={{ fontFamily:"monospace", fontSize:10, color:col }}>
                  {bucketLabel(currentConf)}
                </span>
              </div>
              <BucketBar bucket={currentConf} size="lg"/>
              <div style={{ display:"flex", justifyContent:"space-between", marginTop:8, marginBottom:24 }}>
                <span style={{ fontFamily:"monospace", fontSize:10, color:"#f0a500" }}>
                  auto-defer on LOW
                </span>
                <span style={{ fontFamily:"monospace", fontSize:10, color:BORDER }}>n={selfHist.length}</span>
              </div>

              <div style={{ fontSize:9, fontFamily:"monospace", color:MUTED,
                letterSpacing:"0.13em", marginBottom:12 }}>LOGPROB CONFIDENCE</div>
              <div style={{ display:"flex", alignItems:"baseline", gap:10, marginBottom:10 }}>
                <span style={{ fontFamily:"monospace", fontSize:32, fontWeight:700,
                  color:bucketColor(bucketize(currentLogprobConf)), lineHeight:1 }}
                  title={currentLogprobConf!==null ? `${(currentLogprobConf*100).toFixed(0)}%` : undefined}>
                  {bucketize(currentLogprobConf) ?? "—"}
                </span>
                <span style={{ fontFamily:"monospace", fontSize:10, color:bucketColor(bucketize(currentLogprobConf)) }}>
                  {bucketLabel(bucketize(currentLogprobConf))}
                </span>
              </div>
              <BucketBar bucket={bucketize(currentLogprobConf)} size="lg"/>
              <div style={{ marginTop:8, marginBottom:24 }}>
                <span style={{ fontFamily:"monospace", fontSize:10, color:BORDER }}>
                  exp(avg logprob) over answer span
                </span>
              </div>

              <div style={{ fontSize:9, fontFamily:"monospace", color:MUTED,
                letterSpacing:"0.13em", marginBottom:8 }}>CONFIDENCE TRACE</div>
              {selfHist.length < 1
                ? <div style={{ fontFamily:"monospace", fontSize:11, color:BORDER }}>Accumulating data…</div>
                : <>
                    <ConfidenceTrace selfHist={selfHist} logprobHist={logprobHist}/>
                    <div style={{ display:"flex", gap:14, marginTop:10 }}>
                      {[["#ef4444","low"],["#f0a500","mid"],["#4ade80","high"]]
                        .map(([c,l]) => (
                          <div key={l} style={{ display:"flex", alignItems:"center", gap:5 }}>
                            <div style={{ width:7, height:7, borderRadius:2, background:c }}/>
                            <span style={{ fontFamily:"monospace", fontSize:9, color:MUTED }}>{l}</span>
                          </div>
                        ))}
                    </div>
                  </>
              }

              {/* Source legend */}
              <div style={{ marginTop:24, paddingTop:16, borderTop:`1px solid ${BORDER}` }}>
                <div style={{ fontSize:9, fontFamily:"monospace", color:MUTED,
                  letterSpacing:"0.13em", marginBottom:10 }}>SOURCE LEGEND</div>
                {[["KB","#818cf8","Knowledge Base article"],
                  ["TRAINING","#6b7a99","General training memory"],
                  ["TOOLS","#f0a500","Live tool call"]].map(([s,c,d]) => (
                  <div key={s} style={{ display:"flex", alignItems:"center", gap:8, marginBottom:6 }}>
                    <span style={{ fontFamily:"monospace", fontSize:10, color:c, minWidth:66 }}>◈ {s}</span>
                    <span style={{ fontSize:11, color:MUTED }}>{d}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* ── KNOWLEDGE tab ── */}
          {tab==="knowledge" && (
            <div style={{ flex:1, overflowY:"auto", padding:"16px 20px",
              display:"flex", flexDirection:"column", gap:14 }}>

              <div style={{ fontSize:9, fontFamily:"monospace", color:MUTED, letterSpacing:"0.13em" }}>
                LOAD WIKIPEDIA ARTICLES
              </div>

              <div style={{ display:"flex", gap:8 }}>
                <input value={wikiInput} disabled={wikiLoading}
                  onChange={e => { setWikiInput(e.target.value); setWikiError(null); }}
                  onKeyDown={e => e.key==="Enter" && addArticle(wikiInput)}
                  placeholder="Article title (e.g. Wayne Gretzky)…"
                  style={{ flex:1, background:SURF, border:`1px solid ${BORDER}`, borderRadius:6,
                    color:TEXT, padding:"8px 12px", fontSize:12, outline:"none" }}/>
                <button onClick={() => addArticle(wikiInput)}
                  disabled={wikiLoading||!wikiInput.trim()}
                  style={{ background:"#2d2050", border:"1px solid #818cf8", borderRadius:6,
                    color:"#818cf8", padding:"8px 14px", fontSize:11, fontFamily:"monospace",
                    cursor: wikiLoading||!wikiInput.trim()?"not-allowed":"pointer",
                    opacity: wikiLoading||!wikiInput.trim()?0.5:1 }}>
                  {wikiLoading ? "…" : "Load"}
                </button>
              </div>

              {wikiError && (
                <div style={{ fontFamily:"monospace", fontSize:11, color:"#ef4444" }}>{wikiError}</div>
              )}

              {/* Suggestion chips */}
              <div>
                <div style={{ fontSize:9, fontFamily:"monospace", color:BORDER,
                  letterSpacing:"0.1em", marginBottom:8 }}>SUGGESTED — HOCKEY</div>
                <div style={{ display:"flex", flexWrap:"wrap", gap:6 }}>
                  {HOCKEY_CHIPS.map(s => {
                    const loaded = kb.find(a => a.title.toLowerCase() === s.toLowerCase());
                    return (
                      <button key={s} disabled={!!loaded||wikiLoading}
                        onClick={() => !loaded && addArticle(s)}
                        style={{ background: loaded?"#1a2e1a":SURF,
                          border:`1px solid ${loaded?"#4ade80":BORDER}`, borderRadius:20,
                          color: loaded?"#4ade80":MUTED, padding:"4px 10px",
                          fontSize:10, fontFamily:"monospace",
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
                  <div style={{ fontSize:9, fontFamily:"monospace", color:BORDER,
                    letterSpacing:"0.1em", marginBottom:8 }}>LOADED ({kb.length})</div>
                  {kb.map(a => (
                    <div key={a.title} style={{ background:SURF, border:`1px solid ${BORDER}`,
                      borderRadius:6, padding:"10px 12px", marginBottom:8 }}>
                      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start" }}>
                        <div>
                          <div style={{ fontFamily:"monospace", fontSize:11, color:"#818cf8", marginBottom:2 }}>
                            {a.title}
                          </div>
                          <div style={{ fontFamily:"monospace", fontSize:9, color:BORDER }}>
                            {a.extract.length.toLocaleString()} chars · Wikipedia
                          </div>
                        </div>
                        <button onClick={() => setKb(prev => prev.filter(x => x.title!==a.title))}
                          style={{ background:"transparent", border:"none", color:MUTED,
                            cursor:"pointer", fontSize:16, padding:"0 4px", lineHeight:1 }}>×</button>
                      </div>
                      <div style={{ marginTop:8, fontSize:11, color:MUTED, lineHeight:1.5,
                        display:"-webkit-box", WebkitLineClamp:3,
                        WebkitBoxOrient:"vertical", overflow:"hidden" }}>
                        {a.extract}
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <div style={{ fontFamily:"monospace", fontSize:11, color:BORDER,
                  textAlign:"center", marginTop:16 }}>
                  No articles loaded yet. Click a chip above.
                </div>
              )}
            </div>
          )}

          {/* ── TOOLS tab ── */}
          {tab==="tools" && (
            <div style={{ flex:1, overflowY:"auto", padding:"16px 20px" }}>
              <div style={{ fontSize:9, fontFamily:"monospace", color:MUTED,
                letterSpacing:"0.13em", marginBottom:12 }}>TOOL CALLS</div>
              {toolLog.length === 0
                ? <div style={{ fontFamily:"monospace", fontSize:11, color:BORDER }}>No tool calls yet.</div>
                : toolLog.map((t,i) => (
                    <div key={i} style={{ marginBottom:16, borderLeft:"2px solid #f0a500", paddingLeft:10 }}>
                      <div style={{ fontFamily:"monospace", fontSize:10, color:"#f0a500", marginBottom:4 }}>
                        ⟶ {t.name}({Object.entries(t.input).map(([k,v]) => `${k}="${v}"`).join(", ")})
                      </div>
                      <div style={{ fontFamily:"monospace", fontSize:10, color:MUTED,
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
