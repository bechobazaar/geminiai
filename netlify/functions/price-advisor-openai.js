// netlify/functions/price-advisor-openai.js
// Node 18+ runtime (built-in fetch). No node-fetch needed.

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, x-openai-key"
};

const OPENAI_URL = "https://api.openai.com/v1/responses";
const MODEL = "gpt-4o-mini";

const ok  = (body) => ({ statusCode: 200, headers: CORS, body: JSON.stringify(body) });
const bad = (msg)  => ({ statusCode: 400, headers: CORS, body: JSON.stringify({ error: String(msg) }) });

// Extract the text payload from Responses API (handles a few shapes)
function extractText(respJson) {
  // Preferred: output[0].content[0].text
  const t1 = respJson?.output?.[0]?.content?.[0]?.text;
  if (t1) return t1;
  // Older alias:
  if (respJson?.output_text) return respJson.output_text;
  // Defensive fallback: join any text fragments we can find
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

// Build the system and user prompts once
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
Fetch or infer 5–10 recent comparable listings (same city/state first, then nearby/statewide) and any recent sold prices.
Always output *only* valid JSON with this shape:

{
  "market_price": number,                       // INR (no commas)
  "price_band": { "low": number, "high": number },
  "suggestion": number,                         // good listing price for quick sale
  "confidence": "low" | "medium" | "high",
  "condition_note": string,                     // how condition/age/owner/accident affects it
  "notes": string,                              // short reasoning (<= 2 lines)
  "old_sold_samples": [
    {"title": string, "price": number, "location": string, "date": string, "url": string, "condition": string, "note": string}
  ]
}

Adjustments (guideline):
- Vehicles: New/Good tyres + no accidents + all papers + 1st owner => +5–10%;
  Minor accidents, worn tyres, 2nd/3rd owner, expiring/expired PUC/insurance => -5–15%.
- Mobiles/Electronics: age >2y or heavy wear => -10–20%; mint/boxed => +5–10%.
- Properties: consider ₹/sqft, locality comps, BHK, furnishing, facing.

Use INR as plain numbers. If web search is unavailable, use knowledge + reasonable heuristics and still return the JSON.
`.trim();

  const user = `
Item: ${title || `${brand || ""} ${model || ""}`.trim()}
Category: ${category || ""}
Subcategory: ${subCategory || ""}
Brand: ${brand || ""}
Model: ${model || ""}
Vehicle: year=${yearOfPurchase || ""}, km=${kmDriven || ""}, owner=${ownership || ""}, tyre=${tyreCondition || ""}, accident=${accidentStatus || ""}, papers=${allPapersAvail || ""}, PUC=${pollutionExpiry || ""}, tax=${taxExpiry || ""}, insurance=${insuranceExpiry || ""}
Property: type=${propertyType || ""}, bhk=${bhk || ""}, area_sqft=${propertyArea || ""}, facing=${facing || ""}, furnishing=${furnishing || ""}, beds=${bedrooms || ""}, baths=${bathrooms || ""}
Location: ${area ? area + ", " : ""}${city || ""}, ${state || ""}
Asking price: ${price || ""}
Short description: ${descPlain?.slice(0, 240) || ""}
Search intent: Find recent comparable listings and sold in/near ${city || state || "India"} for "${userQuery}".
`.trim();

  return { system, user, userQuery };
}

// Build a Responses API payload (toggle tools on/off)
function buildPayload({ system, user }, { withWebSearch }) {
  const base = {
    model: MODEL,
    reasoning: { effort: "medium" },
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
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: CORS, body: "" };
  if (event.httpMethod !== "POST")   return bad("POST only");

  try {
    const { input } = JSON.parse(event.body || "{}");
    if (!input) return bad("missing input");

    const key = process.env.OPENAI_API_KEY
      || event.headers["x-openai-key"]
      || event.headers["X-OpenAI-Key"];
    if (!key) return bad("Missing OpenAI API key");

    const prompts = buildPrompts(input);

    // 1) Try with web_search enabled
    let payload = buildPayload(prompts, { withWebSearch: true });
    let resp   = await fetch(OPENAI_URL, {
      method: "POST",
      headers: { "content-type": "application/json", "authorization": `Bearer ${key}` },
      body: JSON.stringify(payload)
    });

    let data = await resp.json();

    // If org/model doesn't support web_search (or similar tool error), retry without tools
    const toolUnsupported =
      !resp.ok && /web[_-]?search|tool|unsupported|not enabled|Unknown tool/i.test(
        data?.error?.message || JSON.stringify(data)
      );

    if (toolUnsupported) {
      payload = buildPayload(prompts, { withWebSearch: false });
      resp = await fetch(OPENAI_URL, {
        method: "POST",
        headers: { "content-type": "application/json", "authorization": `Bearer ${key}` },
        body: JSON.stringify(payload)
      });
      data = await resp.json();
    }

    if (!resp.ok) {
      return bad(data?.error?.message || JSON.stringify(data));
    }

    const text = extractText(data);
    let parsed = null;
    try { parsed = text && JSON.parse(text); } catch (_) {}

    if (!parsed || typeof parsed !== "object") {
      return bad("Failed to parse JSON from model response");
    }

    return ok({ result: parsed, _meta: { q: prompts.userQuery, used_web_search: !toolUnsupported } });
  } catch (e) {
    return bad(e?.message || e);
  }
};
