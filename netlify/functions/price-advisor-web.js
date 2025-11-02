// netlify/functions/price-advisor-web.js
// Node 18+ on Netlify: global fetch is available; do NOT import node-fetch.

const ALLOW_ORIGINS = [
  "https://bechobazaar.com",
  "https://www.bechobazaar.com",
  "https://bechobazaarui.netlify.app"
];

function corsHeaders(event) {
  const origin = event.headers?.origin || "";
  const h = {
    "Vary": "Origin",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-Plan",
    "Access-Control-Max-Age": "600",
  };
  if (ALLOW_ORIGINS.includes(origin)) h["Access-Control-Allow-Origin"] = origin;
  return h;
}

function ok(body, event) {
  return { statusCode: 200, headers: corsHeaders(event), body: JSON.stringify(body) };
}
function bad(status, msg, event) {
  return { statusCode: status, headers: corsHeaders(event), body: JSON.stringify({ error: msg }) };
}

async function tavilySearch(q) {
  const key = process.env.TAVILY_API_KEY;
  if (!key) return [];
  try {
    const r = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": key },
      body: JSON.stringify({ query: q, include_answer: false, max_results: 5 })
    });
    if (!r.ok) return [];
    const j = await r.json();
    const hits = Array.isArray(j.results) ? j.results : [];
    return hits.map(x => ({
      title: x.title || "",
      url: x.url || "",
      snippet: x.content || x.snippet || ""
    }));
  } catch {
    return [];
  }
}

async function callOpenAI({ model, input, sources }) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error("OPENAI_API_KEY missing");

  const sys = [
    "You are a pricing analyst for a classifieds app in India.",
    "Return ONLY valid JSON. No markdown. Shape:",
    `{
      "suggested_price": number,
      "market_price_low": number,
      "market_price_high": number,
      "confidence": "low"|"medium"|"high",
      "why": string,
      "old_vs_new": { "launch_mrp": number|null, "typical_used": number|null },
      "sources": [ { "title": string, "url": string } ]
    }`,
    "Logic:",
    "- Use Indian market context and INR.",
    "- If brand/model present, bias to India (Flipkart/Amazon/OLX/Quikr references are fine).",
    "- If no web sources provided, still estimate with wider band and set confidence lower.",
    "- Suggested price should be inside the band and biased towards quick sale (10–15% below median if needed)."
  ].join("\n");

  const user = {
    role: "user",
    content:
      JSON.stringify({
        input,
        web_snippets: (sources || []).map(s => ({
          title: s.title, url: s.url, snippet: (s.snippet || "").slice(0, 500)
        }))
      })
  };

  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "authorization": `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({
      model,
      temperature: 0.2,
      messages: [
        { role: "system", content: sys },
        user
      ]
    })
  });

  if (!r.ok) {
    const t = await r.text().catch(()=> "");
    throw new Error(`OpenAI error: ${t || r.statusText}`);
  }
  const j = await r.json();
  const text = j?.choices?.[0]?.message?.content || "{}";

  // Try to parse JSON only (strip accidental extra)
  const maybe = text.match(/\{[\s\S]*\}$/);
  let parsed;
  try { parsed = JSON.parse(maybe ? maybe[0] : text); }
  catch { parsed = {}; }
  return parsed;
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: corsHeaders(event), body: "" };
  }
  if (event.httpMethod !== "POST") {
    return bad(405, "POST only", event);
  }

  try {
    const { input } = JSON.parse(event.body || "{}");
    if (!input || !input.price || !input.category) {
      return bad(400, "input.category and input.price are required", event);
    }

    // Build a compact Tavily query
    const q = [
      input.brand, input.model, "used price", input.city || input.state || "India"
    ].filter(Boolean).join(" ");
    const sources = await tavilySearch(q);

    // Choose model
    const plan = (event.headers?.["x-plan"] || event.headers?.["X-Plan"] || "free").toLowerCase();
    const model = plan === "pro" ? "gpt-5-mini" : "gpt-4o-mini";

    const result = await callOpenAI({ model, input, sources });

    // Normalize a bit
    const num = (v)=> (typeof v === "number" && isFinite(v) ? Math.round(v) : null);
    const out = {
      ok: true,
      provider: "openai",
      model,
      result: {
        suggested_price: num(result.suggested_price),
        market_price_low: num(result.market_price_low),
        market_price_high: num(result.market_price_high),
        confidence: result.confidence || "medium",
        why: result.why || "",
        old_vs_new: {
          launch_mrp: num(result?.old_vs_new?.launch_mrp),
          typical_used: num(result?.old_vs_new?.typical_used)
        },
        sources: Array.isArray(result.sources) ? result.sources.slice(0,6).map(s=>({
          title: s.title || "",
          url: s.url || ""
        })) : []
      }
    };

    return ok(out, event);
  } catch (e) {
    return bad(400, String(e.message || e), event);
  }
};
