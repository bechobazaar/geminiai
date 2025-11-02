// netlify/functions/price-advisor-openai.js
// Node 18+ runtime

const fetch = (...a) => import('node-fetch').then(({default:f})=>f(...a));

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, x-openai-key"
};

// Prefer env var OPENAI_API_KEY. For testing, you can send header x-openai-key.
const OPENAI_URL = "https://api.openai.com/v1/responses";
const MODEL = "gpt-4o-mini"; // fast + supports tools

const ok = (body)=>({ statusCode:200, headers:CORS, body: JSON.stringify(body) });
const bad = (s)=>({ statusCode:400, headers:CORS, body: JSON.stringify({ error:String(s) }) });

exports.handler = async (event)=>{
  if(event.httpMethod==="OPTIONS") return { statusCode:204, headers:CORS, body:"" };
  if(event.httpMethod!=="POST") return bad("POST only");

  try{
    const { input } = JSON.parse(event.body||"{}");
    if(!input) return bad("missing input");

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
      yearOfPurchase? `year ${yearOfPurchase}` : '',
      kmDriven? `${kmDriven} km` : '',
      ownership, tyreCondition, accidentStatus, allPapersAvail,
    ].filter(Boolean).join(' • ');

    const system = `
You are a price advisor for a classifieds marketplace in India.
Use web_search to fetch 5-10 recent comparable listings (same city/state first, then nearby/statewide) and *recent sold* if available.
Return *structured JSON* only with:
{
  "market_price": number,                 // median of good comps (INR)
  "price_band": { "low": number, "high": number },
  "suggestion": number,                    // good listing price for quick sale
  "confidence": "low|medium|high",
  "condition_note": string,               // how condition/age/owner/accident affects it
  "notes": string,                        // short reasoning (<= 2 lines)
  "old_sold_samples": [                   // up to 6 items
    {"title": string, "price": number, "location": string, "date": string, "url": string, "condition": string, "note": string}
  ]
}

Condition modifiers (rough guide):
- Vehicles: New/Good tyres + no accidents + all papers + 1st owner => +5–10%;
  Minor accidents, worn tyres, 2nd/3rd owner, expiring/expired PUC/insurance => -5–15%.
- Mobiles/Electronics: age > 2 years or heavy wear => -10–20%; mint/boxed => +5–10%.
- Properties: adjust for furnishing, facing (Vaastu), BHK, area (₹/sqft) with comparable locality.

Always output valid JSON. Currency is INR only (no commas).`;

    const user = `
Item: ${title || `${brand||''} ${model||''}`.trim()}
Category: ${category || ''}
Subcategory: ${subCategory || ''}
Brand: ${brand || ''}
Model: ${model || ''}
Vehicle details: year=${yearOfPurchase||''}, km=${kmDriven||''}, owner=${ownership||''}, tyre=${tyreCondition||''}, accident=${accidentStatus||''}, papers=${allPapersAvail||''}, PUC=${pollutionExpiry||''}, tax=${taxExpiry||''}, insurance=${insuranceExpiry||''}
Property: type=${propertyType||''}, bhk=${bhk||''}, area_sqft=${propertyArea||''}, facing=${facing||''}, furnishing=${furnishing||''}, beds=${bedrooms||''}, baths=${bathrooms||''}
Location: ${area? area+', ':''}${city||''}, ${state||''}
Asking price: ${price || ''}

Short description: ${descPlain?.slice(0,240) || ''}

Search intent: Find recent comparable listings and sold records in/near ${city||state||'India'} for "${userQuery}".`;

    const key = process.env.OPENAI_API_KEY || event.headers['x-openai-key'] || event.headers['X-OpenAI-Key'];
    if(!key) return bad("Missing OpenAI API key");

    // Responses API with web_search tool (per OpenAI docs)
    const payload = {
      model: MODEL,
      reasoning: { effort: "medium" },
      input: [
        { role:"system", content: system },
        { role:"user", content: user }
      ],
      tools: [{ type: "web_search" }], // enable grounded search
      response_format: { type: "json_object" },
      // small safety: cap cost/time
      max_output_tokens: 900
    };

    const r = await fetch(OPENAI_URL, {
      method:'POST',
      headers:{ 'content-type':'application/json', 'authorization':`Bearer ${key}` },
      body: JSON.stringify(payload)
    });

    const data = await r.json();
    if(!r.ok){
      // If org doesn't have web_search enabled, return a friendly error.
      return bad(data?.error?.message || JSON.stringify(data));
    }

    // The Responses API returns output in "output[0].content[0].text" when json_object is used.
    let parsed = null;
    try{
      const text = data?.output?.[0]?.content?.[0]?.text ?? data?.output_text ?? '';
      parsed = text && JSON.parse(text);
    }catch(_){}

    if(!parsed) return bad("Failed to parse response");

    return ok({ result: parsed, _meta: { q: userQuery } });
  }catch(e){
    return bad(e.message || e);
  }
};
