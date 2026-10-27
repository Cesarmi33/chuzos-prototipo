function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => "&#" + c.charCodeAt(0) + ";");
}
const $ = (h) => { const d = document.createElement("div"); d.innerHTML = h; return d; };
const ES = { requested: "Enviado al puesto", accepted: "Aceptado", rejected: "Rechazado", preparing: "Preparando", ready_for_pickup: "Listo para recoger", courier_assigned: "Repartidor asignado", en_route_to_merchant: "Repartidor va al puesto", picked_up: "Recogido", en_route_to_customer: "En camino a ti", delivered: "Entregado", cancelled: "Cancelado", failed: "Falló" };
const PAY = { unpaid: "Sin pago", claimed: "Pago por confirmar", confirmed: "Pago recibido", missing: "No llegó el pago", cash: "Efectivo al recoger" };
const METHOD = { nequi: "Nequi", daviplata: "Daviplata", breb: "Bre-B", cash: "Efectivo al recoger" };
const cop = (n) => "$" + Number(n || 0).toLocaleString("es-CO");
const RECEIPT_RE = /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/;
let stalls = [], orders = [], myOrders = JSON.parse(localStorage.myOrders || "[]"), currentStall = localStorage.stall || "demo_m2", map;
let chatOpen = null;
const chatDrafts = {};
async function api(p, b) {
  const r = await fetch(p, b ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b) } : {});
  const j = await r.json();
  if (!r.ok) { alert(j.error || "Error"); throw j; }
  return j;
}
async function load() {
  [stalls, orders] = await Promise.all([api("/api/stalls"), api("/api/orders")]);
  render();
}
const mv = (id, to, role) => api(`/api/orders/${id}/transition`, { to, role }).then(load);
function when(iso) {
  if (!iso) return "";
  return new Date(iso).toLocaleTimeString("es-CO", { hour: "2-digit", minute: "2-digit" });
}
function receiptImg(url) {
  if (!url || !RECEIPT_RE.test(url)) return "";
  return `<img class="receipt" alt="Comprobante" src="${url}">`;
}
function payFacts(o, stall) {
  const p = o.payment || {};
  const demo = stall && stall.pay_demo;
  const lines = demo ? `Nequi: ${esc(demo.nequi)}<br>Daviplata: ${esc(demo.daviplata)}<br>Llave Bre-B: ${esc(demo.breb)}<br>o efectivo al recoger` : "o efectivo al recoger";
  return `<div class="pay"><b class="code">${esc(p.code || "")}</b><br>${cop(o.total_cop)} · ${esc(PAY[p.status] || p.status || "")}${p.method ? " · " + esc(METHOD[p.method] || p.method) : ""}<div class="muted">Datos de pago DEMO (no son reales)<br>${lines}</div><p class="note">Escribe ${esc(p.code || "")} en el mensaje de la transferencia. Chuzos no recibe la plata: le pagas directo al puesto.</p>${p.status === "missing" ? `<p class="note">No me llegó. Vuelve a intentar o escríbele al puesto en el chat.</p>` : ""}${receiptImg(p.receipt_data_url)}</div>`;
}
function chatBox(o, role) {
  const open = chatOpen === o.id + ":" + role;
  const unread = role === "customer" ? o.unread_customer : o.unread_merchant;
  const badge = unread > 0 ? `<span class="badge">${unread}</span>` : "";
  const btn = `<button type="button" class="alt" data-chat-toggle="${esc(o.id)}" data-role="${role}">Chat${badge}</button>`;
  if (!open) return btn;
  const closed = o.status === "delivered" || o.status === "cancelled";
  const msgs = (o.messages || []).map((m) => {
    const roleClass = m.role === "customer" || m.role === "merchant" || m.role === "system" ? m.role : "system";
    const who = m.role === "system" ? "Aviso" : m.role === role ? "Tú" : role === "customer" ? "Puesto" : "Comprador";
    return `<div class="msg ${roleClass}"><span class="muted">${esc(who)} · ${esc(when(m.at))}</span><div>${esc(m.text)}</div>${receiptImg(m.receipt_data_url)}</div>`;
  }).join("");
  const form = closed
    ? `<p class="muted">Chat cerrado.</p>`
    : `<form class="row" data-chat="${esc(o.id)}" data-role="${role}"><input name="text" maxlength="500" placeholder="Mensaje" value="${esc(chatDrafts[o.id] || "")}"><button type="submit">Enviar</button></form>`;
  return `${btn}<div class="chat">${msgs || `<p class="muted">Aún no hay mensajes.</p>`}${form}</div>`;
}
function orderCard(o, actions, extra) {
  const items = (o.items || []).map((i) => esc((i.qty || 1) + "× " + (i.name || i.id || "ítem"))).join(", ");
  return `<div class="card"><b>${esc(o.stall_name)}</b> · ${esc(o.id)}<br><span class="st">${esc(ES[o.status] || o.status)}</span> <span class="muted">${o.delivery ? "Domicilio" : "Recoger"} · ${cop(o.total_cop)}</span><div class="muted">${items}</div>${extra || ""}${actions || ""}</div>`;
}
function buyerActions(o) {
  const p = o.payment || {};
  let payForm = "";
  if (p.status === "unpaid" || p.status === "missing") {
    payForm = `<form data-pay="${esc(o.id)}"><div class="row"><select name="method"><option value="nequi">Nequi</option><option value="daviplata">Daviplata</option><option value="breb">Llave Bre-B</option><option value="cash">Efectivo al recoger</option></select></div><div class="row"><input name="receipt" type="file" accept="image/jpeg,image/png,image/webp"><button type="submit">Ya pagué</button></div></form>`;
  } else if (p.status === "claimed") {
    payForm = `<p class="muted">Esperando que el puesto confirme el pago.</p>`;
  } else if (p.status === "cash") {
    payForm = `<p class="muted">Pagas en efectivo al recoger. El puesto confirma al entregar.</p>`;
  }
  const cancel = o.status === "requested" ? `<button type="button" class="alt" onclick="mv('${o.id}','cancelled','customer')">Cancelar</button>` : "";
  const stall = stalls.find((s) => s.id === o.merchant_id);
  return payFacts(o, stall) + payForm + chatBox(o, "customer") + cancel;
}
function vendorActions(o) {
  const p = o.payment || {};
  const canPrep = p.method === "cash" || p.status === "confirmed";
  const nxt = {
    requested: [["accepted", "Aceptar"], ["rejected", "Rechazar"]],
    accepted: canPrep ? [["preparing", "Empezar a preparar"]] : [],
    preparing: [["ready_for_pickup", "Listo"]],
    ready_for_pickup: o.delivery ? [["cancelled", "Cancelar"]] : [["delivered", "Entregado"], ["cancelled", "Cancelar"]],
  };
  const buttons = (nxt[o.status] || []).map(([t, l]) => `<button type="button" ${t === "rejected" || t === "cancelled" ? 'class="alt"' : ""} onclick="mv('${o.id}','${t}','merchant')">${l}</button>`).join("");
  const wait = o.status === "accepted" && !canPrep ? `<p class="muted">Confirma el pago para empezar a preparar.</p>` : "";
  let payBtns = "";
  if (p.status === "claimed") {
    payBtns = `<button type="button" data-pay-action="confirm" data-id="${esc(o.id)}">Pago recibido</button><button type="button" class="alt" data-pay-action="missing" data-id="${esc(o.id)}">No me llegó</button>`;
  } else if (p.method === "cash" && p.status !== "confirmed" && o.status === "delivered") {
    payBtns = `<button type="button" data-pay-action="confirm" data-id="${esc(o.id)}">Pago recibido</button>`;
  }
  const who = p.confirmed_by ? `<p class="muted">Confirmó ${esc(p.confirmed_by)} · ${esc(when(p.confirmed_at))}</p>` : "";
  return payFacts(o, stalls.find((s) => s.id === o.merchant_id)) + who + payBtns + wait + buttons + chatBox(o, "merchant");
}
function render() {
  const view = (location.hash || "#comprador").slice(1);
  document.querySelectorAll("nav a").forEach((a) => a.classList.toggle("on", a.id === "n-" + view));
  const app = document.getElementById("app");
  app.innerHTML = "";
  if (map) { map.remove(); map = null; }
  if (view === "comprador") {
    app.append($(`<div id="map"></div><div class="muted" style="padding:4px 10px">Chapinero, Bogotá · toca un puesto</div><div id="list"></div><h3 style="margin:10px">Mis pedidos</h3><div id="mine"></div>`));
    map = L.map("map").setView([4.6500, -74.0625], 16);
    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", { attribution: "© OpenStreetMap" }).addTo(map);
    const list = document.getElementById("list");
    stalls.forEach((s) => {
      L.marker([s.lat, s.lng]).addTo(map).bindPopup(esc(s.name));
      list.append($(`<div class="card"><b>${esc(s.name)}</b> <span class="muted">${esc(s.category)} · ${esc(s.address)}</span>${s.menu.map((m) => `<div style="display:flex;justify-content:space-between;align-items:center;margin-top:6px"><span>${esc(m.name)}<br><span class="muted">${cop(m.price_cop)}</span></span><span><button type="button" onclick="order('${s.id}','${m.id}',false)">Recoger</button><button type="button" class="alt" onclick="order('${s.id}','${m.id}',true)">Domicilio</button></span></div>`).join("")}</div>`));
    });
    const mine = orders.filter((o) => myOrders.includes(o.id));
    document.getElementById("mine").append($(mine.map((o) => orderCard(o, "", buyerActions(o))).join("") || `<p class="muted" style="margin:10px">Aún no tienes pedidos.</p>`));
  }
  if (view === "puesto") {
    const s = stalls.find((x) => x.id === currentStall) || stalls[0];
    const w = s.wallet;
    app.append($(`<div class="card"><select id="stall-pick">${stalls.map((x) => `<option value="${esc(x.id)}" ${x.id === s.id ? "selected" : ""}>${esc(x.name)}</option>`).join("")}</select>
      <h3 style="margin:10px 0 6px">Billetera prepagada</h3><div class="wallet"><div><b>${w.orders_left}</b>pedidos disponibles</div><div><b>${cop(w.balance_cop)}</b>saldo</div><div><b>${cop(w.fee_cop)}</b>tarifa fija por pedido</div></div>
      <p class="muted">Bienvenida: 20 pedidos gratis (COP 24.000 de saldo). Sin comisión porcentual. El cobro se reembolsa si rechazas o el cliente cancela antes de aceptar. No ves el teléfono del comprador.</p></div>`));
    orders.filter((o) => o.merchant_id === s.id).forEach((o) => app.append($(orderCard(o, "", vendorActions(o)))));
  }
  if (view === "repartidor") {
    const nxt = { ready_for_pickup: [["courier_assigned", "Tomar pedido"]], courier_assigned: [["en_route_to_merchant", "Voy al puesto"]], en_route_to_merchant: [["picked_up", "Recogí el pedido"]], picked_up: [["en_route_to_customer", "Voy al cliente"]], en_route_to_customer: [["delivered", "Entregado"]] };
    const list = orders.filter((o) => o.delivery && nxt[o.status]);
    app.append($(`<h3 style="margin:10px">Pedidos a domicilio</h3>` + (list.map((o) => orderCard(o, nxt[o.status].map(([t, l]) => `<button type="button" onclick="mv('${o.id}','${t}','courier')">${l}</button>`).join(""))).join("") || `<p class="muted" style="margin:10px">No hay pedidos listos para repartir.</p>`)));
  }
  const box = document.querySelector(".chat");
  if (box) box.scrollTop = box.scrollHeight;
}
function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    if (!file) return resolve(null);
    const type = file.type === "image/jpg" ? "image/jpeg" : file.type;
    if (!/^image\/(jpeg|png|webp)$/.test(type)) return reject(new Error("Usa una foto JPG, PNG o WebP"));
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(url);
      const max = 1280;
      const scale = Math.min(1, max / Math.max(img.width, img.height));
      const w = Math.max(1, Math.round(img.width * scale));
      const h = Math.max(1, Math.round(img.height * scale));
      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      canvas.getContext("2d").drawImage(img, 0, 0, w, h);
      let q = 0.82;
      let data = canvas.toDataURL("image/jpeg", q);
      while (data.length > 1400000 && q > 0.45) {
        q = Math.round((q - 0.1) * 10) / 10;
        data = canvas.toDataURL("image/jpeg", q);
      }
      if (data.length > 1400000) return reject(new Error("La foto supera 1 MB"));
      resolve(data);
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("No se pudo leer la foto")); };
    img.src = url;
  });
}
async function order(sid, mid, delivery) {
  const s = stalls.find((x) => x.id === sid), m = s.menu.find((x) => x.id === mid);
  const o = await api("/api/orders", { stall_id: sid, items: [{ id: mid, name: m.name, qty: 1 }], delivery });
  myOrders.push(o.id);
  localStorage.myOrders = JSON.stringify(myOrders);
  load();
}
document.getElementById("app").addEventListener("change", (ev) => {
  if (ev.target.id === "stall-pick") {
    currentStall = ev.target.value;
    localStorage.stall = currentStall;
    render();
  }
});
document.getElementById("app").addEventListener("input", (ev) => {
  const form = ev.target.closest("form[data-chat]");
  if (form && ev.target.name === "text") chatDrafts[form.dataset.chat] = ev.target.value;
});
document.getElementById("app").addEventListener("click", async (ev) => {
  const toggle = ev.target.closest("[data-chat-toggle]");
  if (toggle) {
    const key = toggle.dataset.chatToggle + ":" + toggle.dataset.role;
    if (chatOpen === key) { chatOpen = null; render(); return; }
    chatOpen = key;
    await api(`/api/orders/${toggle.dataset.chatToggle}/read`, { role: toggle.dataset.role });
    await load();
    return;
  }
  const pay = ev.target.closest("[data-pay-action]");
  if (pay) {
    await api(`/api/orders/${pay.dataset.id}/payment`, { role: "merchant", action: pay.dataset.payAction });
    await load();
  }
});
document.getElementById("app").addEventListener("submit", async (ev) => {
  const chat = ev.target.closest("form[data-chat]");
  const pay = ev.target.closest("form[data-pay]");
  if (!chat && !pay) return;
  ev.preventDefault();
  try {
    if (chat) {
      const text = chat.querySelector("[name=text]").value;
      chatDrafts[chat.dataset.chat] = "";
      await api(`/api/orders/${chat.dataset.chat}/messages`, { role: chat.dataset.role, text });
    } else {
      const method = pay.querySelector("[name=method]").value;
      const file = pay.querySelector("[name=receipt]").files[0];
      const receipt_data_url = file && method !== "cash" ? await fileToDataUrl(file) : null;
      await api(`/api/orders/${pay.dataset.pay}/payment`, { role: "customer", action: "claim", method, receipt_data_url });
    }
    await load();
  } catch (e) {
    if (e && e.message && !e.error) alert(e.message);
  }
});
window.addEventListener("hashchange", render);
if (!location.search.includes("shot")) new EventSource("/api/events").onmessage = () => load();
load();
