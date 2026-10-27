# Prepaid wallet + welcome bonus (LOCAL)

Integer cents everywhere (1 peso = 100 cents). Single pricing source: `config/prepaid_pricing.json`.

| | COP (CO) | MXN (MX) |
|---|---|---|
| Flat fee per order | 120000 (COP 1,200) | 500 (MXN 5) |
| Welcome bonus on merchant create | 2400000 (COP 24,000) = 20 orders | 10000 (MXN 100) = 20 orders |

Rule: debit fee atomically on `draft → requested` (balance < fee → `insufficient_wallet_balance`, HTTP 402, order unchanged); refund on `requested → rejected|cancelled`; no refund after `accepted`.

```bash
npm install          # ajv + @electric-sql/pglite (WASM Postgres, in-process)
npm run smoke        # JS store + fsm.transition + RPC simulator (59 checks)
npm run smoke:sql    # REAL SQL: migration path + infra/schema.sql path in PGlite (61 checks)
```

- `wallet.js` — in-memory `WalletStore` mirroring SQL (trigger, debit, refund, CHECK >= 0)
- `config.js` — reads `config/prepaid_pricing.json`
- `sql_stub_base.sql` — minimal stub of the ciclo0 base (PGlite has no PostGIS / auth.users)
