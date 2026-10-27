/**
 * Chuzos Order FSM — canonical transitions.
 * Source of truth mirrored in /domain/order-state-machine.md
 * Agents MUST import this (or generated equivalent); do not invent transitions.
 *
 * Prepaid wallet gate (2026-10-06, mirrors SQL transition_order):
 *  - Entering `requested` strictly requires merchant wallet balance >= flat fee
 *    (COP 120000 / MXN 500 cents, config/prepaid_pricing.json). Otherwise throws
 *    err.code = "insufficient_wallet_balance" and the order is NOT changed.
 *    On success the fee is debited from the wallet atomically with the transition.
 *  - requested → rejected | requested → cancelled refunds the fee. No refund after accepted.
 *  - Wallet store: opts.wallets (WalletStore) or the process default store
 *    (../wallet/wallet.js defaultWalletStore). Missing wallet = balance 0 = blocked.
 */
const { defaultWalletStore } = require("../wallet/wallet");

const STATUSES = Object.freeze([
  "draft",
  "requested",
  "accepted",
  "rejected",
  "preparing",
  "ready_for_pickup",
  "courier_assigned",
  "en_route_to_merchant",
  "picked_up",
  "en_route_to_customer",
  "delivered",
  "cancelled",
  "failed",
]);

/** from -> allowed next statuses */
const TRANSITIONS = Object.freeze({
  draft: ["requested", "cancelled"],
  requested: ["accepted", "rejected", "cancelled"],
  accepted: ["preparing", "cancelled"],
  rejected: [], // terminal
  preparing: ["ready_for_pickup", "cancelled"],
  ready_for_pickup: ["courier_assigned", "cancelled"],
  courier_assigned: ["en_route_to_merchant", "cancelled", "failed"],
  en_route_to_merchant: ["picked_up", "failed", "cancelled"],
  picked_up: ["en_route_to_customer", "failed"],
  en_route_to_customer: ["delivered", "failed"],
  delivered: [], // terminal
  cancelled: [], // terminal
  failed: [], // terminal
});

/** who may trigger each transition (target status -> roles) */
const ACTORS = Object.freeze({
  requested: ["customer"],
  accepted: ["merchant"],
  rejected: ["merchant"],
  preparing: ["merchant"],
  ready_for_pickup: ["merchant"],
  courier_assigned: ["admin", "courier", "system"],
  en_route_to_merchant: ["courier"],
  picked_up: ["courier"],
  en_route_to_customer: ["courier"],
  delivered: ["courier", "customer"],
  cancelled: ["customer", "merchant", "admin"],
  failed: ["courier", "admin", "system"],
});

function canTransition(from, to, actorRole = null) {
  if (!STATUSES.includes(from) || !STATUSES.includes(to)) {
    return { ok: false, reason: `unknown status: ${from} -> ${to}` };
  }
  const allowed = TRANSITIONS[from] || [];
  if (!allowed.includes(to)) {
    return { ok: false, reason: `illegal transition: ${from} -> ${to}` };
  }
  if (actorRole) {
    const roles = ACTORS[to] || [];
    if (!roles.includes(actorRole) && actorRole !== "admin" && actorRole !== "system") {
      return { ok: false, reason: `role ${actorRole} cannot set status ${to}` };
    }
  }
  return { ok: true };
}

function transition(order, to, { actorRole, actorUserId, note, at, wallets } = {}) {
  const check = canTransition(order.status, to, actorRole);
  if (!check.ok) {
    const err = new Error(check.reason);
    err.code = "ILLEGAL_TRANSITION";
    throw err;
  }
  // Prepaid wallet gate — after FSM/role checks, before any state change.
  const walletStore = wallets || defaultWalletStore;
  if (to === "requested") {
    // throws WalletError { code: "insufficient_wallet_balance" } → order untouched
    walletStore.debitOrderFee(order.merchant_id, order.id);
  }
  if (order.status === "requested" && (to === "rejected" || to === "cancelled")) {
    walletStore.refundOrderFee(order.id);
  }

  const ts = at || new Date().toISOString();
  const history = Array.isArray(order.status_history) ? [...order.status_history] : [];
  history.push({
    status: to,
    at: ts,
    actor_role: actorRole || "system",
    actor_user_id: actorUserId,
    note: note || undefined,
  });
  const next = {
    ...order,
    status: to,
    status_history: history,
    updated_at: ts,
  };
  if (to === "courier_assigned" && order._pending_courier_id) {
    next.courier_id = order._pending_courier_id;
  }
  return next;
}

module.exports = { STATUSES, TRANSITIONS, ACTORS, canTransition, transition };
