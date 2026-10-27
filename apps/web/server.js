// Chuzos prototipo web (demo). Sin dependencias: Node http + SSE. Reusa FSM y wallet de prototypes/.
const http = require("http"), fs = require("fs"), path = require("path");
const { transition, TRANSITIONS } = require("../../prototypes/order-fsm/fsm.js");
const { WalletStore } = require("../../prototypes/wallet/wallet.js");
const FEE = 120000;

function createApp() {
  const wallets = new WalletStore();
  const stalls = JSON.parse(fs.readFileSync(path.join(__dirname, "demo_stalls.json"), "utf8"));
  stalls.forEach((s) => wallets.createMerchantWallet({ id: s.id, country_code: "CO" }));
  const orders = new Map(); let seq = 0; const clients = new Set();
  const broadcast = (o) => { const d = `data: ${JSON.stringify(o)}\n\n`; clients.forEach((c) => c.write(d)); };
  const walletView = (id) => { const b = wallets.balanceOf(id); return { balance_cop: b / 100, fee_cop: FEE / 100, orders_left: Math.floor(b / FEE) }; };

  function createOrder({ stall_id, items, delivery }) {
    const s = stalls.find((x) => x.id === stall_id); if (!s) throw Object.assign(new Error("puesto no existe"), { status: 404 });
    const total = (items || []).reduce((t, it) => { const m = s.menu.find((x) => x.id === it.id); return t + (m ? m.price_cop * (it.qty || 1) : 0); }, 0);
    let o = { id: `ord_${++seq}`, merchant_id: s.id, stall_name: s.name, items, total_cop: total, delivery: !!delivery, status: "draft", status_history: [], created_at: new Date().toISOString() };
    o = transition(o, "requested", { actorRole: "customer", wallets });
    orders.set(o.id, o); broadcast({ type: "order", order: o }); return o;
  }
  function move(id, to, role) {
    const o = orders.get(id); if (!o) throw Object.assign(new Error("pedido no existe"), { status: 404 });
    const n = transition(o, to, { actorRole: role, wallets }); orders.set(id, n); broadcast({ type: "order", order: n }); return n;
  }

  const send = (res, code, body, type = "application/json") => { res.writeHead(code, { "Content-Type": type }); res.end(type === "application/json" ? JSON.stringify(body) : body); };
  const readBody = (req) => new Promise((r) => { let d = ""; req.on("data", (c) => (d += c)); req.on("end", () => r(d ? JSON.parse(d) : {})); });

  return http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://x"); const p = url.pathname;
    try {
      if (p === "/api/stalls") return send(res, 200, stalls.map((s) => ({ ...s, wallet: walletView(s.id) })));
      if (p === "/api/orders" && req.method === "GET") return send(res, 200, [...orders.values()].reverse());
      if (p === "/api/orders" && req.method === "POST") return send(res, 201, createOrder(await readBody(req)));
      let m = p.match(/^\/api\/orders\/([\w]+)\/transition$/);
      if (m && req.method === "POST") { const b = await readBody(req); return send(res, 200, move(m[1], b.to, b.role)); }
      if (p === "/api/transitions") return send(res, 200, TRANSITIONS);
      if (p === "/api/events") { res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" }); res.write(": ok\n\n"); clients.add(res); req.on("close", () => clients.delete(res)); return; }
      const f = path.join(__dirname, "public", p === "/" ? "index.html" : path.normalize(p).replace(/^(\.\.[\/\\])+/, ""));
      if (f.startsWith(path.join(__dirname, "public")) && fs.existsSync(f) && fs.statSync(f).isFile()) {
        const ext = path.extname(f); return send(res, 200, fs.readFileSync(f), { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".json": "application/json", ".css": "text/css", ".svg": "image/svg+xml" }[ext] || "application/octet-stream");
      }
      send(res, 404, { error: "not found" });
    } catch (e) { send(res, e.status || (e.code === "insufficient_wallet_balance" ? 402 : 400), { error: e.message, code: e.code }); }
  });
}
module.exports = { createApp };
if (require.main === module) { const port = process.env.PORT || 3000; createApp().listen(port, "0.0.0.0", () => console.log(`Chuzos demo en http://localhost:${port}`)); }
