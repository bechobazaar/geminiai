// netlify/functions/price-advisor-openai.js

const OPENAI_URL = "https://api.openai.com/v1/responses";
const DEFAULT_MODEL_FREE = "gpt-4o-mini";
const DEFAULT_MODEL_PRO  = "gpt-5-mini";
const DEFAULT_MODEL_VIP  = "gpt-5";

function corsHeaders(origin = "*") {
  return {
    "Access-Control-Allow-Origin": origin || "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-Plan, X-OpenAI-Model, X-OpenAI-Key",
    "Vary": "Origin",
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  };
}
const ok  = (body, C) => ({ statusCode: 200, headers: C, body: JSON.stringify(body) });
const bad = (msg, C, code = 400) => ({ statusCode: code, headers: C, body: JSON.stringify({ error: String(msg) }) });

function buildPrompts(input) {
  const { category="", brand="", model="", city="", state="", price="" } = input || {};
  const system = [
    "You are a pricing advisor for an Indian classifieds marketplace.",
    "Return ONLY JSON (no prose, no code fences).",
    "Use rupees and Indian numbering (thousand, lakh, crore).",
    "If details are missing, make reasonable assumptions and set confidence low."
  ].join("\n");

  const user = [
    "Make a fair-market price analysis for this listing:",
    `Category: ${category}`,
    `Brand: ${brand}`,
    `Model: ${model}`,
    `City: ${city}`,
    `State: ${state}`,
    `Asking Price (₹): ${price}`,
    "",
    "JSON schema to produce (keys in snake_case):",
    `{
      "ok": true,
      "market_price_low": number,
      "market_price_high": number,
      "suggested_price": number,
      "confidence": "low|medium|high",
      "why": string,
      "signals": {
        "brand_strength": "low|med|high",
        "model_popularity": "low|med|high",
        "age_wear": "low|med|high",
        "local_demand": "low|med|high"
      },
      "old_vs_new": {
        "launch_mrp": number|null,
        "typical_used": number|null
      }
    }`
  ].join("\n");

  return { system, user };
}

async function callOpenAI({ key, model, system, user }) {
  const payload = {
    model,
    input: [
      { role: "system", content: system },
      { role: "user",   content: user   }
    ],
    temperature: 0.2,
    max_output_tokens: 800
  };

  const resp = await fetch(OPENAI_URL, {
    method: "POST",
    headers: { "content-type": "application/json", "authorization": `Bearer ${key}` },
    body: JSON.stringify(payload)
  });

  const data = await resp.json().catch(() => ({}));
  return { ok: resp.ok, status: resp.status, data };
}

function extractTextFromResponses(json) {
  try {
    const out = json?.output || [];
    if (Array.isArray(out) && out[0]?.content?.length) {
      return out[0].content.map(p => p?.text || "").join("\n").trim();
    }
    const choice = json?.choices?.[0]?.message?.content;
    if (choice) return String(choice);
  } catch {}
  return "";
}

// strip ```json fences & cut to first {...}
function coerceJsonString(s = "") {
  let t = String(s).trim();
  t = t.replace(/```json|```/gi, "");
  const a = t.indexOf("{"), b = t.lastIndexOf("}");
  if (a !== -1 && b !== -1 && b > a) t = t.slice(a, b + 1);
  t = t.replace(/[\u201C\u201D]/g, '"').replace(/[\u2018\u2019]/g, "'");
  return t;
}

function pickModelFromPlan(planHdr, explicitHeaderModel) {
  if (explicitHeaderModel) return explicitHeaderModel;
  const plan = String(planHdr || "").toLowerCase();
  if (plan === "vip") return DEFAULT_MODEL_VIP;
  if (plan === "pro") return DEFAULT_MODEL_PRO;
  return DEFAULT_MODEL_FREE;
}

exports.handler = async (event) => {
  const origin = event.headers.origin || event.headers.Origin || "*";
  const C = corsHeaders(origin);

  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: C, body: "" };
  if (event.httpMethod !== "POST")   return bad("POST only", C, 405);

  try {
    const body = JSON.parse(event.body || "{}");
    const input = body?.input;
    if (!input) return bad("Missing 'input' object", C);

    const headerModel = event.headers["x-openai-model"] || event.headers["X-OpenAI-Model"];
    const planHdr     = event.headers["x-plan"]         || event.headers["X-Plan"];
    const model       = pickModelFromPlan(planHdr, headerModel);

    const OPENAI_KEY = (event.headers["x-openai-key"] || event.headers["X-OpenAI-Key"] || process.env.OPENAI_API_KEY || "").trim();
    if (!OPENAI_KEY) return bad("Missing OPENAI_API_KEY", C);

    const { system, user } = buildPrompts(input);
    const ans = await callOpenAI({ key: OPENAI_KEY, model, system, user });

    if (!ans.ok) {
      const emsg = ans?.data?.error?.message || JSON.stringify(ans.data || {});
      if (ans.status === 429 || /quota|exceeded|billing/i.test(emsg)) {
        return bad("OpenAI: quota/billing limit. Check usage or billing.", C, 429);
      }
      return bad(`OpenAI error: ${emsg}`, C, ans.status || 400);
    }

    const rawText = extractTextFromResponses(ans.data);
    const jsonStr = coerceJsonString(rawText);

    let parsed = null;
    try { parsed = JSON.parse(jsonStr); } catch(e) {
      return bad("Failed to parse JSON from model", C);
    }

    return ok({ ok: true, provider: "openai", model, result: parsed }, C);
  } catch (e) {
    return bad(e?.message || e, C, 500);
  }
};
