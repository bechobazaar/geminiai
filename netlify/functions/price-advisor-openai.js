// netlify/functions/price-advisor-web.js
// Node 18+ (Netlify) — global fetch available

const ok = (body, more = {}) => ({
  statusCode: 200,
  headers: {
    "content-type": "application/json",
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "content-type, x-plan",
    "access-control-allow-methods": "POST, OPTIONS",
    ...more,
  },
  body: JSON.stringify(body),
});

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return ok("");

  if (event.httpMethod !== "POST") {
    return { statusCode: 400, headers: { "content-type": "application/json" }, body: JSON.stringify({ error: "POST only" }) };
  }

  try {
    const { input = {} } = JSON.parse(event.body || "{}");

    // ---- ENV KEYS ----
    const OPENAI_API_KEY = process.env.OPENAI_API_KEY || event.headers["x-openai-key"] || "";
    const TAVILY_API_KEY = process.env.TAVILY_API_KEY || event.headers["x-tavily-key"] || "";
    if (!OPENAI_API_KEY) return ok({ error: "Missing OPENAI_API_KEY" });
    if (!TAVILY_API_KEY) return ok({ error: "Missing TAVILY_API_KEY" });

    // Plan header optional (free = 4o-mini; pro = 5-mini)
    const plan = (event.headers["x-plan"] || "free").toLowerCase();
    const model = plan === "pro" ? "gpt-5-mini" : "gpt-4o-mini";

    // ---------- 1) Web search (Tavily) ----------
    const q = buildQuery(input);
    const tavilyRes = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        api_key: TAVILY_API_KEY,
        query: q,
        include_answer: true,
        search_depth: "advanced",
        max_results: 8,
        include_domains: [
          "amazon.in","flipkart.com","reliancedigital.in","croma.com",
          "olx.in","quikr.com","facebook.com","91mobiles.com","gsmarena.com"
        ],
        include_images: false
      })
    }).then(r => r.json()).catch(() => ({}));

    const sources = Array.isArray(tavilyRes?.results) ? tavilyRes.results.map(r => ({
      title: r.title, url: r.url, snippet: r.snippet
    })) : [];

    // ---------- 2) Synthesis (OpenAI) ----------
    const system = [
      "You are a pricing advisor for an Indian classifieds marketplace.",
      "Use INR. Assume Indian market, locality demand if present.",
      "You MUST return strict JSON only (no prose / code fences)."
    ].join("\n");

    const user = [
      `Task: Estimate market band and three selling tiers (quick/fair/hold).`,
      `Item: ${input.category||""} · ${input.brand||""} ${input.model||""}`,
      `Location: ${input.city||""}, ${input.state||""}`,
      `Seller asking (₹): ${input.price||""}`,
      input.mobile ? `Mobile details: ${JSON.stringify(input.mobile)}` : "",
      "",
      "Recent web snapshots (titles + snippets). Use only as soft evidence:",
      JSON.stringify(sources.slice(0,8)),
      "",
      `Return JSON with keys:
{
  "ok": true,
  "market_price_low": number,
  "market_price_high": number,
  "price_tiers": { "quick_sale": number, "fair": number, "hold": number },
  "suggested_price": number,
  "confidence": "low|medium|high",
  "why": string,
  "signals": {
    "brand_strength": "low|med|high",
    "model_popularity": "low|med|high",
    "age_wear": "low|med|high",
    "local_demand": "low|med|high"
  },
  "old_vs_new": { "launch_mrp": number|null, "typical_used": number|null },
  "sources": [{ "title": string, "url": string }]
}
Rules:
- Keep price_tiers inside the market band unless strongly justified.
- quick_sale <= fair <= hold.
- If condition/warranty/accessories are strong → bias higher; if age/battery/damage poor → bias lower.
- sources: return 3–6 most relevant from given snapshots (title+url only).
`
    ].join("\n");

    const ai = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", "authorization": `Bearer ${OPENAI_API_KEY}` },
      body: JSON.stringify({
        model,
        temperature: 0.2,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user }
        ]
      })
    }).then(r => r.json());

    let jsonText = ai?.choices?.[0]?.message?.content || "";
    // Try to coerce to JSON if model adds any stray text
    jsonText = (jsonText || "").trim();
    const firstBrace = jsonText.indexOf("{");
    const lastBrace  = jsonText.lastIndexOf("}");
    if (firstBrace > -1 && lastBrace > firstBrace) jsonText = jsonText.slice(firstBrace, lastBrace + 1);

    let parsed;
    try { parsed = JSON.parse(jsonText); } catch { parsed = null; }

    if (!parsed || typeof parsed !== "object") {
      return ok({ error: "LLM parse error", raw: ai });
    }

    // Attach provider/meta
    return ok({ ok: true, provider: "openai+tavily", model, result: parsed });
  } catch (e) {
    return ok({ error: String(e?.message || e) });
  }
};

// Build a good India-focused query for phones (works for other cats too)
function buildQuery(input) {
  const { category="", brand="", model="", city="", state="", price="" } = input || {};
  const base = `${brand} ${model}`.trim();
  const loc  = [city, state, "India"].filter(Boolean).join(", ");
  if ((category||"").toLowerCase() === "mobiles") {
    return `used price ${base} ${loc} launch MRP used listings olx quikr amazon flipkart`;
  }
  return `used price ${category} ${base} ${loc} market price India`;
}
