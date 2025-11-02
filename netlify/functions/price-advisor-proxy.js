// netlify/functions/price-advisor-proxy.js

const UI_FN_URL = "https://bechobazaarui.netlify.app/.netlify/functions/price-advisor-web";

function cors() {
  return {
    "Access-Control-Allow-Origin": "https://bechobazaar.com",
    "Vary": "Origin",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-Plan",
    "Access-Control-Max-Age": "600"
  };
}
const ok  = (b)=>({ statusCode:200, headers:cors(), body:JSON.stringify(b) });
const bad = (s,m)=>({ statusCode:s, headers:cors(), body:JSON.stringify({ error:m }) });

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: cors(), body: "" };
  }
  if (event.httpMethod !== "POST") {
    return bad(405, "POST only");
  }
  try {
    const body = event.body || "{}";
    const plan = event.headers?.["x-plan"] || "free";

    const r = await fetch(UI_FN_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-plan": plan
      },
      body
    });
    const text = await r.text();
    let data;
    try { data = JSON.parse(text); } catch { data = { raw:text }; }

    if (!r.ok) {
      const msg = data?.error || r.statusText || ("HTTP "+r.status);
      return bad(r.status, msg);
    }
    return ok(data);
  } catch (e) {
    return bad(400, String(e.message || e));
  }
};
