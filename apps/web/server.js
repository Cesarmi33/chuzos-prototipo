// Chuzos prototipo web (demo). Sin dependencias: Node http + SSE. Reusa FSM y wallet de prototypes/.
const http = require("http"), fs = require("fs"), path = require("path");
const { transition, TRANSITIONS } = require("../../prototypes/order-fsm/fsm.js");
const { WalletStore } = require("../../prototypes/wallet/wallet.js");
const FEE = 120000;
const METHODS = new Set(["nequi", "daviplata", "breb", "cash"]);
const METHOD_LABEL = { nequi: "Nequi", daviplata: "Daviplata", breb: "Bre-B", cash: "efectivo al recoger" };
const RECEIPT_RE = /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/;
const MAX_RECEIPT = 1400000;
const MAX_BODY = 2000000;

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

function createApp() {
  const wallets = new WalletStore();
  const stalls = JSON.parse(fs.readFileSync(path.join(__dirname, "demo_stalls.json"), "utf8"));
  stalls.forEach((s) => wallets.createMerchantWallet({ id: s.id, country_code: "CO" }));
  const orders = new Map();
  let seq = 0;
  const clients = new Set();
  const codes = new Set();
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
    return o;
  }

  const send = (res, code, body, type = "application/json") => {
    res.writeHead(code, { "Content-Type": type });
    res.end(type === "application/json" ? JSON.stringify(body) : body);
  };
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
      if (p === "/api/stalls") return send(res, 200, stalls.map((s) => ({ ...s, wallet: walletView(s.id) })));
      if (p === "/api/orders" && req.method === "GET") return send(res, 200, [...orders.values()].reverse());
      if (p === "/api/orders" && req.method === "POST") return send(res, 201, createOrder(await readBody(req)));
      let m = p.match(/^\/api\/orders\/([\w]+)\/transition$/);
      if (m && req.method === "POST") {
        const b = await readBody(req);
        return send(res, 200, move(m[1], b.to, b.role));
      }
      m = p.match(/^\/api\/orders\/([\w]+)\/payment$/);
      if (m && req.method === "POST") {
        const b = await readBody(req);
        if (b.action === "confirm") return send(res, 200, confirmPayment(m[1], b));
        if (b.action === "missing") return send(res, 200, missingPayment(m[1], b));
        return send(res, 200, claimPayment(m[1], b));
      }
      m = p.match(/^\/api\/orders\/([\w]+)\/messages$/);
      if (m && req.method === "POST") return send(res, 200, postMessage(m[1], await readBody(req)));
      m = p.match(/^\/api\/orders\/([\w]+)\/read$/);
      if (m && req.method === "POST") return send(res, 200, markRead(m[1], await readBody(req)));
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
module.exports = { createApp };
if (require.main === module) {
  const port = process.env.PORT || 3000;
  createApp().listen(port, "0.0.0.0", () => console.log(`Chuzos demo en http://localhost:${port}`));
}
