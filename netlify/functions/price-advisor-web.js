// netlify/functions/price-advisor-web.js
const ok = (body, headers = {}) => ({
  statusCode: 200,
  headers: {
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "POST, OPTIONS",
    "access-control-allow-headers": "Content-Type, X-Plan",
    "access-control-max-age": "600",
    "vary": "Origin",
    ...headers,
  },
  body: JSON.stringify(body),
});

const bad = (statusCode, msg) => ({
  statusCode,
  headers: {
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "POST, OPTIONS",
    "access-control-allow-headers": "Content-Type, X-Plan",
    "access-control-max-age": "600",
    "vary": "Origin",
  },
  body: JSON.stringify({ error: msg }),
});

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return ok("");

  if (event.httpMethod !== "POST") {
    return bad(405, "POST only");
  }

  // ---- ENV KEYS ----
  const OPENAI_KEY = process.env.OPENAI_API_KEY || "";
  const TAVILY_KEY = process.env.TAVILY_API_KEY || ""; // optional

  try {
    const { input = {} } = JSON.parse(event.body || "{}");
    const category = (input.category || "").trim();
    const brand = (input.brand || "").trim();
    const model = (input.model || "").trim();
    const city = (input.city || "").trim();
    const state = (input.state || "").trim();
    const price = Number(input.price || 0) || 0;

    if (!category || !brand || !city || !state) {
      return bad(400, "Missing required fields (category, brand, city, state)");
    }

    // 1) Tavily web search (optional; graceful fallback)
    let web = { used: false, answer: "", results: [] };
    if (TAVILY_KEY) {
      try {
        const q1 = `${brand} ${model} used price ${city} ${state} India`;
        const q2 = `${brand} ${model} resale price India`;
        const tRes = await fetch("https://api.tavily.com/search", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            api_key: TAVILY_KEY,
            query: `Find recent used-market prices and listing ranges for ${brand} ${model || category} in ${city}, ${state}, India.`,
            search_depth: "advanced",
            max_results: 8,
            include_answer: true,
            include_domains: [],
            exclude_domains: [],
            // helper queries to steer the engine
            topic: "general",
            days: 365,
            include_images: false,
            include_raw_content: false,
            follow_up_questions: [`${q1}`, `${q2}`],
          }),
        });
        const tJson = await tRes.json();
        web.used = true;
        web.answer = tJson?.answer || "";
        web.results = Array.isArray(tJson?.results)
          ? tJson.results.slice(0, 6).map((r) => ({
              title: r.title || "",
              url: r.url || "",
              content: r.content || "",
            }))
          : [];
      } catch (e) {
        web.used = false;
        web.answer = "";
        web.results = [];
      }
    }

    // 2) Build OpenAI prompt + strict JSON schema
    const sys = [
      "You are an Indian marketplace price advisor.",
      "Estimate a used-market band and a realistic quick-sale price for the item in the user's city/region.",
      "All prices in INR as numbers (no commas).",
      "Consider condition, storage/variant, bill/box availability, battery health for phones, and location demand.",
      "Return strictly the requested JSON schema.",
      "Also produce a short HTML paragraph named webview_summary_html (2–4 sentences) that reads like a web-browse result: start with bold model + city, summarize current market range and a recommended ask price, and mention key factors briefly.",
      "If web_results exist, ground your paragraph and add 2–4 sources (title + url). If no web data, still write a helpful paragraph and keep sources empty.",
    ].join(" ");

    const schema = {
      name: "PriceAdvice",
      schema: {
        type: "object",
        additionalProperties: true,
        properties: {
          market_price_low: { type: "number" },
          market_price_high: { type: "number" },
          suggested_price: { type: "number" },
          confidence: { type: "string", enum: ["low", "medium", "high"] },
          old_vs_new: {
            type: "object",
            additionalProperties: false,
            properties: {
              launch_mrp: { type: "number" },
              typical_used: { type: "number" },
            },
          },
          why: { type: "string" },
          webview_summary_html: { type: "string" },
          sources: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                title: { type: "string" },
                url: { type: "string" },
              },
            },
          },
        },
        required: [
          "market_price_low",
          "market_price_high",
          "suggested_price",
          "confidence",
        ],
      },
      strict: true,
    };

    // help model with a couple of pre-picked sources
    const topSources = (web.results || [])
      .slice(0, 4)
      .map((r) => ({ title: r.title, url: r.url }));

    const userCtx = {
      category,
      brand,
      model,
      region: [city, state].filter(Boolean).join(", "),
      input_price: price,
      web_used: web.used,
      web_answer: web.answer,
      web_results: web.results,
      top_sources: topSources,
    };

    // 3) OpenAI Responses API
    const plan = (event.headers["x-plan"] || event.headers["X-Plan"] || "free")
      .toString()
      .toLowerCase();
    const model = plan === "pro" ? "gpt-5-mini" : "gpt-4o-mini";

    const aiRes = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        Authorization: `Bearer ${OPENAI_KEY}`,
      },
      body: JSON.stringify({
        model,
        // The Responses API expects "input" with role/content parts:
        input: [
          { role: "system", content: [{ type: "text", text: sys }] },
          {
            role: "user",
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  task: "estimate_used_price_india",
                  user_input: userCtx,
                }),
              },
            ],
          },
        ],
        max_output_tokens: 900,
        format: { type: "json_schema", json_schema: schema },
      }),
    });

    if (!aiRes.ok) {
      const t = await aiRes.text();
      return bad(400, `OpenAI error: ${t}`);
    }

    const aiJson = await aiRes.json();
    const raw = aiJson?.output_text || "";
    let parsed = {};
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = {};
    }

    // 4) Post-fixes / safety
    // ensure band sanity if model slips
    const ensureBand = (obj) => {
      let lo = Number(obj.market_price_low || 0);
      let hi = Number(obj.market_price_high || 0);
      let sg = Number(obj.suggested_price || 0);

      if (!Number.isFinite(lo) || lo <= 0) lo = Math.max(1, Math.round(price * 0.7));
      if (!Number.isFinite(hi) || hi <= 0) hi = Math.max(lo + 1, Math.round(price * 1.3));
      if (hi < lo) [lo, hi] = [hi, lo];
      if (!Number.isFinite(sg) || sg <= 0) {
        sg = Math.round((lo * 0.4 + hi * 0.6)); // slight bias to high for negotiation
      }

      return {
        ...obj,
        market_price_low: lo,
        market_price_high: hi,
        suggested_price: sg,
      };
    };

    const safeSummary = (s) =>
      typeof s === "string" && s.trim()
        ? s.trim()
        : `<p><b>${brand} ${model || category}, ${city}:</b> Limited public data found. Pricing is estimated from typical India used-market trends for this category and region. Choose an ask price near the mid of the range for a faster sale.</p>`;

    const result = ensureBand({
      ...parsed,
      webview_summary_html: safeSummary(parsed?.webview_summary_html),
      sources: Array.isArray(parsed?.sources) ? parsed.sources.slice(0, 4) : topSources,
    });

    return ok({
      ok: true,
      provider: "openai",
      model,
      result,
      // debug: { web } // enable if you need to inspect
    });
  } catch (e) {
    return bad(400, String(e.message || e));
  }
};
