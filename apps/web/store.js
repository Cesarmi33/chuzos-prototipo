// Persistencia opcional. Sin DATABASE_URL todo vive en memoria (igual que antes, y así corren los tests).
// Con DATABASE_URL (Render Postgres) se guardan pedidos, chat, billeteras demo y la lista de espera.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS chz_orders (
  id text PRIMARY KEY,
  data jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS chz_meta (
  key text PRIMARY KEY,
  data jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS chz_waitlist (
  id serial PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT now(),
  name text,
  email text NOT NULL,
  role text NOT NULL CHECK (role IN ('buyer','stall')),
  lang text,
  source text,
  UNIQUE (email, role)
);`;

function memoryStore() {
  const waitlist = [];
  return {
    kind: "memory",
    async load() { return { orders: [], meta: null }; },
    async saveOrder() {},
    async saveMeta() {},
    async resetDemo() {},
    async addSignup(s) {
      const i = waitlist.findIndex((w) => w.email === s.email && w.role === s.role);
      const row = { ...s, created_at: new Date().toISOString() };
      if (i >= 0) { waitlist[i] = { ...waitlist[i], name: s.name || waitlist[i].name }; return { created: false }; }
      waitlist.push({ id: waitlist.length + 1, ...row });
      return { created: true };
    },
    async listSignups() { return waitlist.slice(); },
    async close() {},
  };
}

async function pgStore(url) {
  const { Pool } = require("pg");
  const local = /@(localhost|127\.0\.0\.1|dpg-[a-z0-9]+-a)(:\d+)?\//.test(url) || /sslmode=disable/.test(url);
  const pool = new Pool({ connectionString: url, max: 3, ssl: local ? false : { rejectUnauthorized: false } });
  pool.on("error", (e) => console.error("pg pool error:", e.message));
  await pool.query(SCHEMA);
  let chain = Promise.resolve();
  const serial = (fn) => (chain = chain.then(fn, fn));
  return {
    kind: "postgres",
    async load() {
      const o = await pool.query("SELECT data FROM chz_orders ORDER BY created_at, id");
      const m = await pool.query("SELECT data FROM chz_meta WHERE key = 'state'");
      return { orders: o.rows.map((r) => r.data), meta: m.rows[0] ? m.rows[0].data : null };
    },
    saveOrder(order, meta) {
      return serial(async () => {
        const c = await pool.connect();
        try {
          await c.query("BEGIN");
          if (order) {
            await c.query(
              "INSERT INTO chz_orders (id, data) VALUES ($1, $2) ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, updated_at = now()",
              [order.id, JSON.stringify(order)]
            );
          }
          if (meta) {
            await c.query(
              "INSERT INTO chz_meta (key, data) VALUES ('state', $1) ON CONFLICT (key) DO UPDATE SET data = EXCLUDED.data, updated_at = now()",
              [JSON.stringify(meta)]
            );
          }
          await c.query("COMMIT");
        } catch (e) {
          await c.query("ROLLBACK").catch(() => {});
          throw e;
        } finally {
          c.release();
        }
      });
    },
    saveMeta(meta) { return this.saveOrder(null, meta); },
    resetDemo() {
      return serial(async () => {
        await pool.query("DELETE FROM chz_orders");
        await pool.query("DELETE FROM chz_meta WHERE key = 'state'");
      });
    },
    async addSignup(s) {
      const r = await pool.query(
        `INSERT INTO chz_waitlist (name, email, role, lang, source) VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (email, role) DO UPDATE SET name = COALESCE(EXCLUDED.name, chz_waitlist.name)
         RETURNING (xmax = 0) AS created`,
        [s.name || null, s.email, s.role, s.lang || null, s.source || null]
      );
      return { created: !!r.rows[0].created };
    },
    async listSignups() {
      const r = await pool.query("SELECT id, created_at, name, email, role, lang, source FROM chz_waitlist ORDER BY created_at");
      return r.rows.map((x) => ({ ...x, created_at: new Date(x.created_at).toISOString() }));
    },
    async close() { await chain.catch(() => {}); await pool.end(); },
  };
}

async function openStore(url = process.env.DATABASE_URL) {
  return url ? pgStore(url) : memoryStore();
}

module.exports = { openStore, memoryStore };
