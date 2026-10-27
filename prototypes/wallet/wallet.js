/**
 * In-memory prepaid merchant wallet — mirror of SQL (infra/schema.sql prepaid_wallet section +
 * supabase/migrations/20261006210000_prepaid_wallet.sql). Zero network / zero Supabase.
 *
 * Rules (identical to SQL):
 *  - createMerchantWallet(merchant)  == AFTER INSERT trigger on merchants: wallet in the
 *    merchant's region currency (CO→COP, MX→MXN) credited with the welcome bonus.
 *  - debitOrderFee(merchantId, orderId): on draft → requested. balance < fee (or no wallet)
 *    → WalletError code "insufficient_wallet_balance"; nothing changes.
 *  - refundOrderFee(orderId): on requested → rejected | requested → cancelled. Idempotent.
 *  - balance_cents is an integer and never < 0 (guard = SQL CHECK balance_cents >= 0).
 */
const fs = require("fs");
const path = require("path");
const { currencyForCountry, orderFeeCents, welcomeBonusCents } = require("./config");

const INSUFFICIENT = "insufficient_wallet_balance";
const SEED_PATH = path.resolve(__dirname, "../../fixtures/seed.json");

class WalletError extends Error {
  constructor(code, message, details) {
    super(message || code);
    this.code = code;
    if (details) this.details = details;
  }
}

function assertValidBalance(balanceCents) {
  if (!Number.isInteger(balanceCents) || balanceCents < 0) {
    // Same constraint name as SQL: merchant_wallets_balance_cents_check
    throw new WalletError(
      "check_violation",
      `merchant_wallets_balance_cents_check: balance_cents must be an integer >= 0 (got ${balanceCents})`
    );
  }
}

class WalletStore {
  constructor() {
    this.wallets = new Map(); // merchant_id -> wallet row
    this.ledger = []; // append-only
  }

  reset() {
    this.wallets.clear();
    this.ledger = [];
  }

  /** Mirror of trg_merchants_create_wallet (AFTER INSERT on merchants). Idempotent. */
  createMerchantWallet(merchant) {
    if (!merchant || !merchant.id) throw new Error("createMerchantWallet requires merchant.id");
    if (this.wallets.has(merchant.id)) return this.getWallet(merchant.id);
    const currency = currencyForCountry(merchant.country_code || "CO");
    const bonus = welcomeBonusCents(currency);
    const now = new Date().toISOString();
    this._write(merchant.id, { merchant_id: merchant.id, balance_cents: bonus, currency, created_at: now, updated_at: now });
    if (bonus > 0) this._append(merchant.id, null, "welcome_bonus", bonus, currency);
    return this.getWallet(merchant.id);
  }

  getWallet(merchantId) {
    const w = this.wallets.get(merchantId);
    return w ? { ...w } : null;
  }

  balanceOf(merchantId) {
    const w = this.wallets.get(merchantId);
    return w ? w.balance_cents : 0;
  }

  /** Test/admin hook — still enforces the non-negative CHECK. */
  setBalance(merchantId, balanceCents) {
    const w = this.wallets.get(merchantId);
    if (!w) throw new WalletError("not_found", `wallet for merchant ${merchantId} not found`);
    this._write(merchantId, { ...w, balance_cents: balanceCents, updated_at: new Date().toISOString() });
    return this.getWallet(merchantId);
  }

  /** Throws insufficient_wallet_balance unless balance >= flat fee. Pure check, no mutation. */
  assertCanPayFee(merchantId) {
    const w = this.wallets.get(merchantId);
    if (!w) {
      throw new WalletError(INSUFFICIENT, `merchant ${merchantId} has no wallet (balance treated as 0)`, {
        merchant_id: merchantId,
        balance_cents: 0,
      });
    }
    const fee = orderFeeCents(w.currency);
    if (w.balance_cents < fee) {
      throw new WalletError(
        INSUFFICIENT,
        `merchant ${merchantId} balance ${w.balance_cents} < fee ${fee} ${w.currency} cents`,
        { merchant_id: merchantId, balance_cents: w.balance_cents, fee_cents: fee, currency: w.currency }
      );
    }
    return { wallet: w, fee };
  }

  /** draft → requested. Returns new balance. */
  debitOrderFee(merchantId, orderId) {
    const { wallet, fee } = this.assertCanPayFee(merchantId);
    if (orderId && this.ledger.some((l) => l.order_id === orderId && l.kind === "order_fee_debit")) {
      // mirrors unique (order_id, kind) — an order is charged at most once
      throw new WalletError("duplicate_fee_debit", `order ${orderId} already charged`);
    }
    const next = wallet.balance_cents - fee;
    this._write(merchantId, { ...wallet, balance_cents: next, updated_at: new Date().toISOString() });
    this._append(merchantId, orderId || null, "order_fee_debit", -fee, wallet.currency);
    return next;
  }

  /** requested → rejected|cancelled. Returns new balance, or null when nothing to refund. */
  refundOrderFee(orderId) {
    const debit = this.ledger.find((l) => l.order_id === orderId && l.kind === "order_fee_debit");
    if (!debit) return null;
    if (this.ledger.some((l) => l.order_id === orderId && l.kind === "order_fee_refund")) return null;
    const w = this.wallets.get(debit.merchant_id);
    const next = w.balance_cents + -debit.amount_cents;
    this._write(debit.merchant_id, { ...w, balance_cents: next, updated_at: new Date().toISOString() });
    this._append(debit.merchant_id, orderId, "order_fee_refund", -debit.amount_cents, debit.currency);
    return next;
  }

  ledgerFor(merchantId) {
    return this.ledger.filter((l) => l.merchant_id === merchantId).map((l) => ({ ...l }));
  }

  _write(merchantId, row) {
    assertValidBalance(row.balance_cents);
    this.wallets.set(merchantId, row);
  }

  _append(merchantId, orderId, kind, amountCents, currency) {
    this.ledger.push({
      id: this.ledger.length + 1,
      merchant_id: merchantId,
      order_id: orderId,
      kind,
      amount_cents: amountCents,
      balance_after_cents: this.wallets.get(merchantId).balance_cents,
      currency,
      created_at: new Date().toISOString(),
    });
  }
}

/** Process-wide default store used by order-fsm transition() when no store is injected. */
const defaultWalletStore = new WalletStore();

/**
 * Seed wallets for every merchant in fixtures/seed.json (BOG + CDMX) exactly as the SQL
 * trigger would (welcome bonus). Returns the store.
 */
function seedWalletsFromFixtures(store = defaultWalletStore) {
  const seed = JSON.parse(fs.readFileSync(SEED_PATH, "utf8"));
  for (const m of seed.merchants || []) store.createMerchantWallet(m);
  return store;
}

module.exports = {
  INSUFFICIENT,
  WalletError,
  WalletStore,
  defaultWalletStore,
  seedWalletsFromFixtures,
  assertValidBalance,
};
