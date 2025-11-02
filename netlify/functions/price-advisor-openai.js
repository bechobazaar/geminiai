// netlify/functions/price-advisor-openai.js
// Node 18+ runtime — built-in fetch() is available, no node-fetch

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, x-openai-key"
};

const OPENAI_URL = "https://api.openai.com/v1/responses";
const MODEL = "gpt-4o-mini";

const ok  = (body)=>({ statusCode:200, headers:CORS, body: JSON.stringify(body) });
const bad = (msg)=>({ statusCode:400, headers:CORS, body: JSON.stringify({ error:String(msg) }) });

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: CORS, body: "" };
  if (event.httpMethod !== "POST")   return bad("POST only");

  try {
    const { input } = JSON.parse(event.body || "{}");
    if (!input) return bad("missing input");

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
      title || `${brand||''} ${model||''}`.trim(),
      category, subCategory, propertyType, bhk,
      city, state, area,
      yearOfPurchase ? `year ${yearOfPurchase}` : '',
      kmDriven ? `${kmDriven} km` : '',
      ownership, tyreCondition, accidentStatus, allPapersAvail,
    ].filter(Boolean).join(' • ');

    const system = `
You are a price advisor for a classifieds marketplace in India.
Use web_search to fetch 5-10 recent comparable listings (same city/state first, then nearby/statewide) and any recent sold prices.
Return *only* JSON:
{
  "market_price": number,
  "price_band": {"low": number, "high": number},
  "suggestion": number,
  "confidence": "low|medium|high",
  "condition_note": string,
  "notes": string,
  "old_sold_samples": [
    {"title": string, "price": number, "location": string, "date": string, "url": string, "condition": string, "note": string}
  ]
}
Adjust for condition/age/ownership as described. Currency INR, plain numbers (no commas).`;

    const user = `
Item: ${title || `${brand||''} ${model||''}`.trim()}
Category: ${category||''}
Subcategory: ${subCategory||''}
Brand: ${brand||''}
Model: ${model||''}
Vehicle: year=${yearOfPurchase||''}, km=${kmDriven||''}, owner=${ownership||''}, tyre=${tyreCondition||''}, accident=${accidentStatus||''}, papers=${allPapersAvail||''}, PUC=${pollutionExpiry||''}, tax=${taxExpiry||''}, insurance=${insuranceExpiry||''}
Property: type=${propertyType||''}, bhk=${bhk||''}, area_sqft=${propertyArea||''}, facing=${facing||''}, furnishing=${furnishing||''}, beds=${bedrooms||''}, baths=${bathrooms||''}
Location: ${area? area+', ':''}${city||''}, ${state||''}
Asking price: ${price||''}
Short description: ${descPlain?.slice(0,240)||''}
Search intent: Find recent comparable listings and sold in/near ${city||state||'India'} for "${userQuery}".`;

    const key = process.env.OPENAI_API_KEY
      || event.headers['x-openai-key']
      || event.headers['X-OpenAI-Key'];
    if (!key) return bad("Missing OpenAI API key");

    const payload = {
      model: MODEL,
      reasoning: { effort: "medium" },
      input: [
        { role: "system", content: system },
        { role: "user",   content: user }
      ],
      tools: [{ type: "web_search" }],
      response_format: { type: "json_object" },
      max_output_tokens: 900
    };

    const resp = await fetch(OPENAI_URL, {
      method: "POST",
      headers: { "content-type":"application/json", "authorization": `Bearer ${key}` },
      body: JSON.stringify(payload)
    });
    const data = await resp.json();
    if (!resp.ok) return bad(data?.error?.message || JSON.stringify(data));

    let parsed = null;
    try {
      const text = data?.output?.[0]?.content?.[0]?.text ?? data?.output_text ?? '';
      parsed = text && JSON.parse(text);
    } catch(_) {}

    if (!parsed) return bad("Failed to parse response");
    return ok({ result: parsed, _meta: { q: userQuery } });
  } catch (e) {
    return bad(e.message || e);
  }
};
