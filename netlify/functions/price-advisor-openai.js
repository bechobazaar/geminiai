// netlify/functions/price-advisor-openai.js
// Node 18+ (built-in fetch). Uses OpenAI "responses" API.
// Returns structured market-price analysis JSON for your form.

const OPENAI_URL = "https://api.openai.com/v1/responses";

// Default model (you can switch to "gpt-5")
const DEFAULT_MODEL = "gpt-5-mini";

// --- CORS: allow only your sites (edit this list) ---
const ALLOWED = new Set([
  "https://bechobazaar.com",
  "https://www.bechobazaar.com",
  // add your new Netlify site domain here:
  "https://<YOUR-NEW-SITE>.netlify.app",
  // keep if you still test on the old one:
  "https://bechobazaarui.netlify.app"
]);

function corsHeaders(origin) {
  const allow = ALLOWED.has(origin) ? origin : "https://bechobazaar.com";
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, x-openai-key, x-openai-model",
    "Vary": "Origin"
  };
}

const ok  = (body, CORS) => ({ statusCode: 200, headers: CORS, body: JSON.stringify(body) });
const bad = (msg,  CORS) => ({ statusCode: 400, headers: CORS, body: JSON.stringify({ error: String(msg) }) });

// Extract text from Responses API
function extractText(respJson) {
  // try the most common shapes
  const t1 = respJson?.output?.[0]?.content?.[0]?.text;
  if (t1) return t1;
  if (respJson?.output_text) return respJson.output_text;
  try {
    const chunks = [];
    for (const msg of respJson?.output || []) {
      for (const part of msg?.content || []) {
        if (typeof part?.text === "string") chunks.push(part.text);
      }
    }
    if (chunks.length) return chunks.join("\n");
  } catch (_) {}
  return "";
}

function buildPrompts(input) {
  const {
    category, subCategory, sellerType, brand, model, title,
    state, city, area, price,
    kmDriven, yearOfPurchase, ownership,
    tyreCondition, accidentStatus, allPapersAvail,
    pollutionExpiry, taxExpiry, insuranceExpiry,
    propertyType, bhk, furnishing, facing, propertyArea, bedrooms, bathrooms,
    descPlain
  } = input;

  const userQuery = [
    title || `${brand || ""} ${model || ""}`.trim(),
    category, subCategory, propertyType, bhk,
    city, state, area,
    yearOfPurchase ? `year ${yearOfPurchase}` : "",
    kmDriven ? `${kmDriven} km` : "",
    ownership, tyreCondition, accidentStatus, allPapersAvail,
  ].filter(Boolean).join(" • ");

  const system = `
You are a price advisor for a classifieds marketplace in India.

Derive 5–10 recent comparable listings (same city/state preferred; else nearby/statewide) and any recent SOLD prices.
If web search is unavailable, use domain knowledge + heuristics. Always output ONLY valid JSON:

{
  "market_price": number,
  "price_band": { "low": number, "high": number },
  "suggestion": number,
  "confidence": "low" | "medium" | "high",
  "condition_note": string,
  "notes": string,
  "old_sold_samples": [
    { "title": string, "price": number, "location": string, "date": string, "url": string, "condition": string, "note": string }
  ]
}

Adjustments:
- Vehicles: New/Good tyres + no accidents + all papers + 1st owner => +5–10%;
  Minor accidents, worn tyres, 2nd/3rd owner, expiring/expired PUC/insurance => -5–15%.
- Mobiles/Electronics: age >2y / heavy wear => -10–20%; mint/boxed => +5–10%.
- Properties: consider ₹/sqft, locality comps, BHK, furnishing, facing.

Currency is INR. Return JSON only.`.trim();

  const user = `
Item: ${title || `${brand || ""} ${model || ""}`.trim()}
Category: ${category || ""}
Subcategory: ${subCategory || ""}
Brand: ${brand || ""}
Model: ${model || ""}
Seller Type: ${sellerType || ""}
Vehicle: year=${yearOfPurchase || ""}, km=${kmDriven || ""}, owner=${ownership || ""}, tyre=${tyreCondition || ""}, accident=${accidentStatus || ""}, papers=${allPapersAvail || ""}, PUC=${pollutionExpiry || ""}, tax=${taxExpiry || ""}, insurance=${insuranceExpiry || ""}
Property: type=${propertyType || ""}, bhk=${bhk || ""}, area_sqft=${propertyArea || ""}, facing=${facing || ""}, furnishing=${furnishing || ""}, beds=${bedrooms || ""}, baths=${bathrooms || ""}
Location: ${area ? area + ", " : ""}${city || ""}, ${state || ""}
Asking price: ${price || ""}
Short description: ${descPlain?.slice(0, 240) || ""}
Search intent: Find comparable & sold in/near ${city || state || "India"} for "${userQuery}".`.trim();

  return { system, user, userQuery };
}

function buildPayload({ system, user }, { withWebSearch, model }) {
  const base = {
    model, // "gpt-5-mini" (default) or "gpt-5" etc.
    input: [
      { role: "system", content: system },
      { role: "user",   content: user  }
    ],
    max_output_tokens: 900
  };
  if (withWebSearch) {
    base.tools = [{ type: "web_search" }];
    base.tool_choice = "auto";
  }
  return base;
}

exports.handler = async (event) => {
  const CORS = corsHeaders(event.headers.origin || event.headers.Origin || "");
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: CORS, body: "" };
  if (event.httpMethod !== "POST")   return bad("POST only", CORS);

  try {
    const { input } = JSON.parse(event.body || "{}");
    if (!input) return bad("missing input", CORS);

    const key = process.env.OPENAI_API_KEY
      || event.headers["x-openai-key"]
      || event.headers["X-OpenAI-Key"];
    if (!key) return bad("Missing OpenAI API key", CORS);

    const reqModel =
      event.headers["x-openai-model"] ||
      event.headers["X-OpenAI-Model"] ||
      DEFAULT_MODEL;

    const prompts = buildPrompts(input);

    // Attempt with web_search tool first
    let payload = buildPayload(prompts, { withWebSearch: true, model: reqModel });
    let resp = await fetch(OPENAI_URL, {
      method: "POST",
      headers: { "content-type": "application/json", "authorization": `Bearer ${key}` },
      body: JSON.stringify(payload)
    });
    let data = await resp.json();

    // If tool unsupported / disabled, retry without tools
    const toolUnsupported =
      (!resp.ok) &&
      /web[_-]?search|tool|unsupported|not enabled|Unknown tool/i.test(
        data?.error?.message || JSON.stringify(data)
      );

    if (toolUnsupported) {
      payload = buildPayload(prompts, { withWebSearch: false, model: reqModel });
      resp = await fetch(OPENAI_URL, {
        method: "POST",
        headers: { "content-type": "application/json", "authorization": `Bearer ${key}` },
        body: JSON.stringify(payload)
      });
      data = await resp.json();
    }

    if (!resp.ok) return bad(data?.error?.message || JSON.stringify(data), CORS);

    const text = extractText(data);
    let parsed = null;
    try { parsed = text && JSON.parse(text); } catch (_) {}
    if (!parsed || typeof parsed !== "object")
      return bad("Failed to parse JSON from model response", CORS);

    return ok(
      { result: parsed, _meta: { q: prompts.userQuery, used_web_search: !toolUnsupported, model: reqModel } },
      CORS
    );
  } catch (e) {
    return bad(e?.message || e, CORS);
  }
};
