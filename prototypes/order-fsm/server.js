/**
 * Tiny in-memory Express-like stub (no Express dep) for order FSM smoke tests.
 * Run: node server.js  OR  node smoke_test.js
 */
const http = require("http");
const { randomUUID } = require("crypto");
const { transition, canTransition, STATUSES, TRANSITIONS } = require("./fsm");
const { defaultWalletStore, seedWalletsFromFixtures, INSUFFICIENT } = require("../wallet/wallet");

const store = new Map();

function money(cents, currency = "COP") {
  return { amount_cents: cents, currency };
}

function createOrder(body = {}) {
  const id = randomUUID();
  const now = new Date().toISOString();
  const country_code = body.country_code || "CO";
  const region_code =
    body.region_code !== undefined
      ? body.region_code
      : country_code === "MX"
        ? "MX-CMX"
        : "CO-DC";
  const currency =
    body.currency ||
    (body.subtotal && body.subtotal.currency) ||
    (country_code === "MX" ? "MXN" : "COP");
  const m = (cents) => money(cents, currency);
  const defaults =
    currency === "MXN"
      ? {
          itemName: "Taco al pastor",
          unit: 3500,
          qty: 2,
          subtotal: 7000,
          fee: 2500,
          total: 9500,
          address: "Calle Madero 45, Centro Histórico, CDMX",
          loc: { lat: 19.434, lng: -99.132 },
        }
      : {
          itemName: "Chuzo clásico",
          unit: 800000,
          qty: 2,
          subtotal: 1600000,
          fee: 300000,
          total: 1900000,
          address: "Calle 72 #10-01, Bogotá",
          loc: { lat: 4.711, lng: -74.0721 },
        };
  const order = {
    id,
    customer_id: body.customer_id || randomUUID(),
    merchant_id: body.merchant_id || randomUUID(),
    courier_id: null,
    status: "draft",
    version: 1,
    country_code,
    region_code,
    items: body.items || [
      {
        menu_item_id: randomUUID(),
        name: defaults.itemName,
        quantity: defaults.qty,
        unit_price: m(defaults.unit),
        line_total: m(defaults.subtotal),
      },
    ],
    subtotal: body.subtotal || m(defaults.subtotal),
    delivery_fee: body.delivery_fee || m(defaults.fee),
    total: body.total || m(defaults.total),
    payment_method: body.payment_method || "cash",
    payment_intent_id: null,
    delivery_location: body.delivery_location || defaults.loc,
    delivery_address_text: body.delivery_address_text || defaults.address,
    status_history: [
      { status: "draft", at: now, actor_role: "customer", actor_user_id: body.customer_id },
    ],
    created_at: now,
    updated_at: now,
  };
  store.set(id, order);
  return order;
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch (e) {
        reject(e);
      }
    });
  });
}

function send(res, code, obj) {
  const body = JSON.stringify(obj, null, 2);
  res.writeHead(code, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
  });
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      });
      return res.end();
    }

    if (req.method === "GET" && req.url === "/health") {
      return send(res, 200, { ok: true, service: "chuzos-order-fsm" });
    }

    if (req.method === "GET" && req.url === "/fsm") {
      return send(res, 200, { statuses: STATUSES, transitions: TRANSITIONS });
    }

    // Prepaid wallet: creating a merchant mirrors the SQL AFTER INSERT trigger (welcome bonus)
    if (req.method === "POST" && req.url === "/merchants") {
      const body = await readJson(req);
      const merchant = { id: body.id || randomUUID(), country_code: body.country_code || "CO", name: body.name };
      const wallet = defaultWalletStore.createMerchantWallet(merchant);
      return send(res, 201, { merchant, wallet });
    }

    if (req.method === "GET" && req.url.match(/^\/merchants\/[^/]+\/wallet$/)) {
      const id = req.url.split("/")[2];
      const wallet = defaultWalletStore.getWallet(id);
      if (!wallet) return send(res, 404, { error: "not_found" });
      return send(res, 200, wallet);
    }

    if (req.method === "POST" && req.url === "/orders") {
      const body = await readJson(req);
      return send(res, 201, createOrder(body));
    }

    if (req.method === "GET" && req.url.startsWith("/orders/")) {
      const id = req.url.split("/")[2];
      const order = store.get(id);
      if (!order) return send(res, 404, { error: "not_found" });
      return send(res, 200, order);
    }

    if (req.method === "POST" && req.url.match(/^\/orders\/[^/]+\/transition$/)) {
      const id = req.url.split("/")[2];
      const order = store.get(id);
      if (!order) return send(res, 404, { error: "not_found" });
      const body = await readJson(req);
      const { to, actor_role, actor_user_id, note, courier_id } = body;
      if (courier_id) order._pending_courier_id = courier_id;
      try {
        const next = transition(order, to, {
          actorRole: actor_role,
          actorUserId: actor_user_id,
          note,
        });
        delete next._pending_courier_id;
        store.set(id, next);
        return send(res, 200, next);
      } catch (e) {
        if (e.code === INSUFFICIENT) {
          // 402 Payment Required — order state unchanged
          return send(res, 402, { error: e.code, code: e.code, message: e.message, details: e.details });
        }
        return send(res, 409, { error: e.code || "error", message: e.message });
      }
    }

    if (req.method === "POST" && req.url === "/fsm/check") {
      const body = await readJson(req);
      return send(res, 200, canTransition(body.from, body.to, body.actor_role));
    }

    send(res, 404, { error: "route_not_found" });
  } catch (e) {
    send(res, 500, { error: e.message });
  }
});

if (require.main === module) {
  // BOG + CDMX fixture merchants get wallets with welcome bonus (same as SQL trigger)
  seedWalletsFromFixtures(defaultWalletStore);
  const port = process.env.PORT || 8787;
  server.listen(port, () => {
    console.log(`chuzos-order-fsm listening on http://127.0.0.1:${port}`);
  });
}

module.exports = { server, createOrder, store, transition };
