/* netlify/functions/price-advisor-web.js
   - Directly callable from your front-end.
   - Robust CORS (OPTIONS + success + error paths).
   - Uses Tavily (optional) + OpenAI to produce market band + fair price.
*/

const ORIGINS = [
  "https://bechobazaar.com",
  "https://www.bechobazaar.com",
  "https://bechobazaarui.netlify.app",
  // "http://localhost:8888", // dev
];

function corsHeaders(event) {
  const reqOrigin = event.headers?.origin || "";
  const allow = ORIGINS.includes(reqOrigin);
  const h = {
    "Vary": "Origin",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-Plan",
    "Access-Control-Max-Age": "600",
  };
  if (allow) h["Access-Control-Allow-Origin"] = reqOrigin;
  return h;
}
const ok  = (event, body) => ({ statusCode: 200, headers: corsHeaders(event), body: JSON.stringify(body) });
const bad = (event, code, msg) => ({ statusCode: code, headers: corsHeaders(event), body: JSON.stringify({ error: msg }) });

const OPENAI_KEY  = process.env.OPENAI_API_KEY || "";
const TAVILY_KEY  = process.env.TAVILY_API_KEY || "";

async function tavilySearch(q) {
  if (!TAVILY_KEY) return { results: [], used: false };
  const r = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Tavily-API-Key": TAVILY_KEY },
    body: JSON.stringify({
      query: q,
      search_depth: "advanced",
      include_answer: false,
      include_images: false,
      max_results: 8,
      topic: "general",
      days: 365, // up to a year
      include_domains: [
        "amazon.in","flipkart.com","croma.com","relianceDigital.in","apple.com/in",
        "olx.in","quikr.com","91mobiles.com","smartprix.com","pricebaba.com",
        "facebook.com","x.com","gsmarena.com"
      ]
    })
  });
  if (!r.ok) return { results: [], used: true };
  const j = await r.json().catch(()=> ({}));
  const items = Array.isArray(j.results) ? j.results : [];
  return { results: items.map(x => ({
    title: x.title, url: x.url, snippet: x.content?.slice(0, 400) || ""
  })), used: true };
}

async function askOpenAI({ plan, input, web }) {
  const useModel = plan === "pro" ? "gpt-5-mini" : "gpt-4o-mini";
  const sys = `You are a price advisor for a classifieds marketplace in India.
Return concise JSON only, no prose. 
Fields:
- market_price_low (number, INR)
- market_price_high (number, INR)
- suggested_price (number, INR)  // fast sale, fair but realistic
- confidence ("low"|"medium"|"high")
- why (string, <= 400 chars)
- old_vs_new: { launch_mrp?: number, typical_used?: number }
- sources: [{title,url}]
Rules:
- If input lacks key details, still estimate from brand/model/category & city/state context.
- Prefer INR amounts rounded to nearest 100/500.
- Suggested price must be inside [low, high].
`;

  const user = {
    role: "user",
    content: [
      { type: "text", text:
`INPUT:
${JSON.stringify(input, null, 2)}

WEB_SNIPPETS:
${JSON.stringify(web?.results?.slice(0,6) || [], null, 2)}
` }
    ]
  };

  // Use Chat Completions for maximum compatibility
  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${OPENAI_KEY}` },
    body: JSON.stringify({
      model: useModel,
      messages: [
        { role: "system", content: sys },
        user
      ],
      temperature: 0.2
    })
  });

  if (!r.ok) {
    const t = await r.text().catch(()=> "");
    throw new Error(`OpenAI error: ${t || r.status}`);
  }

  const j = await r.json();
  const txt = j?.choices?.[0]?.message?.content || "{}";
  // Try to parse JSON from the model
  let parsed = {};
  try {
    // Accept plain JSON or fenced
    const m = txt.match(/```json([\s\S]*?)```/i);
    const raw = m ? m[1] : txt;
    parsed = JSON.parse(raw);
  } catch {
    // fallback: naive extraction
    parsed = { why: txt };
  }
  return { model: useModel, result: parsed };
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: corsHeaders(event), body: "" };
  if (event.httpMethod !== "POST") return bad(event, 400, "POST only");
  if (!OPENAI_KEY) return bad(event, 500, "OPENAI_API_KEY missing");

  try {
    const { input = {} } = JSON.parse(event.body || "{}");
    const plan = String(event.headers["x-plan"] || "free").toLowerCase();

    // 1) Normalize input (ensure strings)
    const data = {
      category: String(input.category || ""),
      brand: String(input.brand || ""),
      model: String(input.model || ""),
      city: String(input.city || ""),
      state: String(input.state || ""),
      price: String(input.price || "")
    };

    // 2) Build Tavily queries
    const qParts = [
      [data.brand, data.model].filter(Boolean).join(" "),
      data.category || "",
      "used price India"
    ].filter(Boolean).join(" ").trim();

    const qLaunch = [
      [data.brand, data.model].filter(Boolean).join(" "),
      "launch price India MRP"
    ].filter(Boolean).join(" ").trim();

    // 3) Tavily
    const [usedRes, launchRes] = await Promise.all([
      tavilySearch(qParts),
      tavilySearch(qLaunch)
    ]);

    // Merge web snippets, dedupe by url
    const byUrl = new Map();
    [...(usedRes.results||[]), ...(launchRes.results||[])]
      .forEach(x => { if (x?.url && !byUrl.has(x.url)) byUrl.set(x.url, x); });

    const web = { results: Array.from(byUrl.values()).slice(0, 10), used: usedRes.used || launchRes.used };

    // 4) Ask OpenAI
    const ans = await askOpenAI({ plan, input: data, web });

    // 5) Guardrails: enforce numeric & band logic
    const r = ans.result || {};
    const toN = v => (v==null || isNaN(Number(v))) ? null : Math.round(Number(v));
    let low = toN(r.market_price_low);
    let high = toN(r.market_price_high);
    let sug = toN(r.suggested_price);

    // basic repairs
    if (low && high && low > high) { const t = low; low = high; high = t; }
    if (!sug && low && high) sug = Math.round((low + high) / 2);
    if (sug && low && high) {
      if (sug < low) sug = low;
      if (sug > high) sug = high;
    }

    // build final
    const final = {
      ok: true,
      provider: "openai",
      model: ans.model,
      result: {
        market_price_low: low || null,
        market_price_high: high || null,
        suggested_price: sug || null,
        confidence: (r.confidence || "medium").toLowerCase(),
        why: r.why || "Estimated from brand/model category and web signals.",
        old_vs_new: {
          launch_mrp: toN(r?.old_vs_new?.launch_mrp),
          typical_used: toN(r?.old_vs_new?.typical_used)
        },
        sources: (r.sources || web.results || []).slice(0,6).map(s => ({
          title: s.title || "source",
          url: s.url
        }))
      }
    };

    return ok(event, final);

  } catch (e) {
    return bad(event, 400, String(e?.message || e));
  }
};
