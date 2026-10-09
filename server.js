"use strict";
// Kod Tezgâhı: static tool page + a small snippet store, behind HTTP Basic auth.
const http = require("http");
const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const crypto = require("crypto");

const PORT = Number(process.env.PORT) || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const APP_USER = process.env.APP_USER || "admin";
const APP_PASSWORD = process.env.APP_PASSWORD || "";
const AUTH_DISABLED = process.env.AUTH_DISABLED === "1";

const MAX_BODY = 2 * 1024 * 1024;          // one request
const MAX_SNIPPET = 1024 * 1024;           // one snippet body
const MAX_STORE = 50 * 1024 * 1024;        // whole store on disk
const MAX_SNIPPETS = 2000;

if (!APP_PASSWORD && !AUTH_DISABLED) {
  console.error("APP_PASSWORD is not set. Set it, or AUTH_DISABLED=1 for local use only.");
  process.exit(1);
}

const PUBLIC = path.join(__dirname, "public");
const NM = path.join(__dirname, "node_modules");
const VENDOR = {
  "/vendor/beautify.js": path.join(NM, "js-beautify/js/lib/beautify.js"),
  "/vendor/beautify-css.js": path.join(NM, "js-beautify/js/lib/beautify-css.js"),
  "/vendor/beautify-html.js": path.join(NM, "js-beautify/js/lib/beautify-html.js"),
  "/vendor/sql-formatter.min.js": path.join(NM, "sql-formatter/dist/sql-formatter.min.js"),
};
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".ico": "image/x-icon", ".png": "image/png" };

const SECURITY_HEADERS = {
  "Content-Security-Policy": "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
  "X-Robots-Tag": "noindex, nofollow",
};

/* ---------- auth ---------- */
const failures = new Map(); // ip -> {count, until}
const WINDOW_MS = 15 * 60 * 1000, MAX_FAILS = 10;
function clientIp(req) {
  const xf = req.headers["x-forwarded-for"];
  return (xf ? String(xf).split(",")[0] : req.socket.remoteAddress || "").trim();
}
function safeEqual(a, b) {
  const ha = crypto.createHash("sha256").update(a).digest();
  const hb = crypto.createHash("sha256").update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}
function checkAuth(req, res) {
  if (AUTH_DISABLED) return true;
  const ip = clientIp(req), now = Date.now();
  const f = failures.get(ip);
  if (f && f.count >= MAX_FAILS && f.until > now) {
    send(res, 429, "Çok fazla hatalı giriş. 15 dakika sonra tekrar dene.", { "Retry-After": "900" });
    return false;
  }
  const h = req.headers.authorization || "";
  if (h.startsWith("Basic ")) {
    const raw = Buffer.from(h.slice(6), "base64").toString("utf8");
    const i = raw.indexOf(":");
    if (i >= 0 && safeEqual(raw.slice(0, i), APP_USER) && safeEqual(raw.slice(i + 1), APP_PASSWORD)) {
      failures.delete(ip);
      return true;
    }
    const cur = f && f.until > now ? f : { count: 0, until: now + WINDOW_MS };
    cur.count++; failures.set(ip, cur);
  }
  send(res, 401, "Giriş gerekli.", { "WWW-Authenticate": 'Basic realm="Kod Tezgahi", charset="UTF-8"' });
  return false;
}
setInterval(() => { const now = Date.now(); for (const [k, v] of failures) if (v.until <= now) failures.delete(k); }, WINDOW_MS).unref();

/* ---------- snippet store ---------- */
const STORE_FILE = path.join(DATA_DIR, "snippets.json");
let store = new Map();
let writeChain = Promise.resolve();
function loadStore() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  try {
    const arr = JSON.parse(fs.readFileSync(STORE_FILE, "utf8"));
    if (Array.isArray(arr)) store = new Map(arr.filter(x => x && typeof x.id === "string").map(x => [x.id, x]));
  } catch (e) {
    if (e.code !== "ENOENT") console.error("Could not read store, starting empty:", e.message);
  }
}
function persist() {
  const data = JSON.stringify(Array.from(store.values()));
  writeChain = writeChain.then(async () => {
    const tmp = STORE_FILE + ".tmp";
    await fsp.writeFile(tmp, data);
    await fsp.rename(tmp, STORE_FILE);
  }).catch(e => console.error("Store write failed:", e.message));
  return writeChain;
}
const ID_RE = /^[A-Za-z0-9_-]{4,64}$/;
function clean(id, b) {
  const str = (v, max) => (typeof v === "string" ? v : "").slice(0, max);
  const body = str(b.body, MAX_SNIPPET + 1);
  if (!body.trim()) return { error: "Boş parça kaydedilmez." };
  if (Buffer.byteLength(body) > MAX_SNIPPET) return { error: "Parça çok büyük (en fazla 1 MB)." };
  return { item: { id, title: str(b.title, 200) || "Adsız", body, kind: str(b.kind, 20), updatedAt: Date.now() } };
}

