# Chuzos · prototipo demo

Esto es una **DEMO**. Los puestos, menús, pedidos y ubicaciones son datos ficticios de prueba. En `apps/web/demo_stalls.json` cada puesto va marcado `[DEMO]`. No hay cuentas reales, pagos reales ni base de datos: el servidor guarda todo en memoria y se pierde al reiniciar.

## Qué hay en el repo

- `apps/web`: servidor Node.js (HTTP y SSE), mapa Leaflet sobre OpenStreetMap, y tres vistas: Comprador (`#comprador`), Puesto (`#puesto`) y Repartidor (`#repartidor`).
- `prototypes/order-fsm`: máquina de estados del pedido. El servidor web usa `fsm.js`.
- `prototypes/wallet`: billetera prepago en memoria. El servidor web usa `wallet.js` y `config.js`.
- `config/prepaid_pricing.json`: tarifa plana y bono de bienvenida que lee la billetera (centavos enteros). En COP la tarifa es 1.200 y el bono cubre 20 pedidos.

Hace falta Node.js 18 o superior. El demo web no instala dependencias npm. Leaflet y el mapa se cargan en el navegador desde unpkg y OpenStreetMap.

Cada pedido lleva un código corto (`CHZ-482`). El comprador paga directo al puesto, con datos Nequi, Daviplata o llave Bre-B marcados DEMO, o en efectivo al recoger. Chuzos no mueve ese dinero. El puesto empieza a preparar cuando marca «Pago recibido»; en efectivo confirma al entregar. Un pedido para recoger lo cierra el puesto con «Entregado», sin PIN.

El chat es de un solo pedido, solo entre comprador y puesto, en memoria, y queda de solo lectura al entregar o cancelar. El repartidor no lo ve. Nadie muestra el teléfono del otro. Los avisos de «Ya pagué», «Pago recibido», «No me llegó» y «Entregado» entran al chat y salen en vivo por SSE.

## Cómo probarlo en local

```bash
npm start
```

Abre http://localhost:3000. El proceso escucha en `0.0.0.0` y en `process.env.PORT` (si no hay `PORT`, usa el 3000).

```bash
npm test
```

Ejecuta las comprobaciones de `apps/web/test.js` (puestos demo, cobro de la tarifa, flujo hasta entregado, reembolso al rechazar y pedido sin saldo).

## Despliegue en Render

`render.yaml` define un servicio web con runtime Node, plan gratuito. El comando de arranque es `npm start`. La comprobación de salud es `GET /`, que responde 200 con la página del demo.

El plan gratuito se duerme tras un rato sin tráfico. El disco del servicio es efímero: encaja con esta demo, porque los pedidos no se persisten.
