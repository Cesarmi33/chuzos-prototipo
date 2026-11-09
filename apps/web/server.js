// Chuzos prototipo web (demo). Sin dependencias: Node http + SSE. Reusa FSM y wallet de prototypes/.
const http = require("http"), fs = require("fs"), path = require("path"), crypto = require("crypto");
const { openStore, memoryStore } = require("./store.js");
const { transition, TRANSITIONS } = require("../../prototypes/order-fsm/fsm.js");
const { WalletStore } = require("../../prototypes/wallet/wallet.js");
const FEE = 120000;
const METHODS = new Set(["nequi", "daviplata", "breb", "cash"]);
const METHOD_LABEL = { nequi: "Nequi", daviplata: "Daviplata", breb: "Bre-B", cash: "efectivo al recoger" };
const RECEIPT_RE = /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/;
const MAX_RECEIPT = 1400000;
const MAX_BODY = 2000000;
const LANDING_DIR = path.join(__dirname, "landing");
const EMAIL_RE = /^[^\s@<>"',;]{1,64}@[^\s@<>"',;]{1,190}\.[a-z]{2,24}$/i;
const ROLES = new Set(["buyer", "stall"]);
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".json": "application/json", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".mp4": "video/mp4", ".woff2": "font/woff2", ".pdf": "application/pdf", ".srt": "text/plain; charset=utf-8", ".webmanifest": "application/manifest+json", ".ico": "image/x-icon" };

function keyOk(given) {
  const want = process.env.ADMIN_KEY || "";
  if (!want || typeof given !== "string") return false;
  const a = crypto.createHash("sha256").update(given).digest();
  const b = crypto.createHash("sha256").update(want).digest();
  return crypto.timingSafeEqual(a, b);
}

