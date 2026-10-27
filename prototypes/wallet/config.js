/**
 * Prepaid pricing — JS accessor for the SINGLE SOURCE config/prepaid_pricing.json.
 * All amounts are integer cents (1 peso = 100 cents), same unit as Money.amount_cents.
 *   COP: fee 120000 (COP 1,200) · welcome bonus 2400000 (COP 24,000)
 *   MXN: fee    500 (MXN 5)     · welcome bonus   10000 (MXN 100)
 *   => 20 free orders in both currencies (v2, 2026-10-10)
 * Do not hardcode these numbers elsewhere — import from here.
 */
const path = require("path");
const fs = require("fs");

const CONFIG_PATH = path.resolve(__dirname, "../../config/prepaid_pricing.json");
const PRICING = Object.freeze(JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8")));

const COUNTRY_TO_CURRENCY = Object.freeze({ CO: "COP", MX: "MXN" });

function currencyForCountry(countryCode) {
  const c = COUNTRY_TO_CURRENCY[countryCode];
  if (!c) throw new Error(`unsupported country_code: ${countryCode}`);
  return c;
}

function pricingFor(currency) {
  const p = PRICING.currencies[currency];
  if (!p) throw new Error(`prepaid pricing missing for currency ${currency}`);
  return p;
}

const orderFeeCents = (currency) => pricingFor(currency).order_fee_cents;
const welcomeBonusCents = (currency) => pricingFor(currency).welcome_bonus_cents;

module.exports = {
  CONFIG_PATH,
  PRICING,
  COUNTRY_TO_CURRENCY,
  currencyForCountry,
  pricingFor,
  orderFeeCents,
  welcomeBonusCents,
};
