const $ = (h) => { const d = document.createElement("div"); d.innerHTML = h; return d; };
const ES = { requested:"Enviado al puesto", accepted:"Aceptado", rejected:"Rechazado", preparing:"Preparando", ready_for_pickup:"Listo para recoger", courier_assigned:"Repartidor asignado", en_route_to_merchant:"Repartidor va al puesto", picked_up:"Recogido", en_route_to_customer:"En camino a ti", delivered:"Entregado", cancelled:"Cancelado", failed:"Falló" };
const cop = (n) => "$" + n.toLocaleString("es-CO");
let stalls = [], orders = [], myOrders = JSON.parse(localStorage.myOrders || "[]"), currentStall = localStorage.stall || "demo_m2", map;
async function api(p, b) { const r = await fetch(p, b ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b) } : {}); const j = await r.json(); if (!r.ok) { alert(j.error); throw j; } return j; }
async function load() { [stalls, orders] = await Promise.all([api("/api/stalls"), api("/api/orders")]); render(); }
const mv = (id, to, role) => api(`/api/orders/${id}/transition`, { to, role }).then(load);
function orderCard(o, actions = "") { return `<div class="card"><b>${o.stall_name}</b> · ${o.id}<br><span class="st">${ES[o.status] || o.status}</span> <span class="muted">${o.delivery ? "Domicilio" : "Recoger"} · ${cop(o.total_cop)}</span><div class="muted">${o.items.map((i) => i.qty + "× " + i.name).join(", ")}</div>${actions}</div>`; }
function render() {
  const view = (location.hash || "#comprador").slice(1); document.querySelectorAll("nav a").forEach((a) => a.classList.toggle("on", a.id === "n-" + view));
  const app = document.getElementById("app"); app.innerHTML = ""; if (map) { map.remove(); map = null; }
  if (view === "comprador") {
    app.append($(`<div id="map"></div><div class="muted" style="padding:4px 10px">Chapinero, Bogotá · toca un puesto</div><div id="list"></div><h3 style="margin:10px">Mis pedidos</h3><div id="mine"></div>`));
    map = L.map("map").setView([4.6500, -74.0625], 16);
    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", { attribution: "© OpenStreetMap" }).addTo(map);
    const list = document.getElementById("list");
    stalls.forEach((s) => {
      L.marker([s.lat, s.lng]).addTo(map).bindPopup(s.name);
      list.append($(`<div class="card"><b>${s.name}</b> <span class="muted">${s.category} · ${s.address}</span>${s.menu.map((m) => `<div style="display:flex;justify-content:space-between;align-items:center;margin-top:6px"><span>${m.name}<br><span class="muted">${cop(m.price_cop)}</span></span><span><button onclick="order('${s.id}','${m.id}',false)">Recoger</button><button class="alt" onclick="order('${s.id}','${m.id}',true)">Domicilio</button></span></div>`).join("")}</div>`));
    });
    const mine = orders.filter((o) => myOrders.includes(o.id));
    document.getElementById("mine").append($(mine.map((o) => orderCard(o, o.status === "requested" ? `<button class="alt" onclick="mv('${o.id}','cancelled','customer')">Cancelar</button>` : "")).join("") || `<p class="muted" style="margin:10px">Aún no tienes pedidos.</p>`));
  }
  if (view === "puesto") {
    const s = stalls.find((x) => x.id === currentStall), w = s.wallet;
    app.append($(`<div class="card"><select onchange="localStorage.stall=currentStall=this.value;render()">${stalls.map((x) => `<option value="${x.id}" ${x.id === s.id ? "selected" : ""}>${x.name}</option>`).join("")}</select>
      <h3 style="margin:10px 0 6px">Billetera prepagada</h3><div class="wallet"><div><b>${w.orders_left}</b>pedidos disponibles</div><div><b>${cop(w.balance_cop)}</b>saldo</div><div><b>${cop(w.fee_cop)}</b>tarifa fija por pedido</div></div>
      <p class="muted">Bienvenida: 20 pedidos gratis (COP 24.000 de saldo). Sin comisión porcentual. El cobro se reembolsa si rechazas o el cliente cancela antes de aceptar.</p></div>`));
    const nxt = { requested: [["accepted", "Aceptar"], ["rejected", "Rechazar"]], accepted: [["preparing", "Empezar a preparar"]], preparing: [["ready_for_pickup", "Listo"]], ready_for_pickup: [["cancelled", "Cancelar"]] };
    orders.filter((o) => o.merchant_id === s.id).forEach((o) => app.append($(orderCard(o, (nxt[o.status] || []).map(([t, l]) => `<button ${t === "rejected" || t === "cancelled" ? 'class="alt"' : ""} onclick="mv('${o.id}','${t}','merchant')">${l}</button>`).join("")))));
  }
  if (view === "repartidor") {
    const nxt = { ready_for_pickup: [["courier_assigned", "Tomar pedido"]], courier_assigned: [["en_route_to_merchant", "Voy al puesto"]], en_route_to_merchant: [["picked_up", "Recogí el pedido"]], picked_up: [["en_route_to_customer", "Voy al cliente"]], en_route_to_customer: [["delivered", "Entregado"]] };
    const list = orders.filter((o) => o.delivery && nxt[o.status]);
    app.append($(`<h3 style="margin:10px">Pedidos a domicilio</h3>` + (list.map((o) => orderCard(o, nxt[o.status].map(([t, l]) => `<button onclick="mv('${o.id}','${t}','courier')">${l}</button>`).join(""))).join("") || `<p class="muted" style="margin:10px">No hay pedidos listos para repartir.</p>`)));
  }
}
async function order(sid, mid, delivery) {
  const s = stalls.find((x) => x.id === sid), m = s.menu.find((x) => x.id === mid);
  const o = await api("/api/orders", { stall_id: sid, items: [{ id: mid, name: m.name, qty: 1 }], delivery });
  myOrders.push(o.id); localStorage.myOrders = JSON.stringify(myOrders); load();
}
window.addEventListener("hashchange", render);
if (!location.search.includes("shot")) new EventSource("/api/events").onmessage = () => load();
load();
