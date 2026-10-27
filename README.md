# Chuzos · prototipo demo

Esto es una **DEMO**. Los puestos, menús, pedidos y ubicaciones son datos ficticios de prueba. En `apps/web/demo_stalls.json` cada puesto va marcado `[DEMO]`. No hay cuentas reales, pagos reales ni base de datos: el servidor guarda todo en memoria y se pierde al reiniciar.

## Qué hay en el repo

- `apps/web`: servidor Node.js (HTTP y SSE), mapa Leaflet sobre OpenStreetMap, y tres vistas: Comprador (`#comprador`), Puesto (`#puesto`) y Repartidor (`#repartidor`).
- `prototypes/order-fsm`: máquina de estados del pedido. El servidor web usa `fsm.js`.
- `prototypes/wallet`: billetera prepago en memoria. El servidor web usa `wallet.js` y `config.js`.
- `config/prepaid_pricing.json`: tarifa plana y bono de bienvenida que lee la billetera (centavos enteros). En COP la tarifa es 1.200 y el bono cubre 20 pedidos.

Hace falta Node.js 18 o superior. El demo web no instala dependencias npm. Leaflet y el mapa se cargan en el navegador desde unpkg y OpenStreetMap.

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
