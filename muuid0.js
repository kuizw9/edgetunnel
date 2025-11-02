/**
 * _worker.js  — 支援多 UUID 的 VLESS 設定（Cloudflare Worker）
 *
 * 功能：
 * - 使用陣列形式管理多個 UUID（可由程式碼內定義或由環境變數提供）
 * - 驗證時接受陣列中任一 UUID
 * - 首頁同時顯示純文字清單（可複製）和 HTML <ul> 列表
 * - /sub 會為每個 UUID 各生成一組 VLESS 設定（每行一個 VLESS URI）
 *
 * 使用：
 * - 直接部署此 Worker 即可
 * - 若需透過環境變數設定 UUID，可設定 UUIDS（逗號分隔）或 UUID_JSON（JSON 陣列字串）
 *
 * 注意：
 * - 這份腳本主要是改造驗證 / 訂閱產生邏輯；實際 VLESS 連線的 socket/proxy 行為（如果有）需配合你原本的 worker 邏輯。
 */

// ========= 配置開始 =========

// 預設在程式碼中直接定義多個 UUID（陣列）
const yourUUID = [
  // 範例：把真實 UUID 放在這裡
  "11111111-1111-1111-1111-111111111111",
  "22222222-2222-2222-2222-222222222222",
  "33333333-3333-3333-3333-333333333333"
];

// 如果想用環境變數（在 Workers 的 Settings > Variables）覆蓋上面的 yourUUID，
// 你可以設定 UUIDS（逗號分隔字串）或 UUID_JSON（合法 JSON 陣列字串）。
// 例如： UUIDS = "a,b,c"  或  UUID_JSON = '["a","b","c"]'
// 程式會自動以這些環境設定覆蓋上面預設值（如果有提供）。
// ========= 配置結束 =========

addEventListener("fetch", event => {
  event.respondWith(handleRequest(event.request, event));
});

/**
 * 讀取並整理可接受的 UUID 清單（來源：在檔案內定義 or env 變數）
 * @param {Object} env - 傳入的 env（支援透過 event.fetch handler 傳入）
 * @returns {string[]} - 去重且 trim 的 uuid 陣列
 */
function loadUUIDsFromEnv(env) {
  try {
    // 優先用 env 內的設定（若存在）
    if (env) {
      if (env.UUID_JSON) {
        try {
          const parsed = JSON.parse(env.UUID_JSON);
          if (Array.isArray(parsed) && parsed.length > 0) {
            return [...new Set(parsed.map(s => String(s).trim()).filter(Boolean))];
          }
        } catch (e) {
          // 如果 JSON parse 失敗，會退回去下一種方式
        }
      }
      if (env.UUIDS) {
        // 逗號分隔
        return [...new Set(String(env.UUIDS).split(",").map(s => s.trim()).filter(Boolean))];
      }
    }
  } catch (e) {
    // 忽略錯誤，使用程式碼內預設
  }

  // 程式碼內定義的 yourUUID（陣列或字串）
  if (Array.isArray(yourUUID)) {
    return [...new Set(yourUUID.map(s => String(s).trim()).filter(Boolean))];
  }
  // 若使用者不小心輸入成字串（容錯）
  if (typeof yourUUID === "string") {
    return [...new Set(yourUUID.split(",").map(s => s.trim()).filter(Boolean))];
  }
  return [];
}

/**
 * 簡單 UUID 檢查函式（容錯用，不強制驗證完整 RFC）
 * @param {string} id
 * @returns {boolean}
 */
function looksLikeUUID(id) {
  if (!id || typeof id !== "string") return false;
  // 容許普通字串（有長度）或常見 UUID 格式（8-4-4-4-12）
  const trimmed = id.trim();
  if (trimmed.length === 0) return false;
  // 如果是標準 UUID 格式，這個 regex 會通過；否則仍接受但警告
  const uuidRegex = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
  return uuidRegex.test(trimmed) || trimmed.length >= 8;
}

/**
 * 產生 VLESS 連結（可根據需要自訂參數）
 * 這裡使用常見的 VLESS URI 形式： vless://<id>@<host>:<port>?security=tls&type=ws&path=%2F&encryption=none#<name>
 *
 * 你可以根據原始專案裡的 query string 參數做調整（例如 flow、sni、alpn 等）
 */
function buildVlessURI({ uuid, host, port = 443, name = "vless", path = "/", tls = true }) {
  // 簡單處理 name，避免空白或特殊字元
  const safeName = encodeURIComponent(`${name}-${uuid.slice(0, 6)}`);
  const q = new URLSearchParams();
  if (tls) q.set("security", "tls");
  q.set("type", "ws");
  q.set("path", encodeURIComponent(path));
  q.set("encryption", "none");
  const qs = q.toString();

  return `vless://${uuid}@${host}:${port}?${qs}#${safeName}`;
}

