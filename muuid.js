const yourUUID = [
  "11111111-1111-1111-1111-111111111111",
  "22222222-2222-2222-2222-222222222222"
];

addEventListener("fetch", e => e.respondWith(handleRequest(e.request)));

function loadUUIDsFromEnv(env) {
  try {
    if (env) {
      if (env.UUID_JSON) {
        const parsed = JSON.parse(env.UUID_JSON);
        if (Array.isArray(parsed)) return [...new Set(parsed.map(s=>String(s).trim()).filter(Boolean))];
      }
      if (env.UUIDS) return [...new Set(String(env.UUIDS).split(",").map(s=>s.trim()).filter(Boolean))];
    }
  } catch (e){}
  if (Array.isArray(yourUUID)) return [...new Set(yourUUID.map(s=>String(s).trim()).filter(Boolean))];
  if (typeof yourUUID === "string") return [...new Set(yourUUID.split(",").map(s=>s.trim()).filter(Boolean))];
  return [];
}

function buildVlessURI({ uuid, host, port = 443, name = "vless", path = "/", tls = true }) {
  const safeName = encodeURIComponent(`${name}-${uuid.slice(0,6)}`);
  const q = new URLSearchParams();
  if (tls) q.set("security", "tls");
  q.set("type", "ws");
  q.set("path", encodeURIComponent(path));
  q.set("encryption", "none");
  return `vless://${uuid}@${host}:${port}?${q.toString()}#${safeName}`;
}

async function handleRequest(request) {
  const url = new URL(request.url);
  const path = url.pathname;
  const env = {};
  const uuids = loadUUIDsFromEnv(env);

  if (path === "/" || path === "") {
    return new Response(renderMainPage(uuids, request), { headers: { "content-type": "text/html; charset=utf-8" }});
  }

  if (path === "/sub") {
    const host = request.headers.get("host") || url.host || "example.com";
    if (!uuids.length) return new Response("no uuids configured", { status: 400 });
    const lines = uuids.map(id => buildVlessURI({ uuid: id, host }));
    const body = lines.join("\n");
    const bodyBase64 = (typeof globalThis.btoa === "function") ? btoa(body) : Buffer.from(body, "utf8").toString("base64");
    return new Response(body, { headers: { "content-type": "text/plain; charset=utf-8", "X-Subscription-Base64": bodyBase64 }});
  }

  return new Response("Not Found", { status: 404 });
}

function renderMainPage(uuids, request) {
  const host = request.headers.get("host") || new URL(request.url).host;
  const now = new Date().toLocaleString("zh-TW", { timeZone: "Asia/Tokyo" });
  const plainText = uuids.length ? uuids.join("\n") : "No UUID configured.";
  const ulList = uuids.length ? `<ul>${uuids.map(id=>`<li>${escapeHtml(id)}</li>`).join("")}</ul>` : "<p>No UUID configured.</p>";
  return `<!doctype html><html><head><meta charset="utf-8"><title>UUID List</title></head><body>
    <h1>UUID 管理</h1><p>Host: ${escapeHtml(host)} · ${escapeHtml(now)}</p>
    <div><h2>可複製清單</h2><textarea readonly style="width:100%;height:120px">${escapeHtml(plainText)}</textarea>
    <p><button onclick="(function(){const t=document.querySelector('textarea');t.select();document.execCommand('copy');alert('copied')})()">複製</button></p></div>
    <div><h2>HTML 列表</h2>${ulList}</div>
    <p>訂閱： <a href="/sub">/sub</a></p>
  </body></html>`;
}

function escapeHtml(s){ return String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