function csvCell(v) {
  let t = v == null ? "" : String(v);
  if (/^[=+\-@\t\r]/.test(t)) t = "'" + t; // evita fórmulas al abrir en Excel
  return /[",\n\r]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t;
}

function fail(status, message, code) {
  const err = new Error(message);
  err.status = status;
  if (code) err.code = code;
  return err;
}

function makeCode(used) {
  let code;
  do {
    code = "CHZ-" + String(100 + Math.floor(Math.random() * 900));
  } while (used.has(code));
  used.add(code);
  return code;
}

function validReceipt(url) {
  if (!url) return null;
  if (typeof url !== "string" || url.length > MAX_RECEIPT || !RECEIPT_RE.test(url)) {
    throw fail(413, "la foto supera 1 MB o no es una imagen válida");
  }
  return url;
}

function addMessage(order, role, text, extra = {}) {
  const msg = {
    id: order.messages.length + 1,
    role,
    text: String(text).slice(0, 500),
    at: new Date().toISOString(),
  };
  if (extra.receipt_data_url) msg.receipt_data_url = extra.receipt_data_url;
  order.messages.push(msg);
  if (role === "customer") order.unread_merchant += 1;
  else if (role === "merchant") order.unread_customer += 1;
  else if (extra.notify === "customer") order.unread_customer += 1;
  else if (extra.notify === "merchant") order.unread_merchant += 1;
  return msg;
}

function chatClosed(order) {
  return order.status === "delivered" || order.status === "cancelled";
}

function createApp(opts = {}) {
  const store = opts.store || memoryStore();
  const initial = opts.initial || { orders: [], meta: null };
  const wallets = new WalletStore();
  const stalls = JSON.parse(fs.readFileSync(path.join(__dirname, "demo_stalls.json"), "utf8"));
  const orders = new Map();
  let seq = 0;
  const clients = new Set();
  const codes = new Set();
  if (initial.meta) {
    const m = initial.meta;
    seq = m.seq || 0;
    (m.codes || []).forEach((c) => codes.add(c));
    (m.wallets || []).forEach(([id, w]) => wallets.wallets.set(id, w));
    wallets.ledger = Array.isArray(m.ledger) ? m.ledger : [];
  }
  (initial.orders || []).forEach((o) => {
    orders.set(o.id, o);
    if (o.payment && o.payment.code) codes.add(o.payment.code);
    const n = Number(String(o.id).replace(/^ord_/, ""));
    if (n > seq) seq = n;
  });
  const seedWallets = () => stalls.forEach((s) => wallets.createMerchantWallet({ id: s.id, country_code: "CO" }));
  seedWallets();
  const meta = () => ({ seq, codes: [...codes], wallets: [...wallets.wallets.entries()], ledger: wallets.ledger });
  let pending = Promise.resolve();
  const persist = (o) => {
    pending = store.saveOrder(o, meta()).catch((e) => console.error("no se pudo guardar", o && o.id, e.message));
  };
  const broadcast = (o) => {
    const d = `data: ${JSON.stringify(o)}\n\n`;
    clients.forEach((c) => c.write(d));
  };
  const walletView = (id) => {
    const b = wallets.balanceOf(id);
    return { balance_cop: b / 100, fee_cop: FEE / 100, orders_left: Math.floor(b / FEE) };
  };
  const getOrder = (id) => {
    const o = orders.get(id);
    if (!o) throw fail(404, "pedido no existe");
    return o;
  };
  const save = (o) => {
    orders.set(o.id, o);
    persist(o);
    broadcast({ type: "order", order: o });
    return o;
  };

  function createOrder({ stall_id, items, delivery }) {
    const s = stalls.find((x) => x.id === stall_id);
    if (!s) throw fail(404, "puesto no existe");
    const total = (items || []).reduce((t, it) => {
      const m = s.menu.find((x) => x.id === it.id);
      return t + (m ? m.price_cop * (it.qty || 1) : 0);
    }, 0);
    let o = {
      id: `ord_${++seq}`,
      merchant_id: s.id,
      stall_name: s.name,
      items,
      total_cop: total,
      delivery: !!delivery,
      status: "draft",
      status_history: [],
      created_at: new Date().toISOString(),
      payment: {
        code: makeCode(codes),
        method: null,
        status: "unpaid",
        receipt_data_url: null,
        claimed_at: null,
        claimed_by: null,
        confirmed_at: null,
        confirmed_by: null,
      },
      messages: [],
      unread_customer: 0,
      unread_merchant: 0,
    };
    o = transition(o, "requested", { actorRole: "customer", wallets });
    return save(o);
  }

  function move(id, to, role) {
    if (!role) throw fail(400, "falta el rol");
    const o = getOrder(id);
    const n = transition(o, to, { actorRole: role, wallets });
    if (to === "delivered") {
      if (role === "merchant" && n.payment && n.payment.method === "cash" && n.payment.status !== "confirmed") {
        n.payment.status = "confirmed";
        n.payment.confirmed_by = "merchant";
        n.payment.confirmed_at = n.updated_at;
      }
      addMessage(n, "system", "Entregado.", { notify: "customer" });
    }
    return save(n);
  }

  function claimPayment(id, body) {
    if (body.role !== "customer") throw fail(403, "solo el comprador marca Ya pagué", "FORBIDDEN");
    const o = getOrder(id);
    if (chatClosed(o)) throw fail(400, "el pedido ya está cerrado");
    if (!METHODS.has(body.method)) throw fail(400, "elige Nequi, Daviplata, Bre-B o efectivo");
    if (o.payment.status === "confirmed" || o.payment.status === "claimed" || o.payment.status === "cash") {
      throw fail(400, "el pago de este pedido ya fue informado");
    }
    const receipt = body.method === "cash" ? null : validReceipt(body.receipt_data_url);
    o.payment.method = body.method;
    o.payment.receipt_data_url = receipt;
    o.payment.claimed_by = "customer";
    o.payment.claimed_at = new Date().toISOString();
    const label = METHOD_LABEL[body.method];
    if (body.method === "cash") {
      o.payment.status = "cash";
      addMessage(o, "system", `Ya pagué (${label}).`, { notify: "merchant" });
    } else {
      o.payment.status = "claimed";
      addMessage(o, "system", `Ya pagué (${label}).`, { notify: "merchant", receipt_data_url: receipt || undefined });
    }
    return save(o);
  }

  function confirmPayment(id, body) {
    if (body.role !== "merchant") throw fail(403, "solo el puesto confirma el pago", "FORBIDDEN");
    const o = getOrder(id);
    if (o.payment.method === "cash") {
      if (o.status !== "delivered") throw fail(400, "el efectivo se confirma al entregar");
      if (o.payment.status === "confirmed") throw fail(400, "el pago ya fue confirmado");
    } else if (o.payment.status !== "claimed") throw fail(400, "no hay un pago por confirmar");
    o.payment.status = "confirmed";
    o.payment.confirmed_by = "merchant";
    o.payment.confirmed_at = new Date().toISOString();
    addMessage(o, "system", "Pago recibido.", { notify: "customer" });
    return save(o);
  }

  function missingPayment(id, body) {
    if (body.role !== "merchant") throw fail(403, "solo el puesto marca que no llegó el pago", "FORBIDDEN");
    const o = getOrder(id);
    if (o.payment.status !== "claimed") throw fail(400, "no hay un pago por revisar");
    o.payment.status = "missing";
    o.payment.missing_by = "merchant";
    o.payment.missing_at = new Date().toISOString();
    addMessage(o, "system", "No me llegó. Vuelve a intentar o escríbele al puesto en el chat.", { notify: "customer" });
    return save(o);
  }

  function postMessage(id, body) {
    if (body.role !== "customer" && body.role !== "merchant") {
      throw fail(403, "el repartidor no entra a este chat", "FORBIDDEN");
    }
    const o = getOrder(id);
    if (chatClosed(o)) throw fail(400, "el chat está cerrado");
    const text = String(body.text || "").trim();
    if (!text) throw fail(400, "escribe un mensaje");
    if (text.length > 500) throw fail(400, "el mensaje supera 500 caracteres");
    addMessage(o, body.role, text);
    return save(o);
  }

  function markRead(id, body) {
    if (body.role !== "customer" && body.role !== "merchant") throw fail(403, "rol no válido", "FORBIDDEN");
    const o = getOrder(id);
    if (body.role === "customer") o.unread_customer = 0;
    else o.unread_merchant = 0;
    orders.set(o.id, o);
    persist(o);
    return o;
  }

  async function addSignup(body) {
    if (body.website) return { ok: true }; // trampa anti-bots: campo oculto
    const email = String(body.email || "").trim().toLowerCase();
    if (email.length > 254 || !EMAIL_RE.test(email)) throw fail(400, "escribe un correo válido");
    if (!ROLES.has(body.role)) throw fail(400, "elige si eres comprador o puesto");
    const name = String(body.name || "").replace(/[\u0000-\u001f]/g, " ").trim().slice(0, 80) || null;
    const lang = body.lang === "en" ? "en" : "es";
    const source = String(body.source || "landing").slice(0, 40);
    const r = await store.addSignup({ name, email, role: body.role, lang, source });
    return { ok: true, created: r.created };
  }

  async function resetDemo() {
    await pending;
    orders.clear();
    codes.clear();
    seq = 0;
    wallets.reset();
    seedWallets();
    await store.resetDemo();
    pending = store.saveMeta(meta()).catch((e) => console.error("no se pudo guardar", e.message));
    await pending;
    broadcast({ type: "reset" });
    return { ok: true };
  }

  const send = (res, code, body, type = "application/json") => {
    res.writeHead(code, { "Content-Type": type });
    res.end(type === "application/json" ? JSON.stringify(body) : body);
  };
  const sendJson = async (res, code, body) => {
    await pending; // responde cuando el cambio ya quedó guardado
    send(res, code, body);
  };

  function serveLanding(req, res, p) {
    const rel = decodeURIComponent(p.slice("/landing/".length)) || "index.html";
    const f = path.resolve(LANDING_DIR, rel);
    if (!f.startsWith(LANDING_DIR + path.sep) || !fs.existsSync(f) || !fs.statSync(f).isFile()) return send(res, 404, { error: "not found" });
    const size = fs.statSync(f).size;
    const headers = { "Content-Type": MIME[path.extname(f).toLowerCase()] || "application/octet-stream", "Accept-Ranges": "bytes", "Cache-Control": f.endsWith(".html") || f.endsWith(".js") ? "no-cache" : "public, max-age=86400" };
    const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || "");
    if (range && (range[1] || range[2])) {
      let start = range[1] ? Number(range[1]) : size - Number(range[2]);
      let end = range[1] && range[2] ? Number(range[2]) : size - 1;
      if (start < 0) start = 0;
      if (end >= size) end = size - 1;
      if (start > end || start >= size) {
        res.writeHead(416, { "Content-Range": `bytes */${size}` });
        return res.end();
      }
      res.writeHead(206, { ...headers, "Content-Range": `bytes ${start}-${end}/${size}`, "Content-Length": end - start + 1 });
      if (req.method === "HEAD") return res.end();
      return fs.createReadStream(f, { start, end }).pipe(res);
    }
    res.writeHead(200, { ...headers, "Content-Length": size });
    if (req.method === "HEAD") return res.end();
    fs.createReadStream(f).pipe(res);
  }
  const readBody = (req) => new Promise((resolve, reject) => {
    let d = "";
    let tooBig = false;
    req.on("data", (c) => {
      if (tooBig) return;
      d += c;
      if (d.length > MAX_BODY) {
        tooBig = true;
        reject(fail(413, "el archivo supera 1 MB"));
        req.destroy();
      }
    });
    req.on("end", () => {
      if (tooBig) return;
      if (!d) return resolve({});
      try { resolve(JSON.parse(d)); }
      catch { reject(fail(400, "json inválido")); }
    });
    req.on("error", reject);
  });

  return http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://x");
    const p = url.pathname;
    try {
      if (p === "/landing" || p === "/lista") { res.writeHead(301, { Location: "/landing/" + url.search }); return res.end(); }
      if (p.startsWith("/landing/") && (req.method === "GET" || req.method === "HEAD")) return serveLanding(req, res, p);
      if (p === "/healthz") return send(res, 200, { ok: true, storage: store.kind });
      if (p === "/api/waitlist" && req.method === "POST") return send(res, 200, await addSignup(await readBody(req)));
      if (p === "/api/admin/waitlist.csv" && req.method === "GET") {
        if (!keyOk(url.searchParams.get("key"))) return send(res, 404, { error: "not found" });
        const rows = await store.listSignups();
        const head = ["id", "created_at", "name", "email", "role", "lang", "source"];
        const csv = "\ufeff" + [head.join(","), ...rows.map((r) => head.map((h) => csvCell(r[h])).join(","))].join("\r\n") + "\r\n";
        res.writeHead(200, { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": 'attachment; filename="chuzos_lista_espera.csv"', "Cache-Control": "no-store" });
        return res.end(csv);
      }
      if (p === "/api/admin/reset-demo" && req.method === "POST") {
        if (!keyOk(url.searchParams.get("key"))) return send(res, 404, { error: "not found" });
        return send(res, 200, await resetDemo());
      }
      if (p === "/api/stalls") return send(res, 200, stalls.map((s) => ({ ...s, wallet: walletView(s.id) })));
      if (p === "/api/orders" && req.method === "GET") return send(res, 200, [...orders.values()].reverse());
      if (p === "/api/orders" && req.method === "POST") return sendJson(res, 201, createOrder(await readBody(req)));
      let m = p.match(/^\/api\/orders\/([\w]+)\/transition$/);
      if (m && req.method === "POST") {
        const b = await readBody(req);
        return sendJson(res, 200, move(m[1], b.to, b.role));
      }
      m = p.match(/^\/api\/orders\/([\w]+)\/payment$/);
      if (m && req.method === "POST") {
        const b = await readBody(req);
        if (b.action === "confirm") return sendJson(res, 200, confirmPayment(m[1], b));
        if (b.action === "missing") return sendJson(res, 200, missingPayment(m[1], b));
        return sendJson(res, 200, claimPayment(m[1], b));
      }
      m = p.match(/^\/api\/orders\/([\w]+)\/messages$/);
      if (m && req.method === "POST") return sendJson(res, 200, postMessage(m[1], await readBody(req)));
      m = p.match(/^\/api\/orders\/([\w]+)\/read$/);
      if (m && req.method === "POST") return sendJson(res, 200, markRead(m[1], await readBody(req)));
      if (p === "/api/transitions") return send(res, 200, TRANSITIONS);
      if (p === "/api/events") {
        res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
        res.write(": ok\n\n");
        clients.add(res);
        req.on("close", () => clients.delete(res));
        return;
      }
      const f = path.join(__dirname, "public", p === "/" ? "index.html" : path.normalize(p).replace(/^(\.\.[\/\\])+/, ""));
      if (f.startsWith(path.join(__dirname, "public")) && fs.existsSync(f) && fs.statSync(f).isFile()) {
        const ext = path.extname(f);
        return send(res, 200, fs.readFileSync(f), { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".json": "application/json", ".css": "text/css", ".svg": "image/svg+xml" }[ext] || "application/octet-stream");
      }
      send(res, 404, { error: "not found" });
    } catch (e) {
      send(res, e.status || (e.code === "insufficient_wallet_balance" ? 402 : 400), { error: e.message, code: e.code });
    }
  });
}
async function start(port = process.env.PORT || 3000) {
  let store, initial;
  for (let i = 1; ; i++) {
    try {
      store = await openStore();
      initial = await store.load();
      break;
    } catch (e) {
      console.error(`base de datos no disponible (intento ${i}):`, e.message);
      if (i >= 5) { store = memoryStore(); initial = await store.load(); console.error("SIGO EN MEMORIA: los datos no se guardarán"); break; }
      await new Promise((r) => setTimeout(r, 2000 * i));
    }
  }
  console.log(`almacenamiento: ${store.kind}; pedidos cargados: ${initial.orders.length}`);
  return createApp({ store, initial }).listen(port, "0.0.0.0", () => console.log(`Chuzos demo en http://localhost:${port}`));
}
module.exports = { createApp, start };
if (require.main === module) start();
