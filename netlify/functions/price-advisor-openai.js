// netlify/functions/price-advisor-openai.js

// ====== Config ======
const OPENAI_URL = "https://api.openai.com/v1/responses";
const DEFAULT_MODEL_FREE = "gpt-4o-mini";  // cheapest, good quality
const DEFAULT_MODEL_PRO  = "gpt-5-mini";   // better reasoning
const DEFAULT_MODEL_VIP  = "gpt-5";        // premium

// CORS helper (allow your domains only in prod if you want)
function corsHeaders(origin = "*") {
  return {
    "Access-Control-Allow-Origin": origin || "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-Plan, X-OpenAI-Model",
    "Vary": "Origin",
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  };
}

const ok = (body, C) => ({ statusCode: 200, headers: C, body: JSON.stringify(body) });
const bad = (msg, C, code = 400) =>
  ({ statusCode: code, headers: C, body: JSON.stringify({ error: String(msg) }) });

// ====== Prompt builder ======
function buildPrompts(input) {
  const {
    category = "", brand = "", model = "", city = "", state = "", price = ""
  } = input || {};

  const system = [
    "You are a pricing advisor for an Indian classifieds marketplace.",
    "You must return ONLY JSON that matches the required schema.",
    "Use Indian market context, Indian numbering and rupees.",
    "If info is missing, make reasonable assumptions and mark confidence low."
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
    "Return JSON with schema:",
    `{
      "ok": true,
      "market_price_low": number,     // ₹ lower bound
      "market_price_high": number,    // ₹ upper bound
      "suggested_price": number,      // ₹ single fair value
      "confidence": "low|medium|high",
      "why": string,                  // human explanation (concise)
      "signals": {                    // drivers used
        "brand_strength": "low|med|high",
        "model_popularity": "low|med|high",
        "age_wear": "low|med|high",
        "local_demand": "low|med|high"
      },
      "old_vs_new": {
        "launch_mrp": number|null,    // if relevant
        "typical_used": number|null
      }
    }`
  ].join("\n");

  return { system, user };
}

// ====== OpenAI call (Responses API) ======
async function callOpenAI({ key, model, system, user }) {
  const payload = {
    model,
    input: [
      { role: "system", content: system },
      { role: "user",   content: user   }
    ],
    // Ask for strict JSON output
    response_format: { type: "json_object" },
    max_output_tokens: 800,
    temperature: 0.2
  };

  const resp = await fetch(OPENAI_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "authorization": `Bearer ${key}`
    },
    body: JSON.stringify(payload)
  });

  const data = await resp.json().catch(() => ({}));
  return { ok: resp.ok, status: resp.status, data };
}

// Extract text from Responses API (assistant output)
function extractTextFromResponses(json) {
  try {
    // The Responses API returns output as an array of content parts.
    const firstOut = json?.output?.[0];
    if (firstOut?.content?.length) {
      const txt = firstOut.content
        .map(p => p?.text || "")
        .join("\n")
        .trim();
      return txt;
    }
    // Older/alt shapes fallback:
    const choice = json?.choices?.[0]?.message?.content;
    if (choice) return String(choice);
  } catch {}
  return "";
}

// simple model chooser by plan
function pickModelFromPlan(planHdr, explicitHeaderModel) {
  if (explicitHeaderModel) return explicitHeaderModel;
  const plan = String(planHdr || "").toLowerCase(); // "free"|"pro"|"vip"
  if (plan === "vip") return DEFAULT_MODEL_VIP;
  if (plan === "pro") return DEFAULT_MODEL_PRO;
  return DEFAULT_MODEL_FREE;
}

exports.handler = async (event) => {
  const origin = event.headers.origin || event.headers.Origin || "*";
  const C = corsHeaders(origin);

  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: C, body: "" };
  }
  if (event.httpMethod !== "POST") {
    return bad("POST only", C, 405);
  }

  try {
    const envKey = process.env.OPENAI_API_KEY || "";
    const body = JSON.parse(event.body || "{}");
    const input = body?.input || null;

    if (!input) return bad("Missing 'input' object", C);

    // Allow forcing a model via header (debug), else choose by plan
    const headerModel = event.headers["x-openai-model"] || event.headers["X-OpenAI-Model"];
    const planHdr = event.headers["x-plan"] || event.headers["X-Plan"];

    const model = pickModelFromPlan(planHdr, headerModel);

    // TEMP testing header (optional): x-openai-key
    const headerKey = event.headers["x-openai-key"] || event.headers["X-OpenAI-Key"];
    const OPENAI_KEY = headerKey || envKey;
    if (!OPENAI_KEY) return bad("Missing OPENAI_API_KEY", C);

    // Build prompts
    const { system, user } = buildPrompts(input);

    // Call OpenAI
    const ans = await callOpenAI({ key: OPENAI_KEY, model, system, user });

    if (!ans.ok) {
      const emsg = ans?.data?.error?.message || JSON.stringify(ans.data || {});
      // Friendly message for quota
      if (ans.status === 429 || /quota|exceeded|billing/i.test(emsg)) {
        return bad("OpenAI: quota/billing limit. Check usage or billing.", C, 429);
      }
      return bad(`OpenAI error: ${emsg}`, C, ans.status || 400);
    }

    // Extract & parse JSON
    const raw = extractTextFromResponses(ans.data);
    let parsed = null;
    try { parsed = JSON.parse(raw); } catch {}

    if (!parsed || typeof parsed !== "object") {
      return bad("Failed to parse JSON from model", C);
    }

    return ok({
      ok: true,
      provider: "openai",
      model,
      result: parsed
    }, C);
  } catch (e) {
    return bad(e?.message || e, C, 500);
  }
};
