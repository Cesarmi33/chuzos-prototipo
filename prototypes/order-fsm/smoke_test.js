#!/usr/bin/env node
/**
 * Smoke test: schema validation + happy-path FSM + illegal transition rejection.
 */
const path = require("path");
const fs = require("fs");
const Ajv2020 = require("ajv/dist/2020");
const addFormats = require("ajv-formats");
const { createOrder } = require("./server");
const { transition, canTransition, STATUSES } = require("./fsm");
const { defaultWalletStore, seedWalletsFromFixtures } = require("../wallet/wallet");
const { orderFeeCents, welcomeBonusCents } = require("../wallet/config");

// Prepaid fixture: BOG seed merchant (fixtures/seed.json) with welcome-bonus wallet
seedWalletsFromFixtures(defaultWalletStore);
const BOG_MERCHANT_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

const ROOT = path.resolve(__dirname, "../../contracts");
let failed = 0;
let passed = 0;

function assert(cond, msg) {
  if (cond) {
    passed++;
    console.log(`  PASS  ${msg}`);
  } else {
    failed++;
    console.error(`  FAIL  ${msg}`);
  }
}

function loadSchemas() {
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(ajv);
  const files = [
    "common.schema.json",
    "user.schema.json",
    "merchant.schema.json",
    "courier.schema.json",
    "location_ping.schema.json",
    "menu_item.schema.json",
    "payment_intent.schema.json",
    "order.schema.json",
  ];
  for (const f of files) {
    const raw = JSON.parse(fs.readFileSync(path.join(ROOT, f), "utf8"));
    ajv.addSchema(raw);
  }
  return ajv;
}

console.log("=== Chuzos Order FSM Smoke Test ===\n");

console.log("1) Schema load + Order validation");
const ajv = loadSchemas();
const validateOrder = ajv.getSchema("https://chuzos.app/schemas/order.schema.json");
assert(!!validateOrder, "order schema compiled");

const order = createOrder({
  customer_id: "11111111-1111-4111-8111-111111111111",
  merchant_id: BOG_MERCHANT_ID,
});
const valid = validateOrder(order);
if (!valid) console.error(JSON.stringify(validateOrder.errors, null, 2));
assert(valid, "draft order validates against order.schema.json");

console.log("\n2) Happy-path transitions (customer → merchant → courier)");
const pathHappy = [
  ["requested", "customer"],
  ["accepted", "merchant"],
  ["preparing", "merchant"],
  ["ready_for_pickup", "merchant"],
  ["courier_assigned", "admin"],
  ["en_route_to_merchant", "courier"],
  ["picked_up", "courier"],
  ["en_route_to_customer", "courier"],
  ["delivered", "courier"],
];
let current = order;
current._pending_courier_id = "33333333-3333-4333-8333-333333333333";
for (const [to, role] of pathHappy) {
  try {
    current = transition(current, to, {
      actorRole: role,
      actorUserId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    });
    assert(current.status === to, `transition → ${to} as ${role}`);
  } catch (e) {
    assert(false, `transition → ${to}: ${e.message}`);
  }
}
assert(current.status === "delivered", "final status delivered");
assert(current.status_history.length === pathHappy.length + 1, "status_history length correct");
assert(
  defaultWalletStore.balanceOf(BOG_MERCHANT_ID) === welcomeBonusCents("COP") - orderFeeCents("COP"),
  `prepaid: flat fee debited once on → requested (balance ${defaultWalletStore.balanceOf(BOG_MERCHANT_ID)} cents)`
);

console.log("\n3) Illegal transitions rejected");
const bad = canTransition("delivered", "preparing", "merchant");
assert(!bad.ok, "delivered → preparing rejected");
const bad2 = canTransition("requested", "picked_up", "courier");
assert(!bad2.ok, "requested → picked_up rejected");
try {
  transition({ status: "accepted" }, "delivered", { actorRole: "courier" });
  assert(false, "should have thrown");
} catch (e) {
  assert(e.code === "ILLEGAL_TRANSITION", "throws ILLEGAL_TRANSITION");
}

console.log("\n4) Role guard");
const roleBad = canTransition("requested", "accepted", "customer");
assert(!roleBad.ok, "customer cannot accept order");

console.log("\n5) Status enum coverage");
assert(STATUSES.length === 13, `13 canonical statuses (got ${STATUSES.length})`);

console.log("\n=== RESULT ===");
console.log(`passed=${passed} failed=${failed}`);
process.exit(failed === 0 ? 0 : 1);
