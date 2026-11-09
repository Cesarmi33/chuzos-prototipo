# Chuzos · prototipo web (demo)
`npm start` → http://localhost:3000 (vistas `#comprador`, `#puesto`, `#repartidor`). `npm test` → 8 checks.
Sin dependencias npm. Reusa `prototypes/order-fsm/fsm.js` y `prototypes/wallet/wallet.js`. Mapa: OpenStreetMap + Leaflet (sin key).
Pago directo al puesto (código `CHZ-###`, datos DEMO) y chat del pedido entre comprador y puesto. El repartidor no ve el chat.
Los puestos en `demo_stalls.json` son FICTICIOS y van marcados [DEMO].

## Datos que se guardan
- Sin `DATABASE_URL`: todo en memoria (se borra al reiniciar). Así corren los tests.
- Con `DATABASE_URL` (Render Postgres): pedidos, chat, billeteras demo y lista de espera quedan en las tablas `chz_orders`, `chz_meta` y `chz_waitlist`. `GET /healthz` dice `"storage":"postgres"` o `"memory"`.
- `node_modules/` (solo `pg`) va en el repo porque el servicio de Render tiene Build Command `echo no-build`.

## Landing y lista de espera
- `/landing/` (español por defecto, botón EN). Archivos en `apps/web/landing/`. `?src=linkedin` guarda de dónde vino la persona.
- `POST /api/waitlist` `{email, role: buyer|stall, name?}`. No duplica el mismo correo y rol.
- `GET /api/admin/waitlist.csv?key=ADMIN_KEY` baja la lista en CSV (sin `ADMIN_KEY` responde 404).
- `POST /api/admin/reset-demo?key=ADMIN_KEY` borra los pedidos demo y repone las billeteras (no toca la lista de espera).

`npm test` corre los tests en memoria; `TEST_DATABASE_URL=... npm test` también prueba que los datos sobrevivan un reinicio.