/**
 * 主處理函式
 */
async function handleRequest(request, event) {
  const url = new URL(request.url);
  const path = url.pathname || "/";

  // 嘗試讀取 env（在 CF Worker 中 event.passThroughOnException 沒提供 env）
  // 若你直接 deploy 在 Cloudflare Workers，env 可透過 module worker 的環境注入或用全域變數
  // 這裡我們嘗試從 request.headers 讀取自訂 header（若需要），但預設會使用程式碼內的 yourUUID
  const env = {}; // placeholder — 如果你有 module worker env，請替換這裡

  const uuids = loadUUIDsFromEnv(env);

  // 根據路徑處理
  if (path === "/" || path === "") {
    return new Response(renderMainPage(uuids, request), {
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  }

  if (path === "/sub") {
    // 產生每個 UUID 的 VLESS URI 列表，每行一個（純文字）
    // host 預設使用請求的 Host header
    const host = request.headers.get("host") || url.host || "example.com";
    if (!uuids || uuids.length === 0) {
      return new Response("no uuids configured", { status: 400 });
    }

    const lines = uuids.map((id) => {
      // 針對每個 UUID 產生各自的 VLESS URI
      const uri = buildVlessURI({ uuid: id, host, port: 443, name: "vless" });
      return uri;
    });

    // 許多訂閱方案會使用 base64(utf-8)，這裡我們回傳純文字與一個 base64 版本在 header（選用）
    const bodyPlain = lines.join("\n");
    const bodyBase64 = btoa(unescape(encodeURIComponent(bodyPlain)));

    return new Response(bodyPlain, {
      headers: {
        "content-type": "text/plain; charset=utf-8",
        "X-Subscription-Base64": bodyBase64,
      },
    });
  }

  // 其它路徑：你可以在這裡加入原始 worker 的 proxy 或 VLESS 連線處理邏輯
  // 如果原始檔案有處理連線（例如 TCP 轉發），請把那段邏輯整合到這裡
  return new Response("Not Found", { status: 404 });
}

/**
 * 用於 render 首頁的 HTML（同時包含純文字區塊與一個 <ul> 列表）
 */
function renderMainPage(uuids, request) {
  const host = request.headers.get("host") || new URL(request.url).host;
  const now = new Date().toLocaleString("zh-TW", { timeZone: "Asia/Tokyo" });

  const plainText = (uuids && uuids.length > 0) ? uuids.join("\n") : "No UUID configured.";
  const ulList = (uuids && uuids.length > 0)
    ? `<ul>${uuids.map(id => `<li>${escapeHtml(id)}</li>`).join("")}</ul>`
    : "<p>No UUID configured.</p>";

  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>Worker — UUID 列表</title>
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <style>
    body { font-family: -apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Helvetica,Arial; padding:20px; line-height:1.6 }
    .box { border:1px solid #eee; padding:12px; border-radius:6px; margin-bottom:12px; background:#fafafa }
    textarea { width:100%; height:120px; font-family:monospace; }
  </style>
</head>
<body>
  <h1>Worker UUID 管理</h1>
  <p>Host: <strong>${escapeHtml(host)}</strong> · 時間: ${escapeHtml(now)}</p>

  <div class="box">
    <h2>可複製的純文字 UUID 清單（每行一個）</h2>
    <textarea readonly id="uuid_text">${escapeHtml(plainText)}</textarea>
    <p><button onclick="copyText()">複製清單</button></p>
  </div>

  <div class="box">
    <h2>HTML 列表（&lt;ul&gt;）</h2>
    ${ulList}
  </div>

  <div class="box">
    <h2>訂閱連結</h2>
    <p>取得訂閱： <a href="/sub">/sub</a>（會回傳每個 UUID 的 VLESS 連結，每行一個）</p>
  </div>

  <script>
    function copyText(){
      const ta = document.getElementById('uuid_text');
      ta.select();
      try {
        document.execCommand('copy');
        alert('已複製到剪貼簿');
      } catch(e) {
        alert('複製失敗，請手動複製');
      }
    }
  </script>
</body>
</html>`;
}

/** 簡單 escape HTML */
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
  })[c]);
}

/** btoa 兼容（在部分 worker 環境內已存在 btoa） */
function btoa(str) {
  if (typeof globalThis.btoa === "function") return globalThis.btoa(str);
  // Node-based fallback (shouldn't be needed in CF Worker)
  return Buffer.from(str, "utf8").toString("base64");
}
