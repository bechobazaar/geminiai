/* netlify/functions/price-advisor-proxy.js
   Same-origin proxy on bechobazaar.com → forwards to remote function on bechobazaarui.netlify.app
*/
const TARGET = "https://bechobazaarui.netlify.app/.netlify/functions/price-advisor-web";

function cors() {
  return {
    "Access-Control-Allow-Origin": "https://bechobazaar.com",
    "Vary": "Origin",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-Plan",
    "Access-Control-Max-Age": "600"
  };
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: cors(), body: "" };
  if (event.httpMethod !== "POST") return { statusCode: 400, headers: cors(), body: JSON.stringify({ error: "POST only" }) };

  try {
    const r = await fetch(TARGET, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Plan": event.headers["x-plan"] || "free"
      },
      body: event.body
    });

    const text = await r.text();
    return { statusCode: r.status, headers: cors(), body: text };
  } catch (e) {
    return { statusCode: 502, headers: cors(), body: JSON.stringify({ error: "Proxy failed: " + String(e) }) };
  }
};
