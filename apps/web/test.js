const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { createApp } = require("./server.js");
const TINY_PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

(async () => {
  const srv = createApp().listen(0);
  const base = `http://localhost:${srv.address().port}`;
  const post = (p, b) => fetch(base + p, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b) }).then(async (r) => ({ s: r.status, j: await r.json() }));
  let ok = 0;
  const t = (n, f) => { f(); ok++; console.log("  PASS", n); };
  const stalls = await (await fetch(base + "/api/stalls")).json();
  t("4 puestos demo marcados [DEMO]", () => { assert.equal(stalls.length, 4); stalls.forEach((s) => assert(s.name.startsWith("[DEMO]"))); });
  t("pagos demo sin teléfono", () => {
    stalls.forEach((s) => {
      assert.ok(s.pay_demo.nequi && s.pay_demo.daviplata && s.pay_demo.breb);
      assert.equal(s.phone, undefined);
      assert.equal(s.whatsapp, undefined);
    });
  });
  t("billetera inicial 20 pedidos", () => assert.equal(stalls[0].wallet.orders_left, 20));
  const { j: o } = await post("/api/orders", { stall_id: "demo_m2", items: [{ id: "c1", name: "x", qty: 2 }], delivery: true });
  t("pedido requested, total 24000", () => { assert.equal(o.status, "requested"); assert.equal(o.total_cop, 24000); });
  t("código CHZ sin teléfono", () => {
    assert.match(o.payment.code, /^CHZ-\d{3}$/);
    assert.equal(o.phone, undefined);
    assert.equal(o.buyer_phone, undefined);
    assert.equal(JSON.stringify(o).includes("wa.me"), false);
  });
  const w = (await (await fetch(base + "/api/stalls")).json()).find((s) => s.id === "demo_m2").wallet;
  t("cobra COP 1.200 → 19 pedidos", () => { assert.equal(w.orders_left, 19); assert.equal(w.balance_cop, 22800); });
  const bad = await post(`/api/orders/${o.id}/transition`, { to: "accepted", role: "customer" });
  t("comprador no puede aceptar (400)", () => assert.equal(bad.s, 400));
  await post(`/api/orders/${o.id}/transition`, { to: "accepted", role: "merchant" });
  const early = await post(`/api/orders/${o.id}/transition`, { to: "preparing", role: "merchant" });
  t("sin pago confirmado no se prepara", () => { assert.equal(early.s, 400); assert.equal(early.j.code, "PAYMENT_REQUIRED"); });
  const claim = await post(`/api/orders/${o.id}/payment`, { role: "customer", action: "claim", method: "nequi", receipt_data_url: TINY_PNG });
  t("Ya pagué guarda método, foto y aviso", () => {
    assert.equal(claim.s, 200);
    assert.equal(claim.j.payment.status, "claimed");
    assert.equal(claim.j.payment.method, "nequi");
    assert.equal(claim.j.payment.receipt_data_url, TINY_PNG);
    assert.equal(claim.j.payment.claimed_by, "customer");
    const msg = claim.j.messages.find((m) => m.role === "system" && m.text.includes("Ya pagué"));
    assert.ok(msg && msg.at && msg.receipt_data_url === TINY_PNG);
    assert.equal(claim.j.unread_merchant, 1);
  });
  const okPay = await post(`/api/orders/${o.id}/payment`, { role: "merchant", action: "confirm" });
  t("Pago recibido anota quién y cuándo", () => {
    assert.equal(okPay.j.payment.status, "confirmed");
    assert.equal(okPay.j.payment.confirmed_by, "merchant");
    assert.ok(okPay.j.payment.confirmed_at);
    assert.ok(okPay.j.messages.some((m) => m.role === "system" && m.text.includes("Pago recibido")));
  });
  let last;
  for (const [to, role] of [["preparing", "merchant"], ["ready_for_pickup", "merchant"], ["courier_assigned", "courier"], ["en_route_to_merchant", "courier"], ["picked_up", "courier"], ["en_route_to_customer", "courier"], ["delivered", "courier"]]) last = await post(`/api/orders/${o.id}/transition`, { to, role });
  t("flujo completo hasta delivered", () => assert.equal(last.j.status, "delivered"));
  t("Entregado entra al chat", () => assert.ok(last.j.messages.some((m) => m.role === "system" && m.text.includes("Entregado"))));
  const closedChat = await post(`/api/orders/${o.id}/messages`, { role: "customer", text: "¿llegó?" });
  t("chat cerrado al entregar", () => assert.equal(closedChat.s, 400));
  const { j: o2 } = await post("/api/orders", { stall_id: "demo_m1", items: [{ id: "a1", qty: 1 }] });
  await post(`/api/orders/${o2.id}/transition`, { to: "rejected", role: "merchant" });
  const w1 = (await (await fetch(base + "/api/stalls")).json()).find((s) => s.id === "demo_m1").wallet;
  t("rechazo reembolsa tarifa", () => assert.equal(w1.orders_left, 20));
  for (let i = 0; i < 20; i++) await post("/api/orders", { stall_id: "demo_m3", items: [] });
  const r21 = await post("/api/orders", { stall_id: "demo_m3", items: [] });
  t("pedido 21 sin saldo → 402", () => { assert.equal(r21.s, 402); assert.equal(r21.j.code, "insufficient_wallet_balance"); });

  const { j: missOrder } = await post("/api/orders", { stall_id: "demo_m2", items: [{ id: "c2", name: "pollo", qty: 1 }], delivery: false });
  await post(`/api/orders/${missOrder.id}/transition`, { to: "accepted", role: "merchant" });
  await post(`/api/orders/${missOrder.id}/payment`, { role: "customer", action: "claim", method: "daviplata" });
  const missing = await post(`/api/orders/${missOrder.id}/payment`, { role: "merchant", action: "missing" });
  t("No me llegó avisa y deja reintentar", () => {
    assert.equal(missing.j.payment.status, "missing");
    assert.equal(missing.j.payment.missing_by, "merchant");
    assert.ok(missing.j.messages.some((m) => m.text.includes("No me llegó")));
    assert.equal(missing.j.unread_customer > 0, true);
  });
  const again = await post(`/api/orders/${missOrder.id}/payment`, { role: "customer", action: "claim", method: "breb" });
  t("reintento de pago", () => assert.equal(again.j.payment.status, "claimed"));

  const { j: pick } = await post("/api/orders", { stall_id: "demo_m4", items: [{ id: "s1", name: "salchi", qty: 1 }], delivery: false });
  await post(`/api/orders/${pick.id}/transition`, { to: "accepted", role: "merchant" });
  const cash = await post(`/api/orders/${pick.id}/payment`, { role: "customer", action: "claim", method: "cash" });
  t("efectivo deja preparar", () => assert.equal(cash.j.payment.status, "cash"));
  const prep = await post(`/api/orders/${pick.id}/transition`, { to: "preparing", role: "merchant" });
  assert.equal(prep.s, 200);
  await post(`/api/orders/${pick.id}/transition`, { to: "ready_for_pickup", role: "merchant" });
  const courierClose = await post(`/api/orders/${pick.id}/transition`, { to: "delivered", role: "courier" });
  t("recoger lo cierra el puesto, sin PIN", () => assert.equal(courierClose.s, 400));
  const done = await post(`/api/orders/${pick.id}/transition`, { to: "delivered", role: "merchant" });
  t("Entregado confirma el efectivo", () => {
    assert.equal(done.s, 200);
    assert.equal(done.j.status, "delivered");
    assert.equal(done.j.payment.confirmed_by, "merchant");
    assert.ok(done.j.payment.confirmed_at);
    assert.equal(done.j.pin, undefined);
  });
  const { j: dom } = await post("/api/orders", { stall_id: "demo_m4", items: [{ id: "s1", name: "salchi", qty: 1 }], delivery: true });
  await post(`/api/orders/${dom.id}/transition`, { to: "accepted", role: "merchant" });
  await post(`/api/orders/${dom.id}/payment`, { role: "customer", action: "claim", method: "cash" });
  await post(`/api/orders/${dom.id}/transition`, { to: "preparing", role: "merchant" });
  await post(`/api/orders/${dom.id}/transition`, { to: "ready_for_pickup", role: "merchant" });
  const merchantJump = await post(`/api/orders/${dom.id}/transition`, { to: "delivered", role: "merchant" });
  t("el puesto no cierra un domicilio", () => {
    assert.equal(merchantJump.s, 400);
    assert.equal(merchantJump.j.code, "ILLEGAL_TRANSITION");
  });
  await post(`/api/orders/${dom.id}/transition`, { to: "courier_assigned", role: "courier" });
  await post(`/api/orders/${dom.id}/transition`, { to: "en_route_to_merchant", role: "courier" });
  await post(`/api/orders/${dom.id}/transition`, { to: "picked_up", role: "courier" });
  await post(`/api/orders/${dom.id}/transition`, { to: "en_route_to_customer", role: "courier" });
  const domDone = await post(`/api/orders/${dom.id}/transition`, { to: "delivered", role: "courier" });
  const earlyCash = await post(`/api/orders/${dom.id}/payment`, { role: "merchant", action: "confirm" });
  t("efectivo de domicilio se confirma al entregar", () => {
    assert.equal(domDone.j.status, "delivered");
    assert.equal(domDone.j.payment.status, "cash");
    assert.equal(earlyCash.s, 200);
    assert.equal(earlyCash.j.payment.confirmed_by, "merchant");
    assert.ok(earlyCash.j.payment.confirmed_at);
    assert.ok(earlyCash.j.messages.some((m) => m.text.includes("Pago recibido")));
  });

  const { j: chatOrder } = await post("/api/orders", { stall_id: "demo_m4", items: [{ id: "s2", name: "mazorca", qty: 1 }], delivery: false });
  const hi = await post(`/api/orders/${chatOrder.id}/messages`, { role: "customer", text: "Hola <b>puesto</b>" });
  t("chat guarda rol, hora y texto plano", () => {
    const msg = hi.j.messages.find((m) => m.role === "customer");
    assert.equal(hi.s, 200);
    assert.equal(msg.text, "Hola <b>puesto</b>");
    assert.ok(msg.at);
    assert.equal(hi.j.unread_merchant, 1);
    assert.equal(hi.j.unread_customer, 0);
  });
  const tooLong = await post(`/api/orders/${chatOrder.id}/messages`, { role: "merchant", text: "a".repeat(501) });
  t("mensaje de más de 500 se rechaza", () => assert.equal(tooLong.s, 400));
  const courierChat = await post(`/api/orders/${chatOrder.id}/messages`, { role: "courier", text: "voy" });
  t("el repartidor no escribe en el chat", () => { assert.equal(courierChat.s, 403); assert.equal(courierChat.j.code, "FORBIDDEN"); });
  const read = await post(`/api/orders/${chatOrder.id}/read`, { role: "merchant" });
  t("el puesto marca leído", () => assert.equal(read.j.unread_merchant, 0));
  const huge = "data:image/jpeg;base64," + "A".repeat(1400001);
  const big = await post(`/api/orders/${chatOrder.id}/payment`, { role: "customer", action: "claim", method: "nequi", receipt_data_url: huge });
  t("foto mayor a 1 MB se rechaza", () => assert.equal(big.s, 413));

  const sse = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("sse timeout")), 2000);
    fetch(base + "/api/events").then(async (res) => {
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      const wait = (async () => {
        while (true) {
          const { value, done: streamDone } = await reader.read();
          if (streamDone) throw new Error("sse closed");
          buf += dec.decode(value, { stream: true });
          const parts = buf.split("\n\n");
          buf = parts.pop();
          for (const part of parts) {
            const line = part.split("\n").find((l) => l.startsWith("data: "));
            if (!line) continue;
            const ev = JSON.parse(line.slice(6));
            if (ev.type === "order" && ev.order.id === chatOrder.id && ev.order.messages.some((m) => m.text === "ping vivo")) return ev;
          }
        }
      })();
      wait.then((ev) => { clearTimeout(timer); reader.cancel(); resolve(ev); }, (e) => { clearTimeout(timer); reader.cancel(); reject(e); });
      await post(`/api/orders/${chatOrder.id}/messages`, { role: "merchant", text: "ping vivo" });
    }).catch((e) => { clearTimeout(timer); reject(e); });
  });
  t("el chat sale por SSE", () => assert.equal(sse.order.messages.some((m) => m.text === "ping vivo" && m.role === "merchant"), true));

  const appJs = fs.readFileSync(path.join(__dirname, "public/app.js"), "utf8");
  const escStart = appJs.indexOf("function esc(s)");
  const escEnd = appJs.indexOf("\n}", escStart);
  const esc = new Function(appJs.slice(escStart, escEnd + 2) + "\nreturn esc;")();
  t("el chat escapa HTML y no hay WhatsApp", () => {
    assert.equal(esc(`<img src=x onerror="alert(1)">`), "&#60;img src=x onerror=&#34;alert(1)&#34;&#62;");
    assert.ok(appJs.includes("esc(m.text)"));
    assert.equal(/wa\.me/i.test(appJs), false);
    assert.equal(/whatsapp/i.test(appJs), false);
    const rep = appJs.split('view === "repartidor"')[1];
    assert.equal(rep.includes("chatBox"), false);
    assert.equal(rep.includes("payFacts"), false);
  });

  console.log(`passed=${ok} failed=0`);
  srv.close();
})().catch((e) => { console.error("FAIL", e); process.exit(1); });