/* ---------- http helpers ---------- */
function send(res, code, body, headers = {}) {
  const isObj = typeof body === "object" && body !== null;
  const payload = isObj ? JSON.stringify(body) : String(body);
  res.writeHead(code, { ...SECURITY_HEADERS, "Content-Type": isObj ? "application/json; charset=utf-8" : "text/plain; charset=utf-8", "Cache-Control": "no-store", ...headers });
  res.end(payload);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on("data", c => { size += c.length; if (size > MAX_BODY) { reject(Object.assign(new Error("too large"), { status: 413 })); req.destroy(); } else chunks.push(c); });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}
async function serveFile(res, file, cache) {
  try {
    const data = await fsp.readFile(file);
    res.writeHead(200, { ...SECURITY_HEADERS, "Content-Type": TYPES[path.extname(file)] || "application/octet-stream", "Cache-Control": cache });
    res.end(data);
  } catch {
    send(res, 404, "Bulunamadı.");
  }
}

/* ---------- routes ---------- */
async function api(req, res, url) {
  if (url.pathname === "/api/snippets" && req.method === "GET") {
    const list = Array.from(store.values()).sort((a, b) => b.updatedAt - a.updatedAt);
    return send(res, 200, list);
  }
  const m = url.pathname.match(/^\/api\/snippets\/([^/]+)$/);
  if (m) {
    const id = decodeURIComponent(m[1]);
    if (!ID_RE.test(id)) return send(res, 400, { error: "Geçersiz kayıt kimliği." });
    if (req.method === "PUT") {
      if (!(req.headers["content-type"] || "").includes("application/json")) return send(res, 415, { error: "JSON bekleniyor." });
      let b;
      try { b = JSON.parse(await readBody(req)); } catch (e) { return send(res, e.status || 400, { error: e.status === 413 ? "İstek çok büyük." : "Geçersiz JSON." }); }
      const r = clean(id, b || {});
      if (r.error) return send(res, 400, { error: r.error });
      if (!store.has(id) && store.size >= MAX_SNIPPETS) return send(res, 507, { error: "Kayıt sınırına ulaşıldı. Eski kayıtlardan bazılarını sil." });
      const prev = store.get(id); store.set(id, r.item);
      const total = Array.from(store.values()).reduce((n, x) => n + Buffer.byteLength(x.body), 0);
      if (total > MAX_STORE) { if (prev) store.set(id, prev); else store.delete(id); return send(res, 507, { error: "Depolama dolu. Eski kayıtlardan bazılarını sil." }); }
      await persist();
      return send(res, 200, r.item);
    }
    if (req.method === "DELETE") {
      if (store.delete(id)) await persist();
      return send(res, 200, { ok: true });
    }
  }
  return send(res, 404, { error: "Bulunamadı." });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://localhost");
    if (url.pathname === "/healthz") return send(res, 200, "ok");
    if (!checkAuth(req, res)) return;
    if (url.pathname.startsWith("/api/")) return await api(req, res, url);
    if (req.method !== "GET" && req.method !== "HEAD") return send(res, 405, "İzin verilmeyen yöntem.");
    if (VENDOR[url.pathname]) return serveFile(res, VENDOR[url.pathname], "public, max-age=86400");
    if (url.pathname === "/" || url.pathname === "/index.html") return serveFile(res, path.join(PUBLIC, "index.html"), "no-cache");
    const file = path.normalize(path.join(PUBLIC, url.pathname));
    if (!file.startsWith(PUBLIC + path.sep)) return send(res, 404, "Bulunamadı.");
    return serveFile(res, file, "public, max-age=3600");
  } catch (e) {
    console.error(e);
    if (!res.headersSent) send(res, 500, "Sunucu hatası.");
  }
});

loadStore();
server.listen(PORT, () => console.log(`Kod Tezgâhı listening on :${PORT} (auth ${AUTH_DISABLED ? "disabled" : "on"}, data ${DATA_DIR})`));
for (const sig of ["SIGTERM", "SIGINT"]) process.on(sig, () => { server.close(); writeChain.finally(() => process.exit(0)); });
