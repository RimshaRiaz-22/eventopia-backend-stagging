/**
 * Tier Resolver — maps ticket_price (GBP) to tier label, booking_fee, and distributable pool.
 * Day 7: booking_fee is always system-calculated; promoter never sets it.
 *
 * Bands (roadmap):
 * Tier 1: £0.01–£5.99  → £1.85
 * Tier 2: £6.00–£15.99 → £2.35
 * Tier 3: £16.00–£29.99→ £2.85
 * Tier 4: £30.00–£60.00→ £3.50
 * Tier 5: £60.01–£99.99→ £4.50
 * Tier 6: £100.00+     → £5.85
 */

const TIERS = [
  { tier_label: 1, min: 0.01, max: 5.99, booking_fee: 1.85 },
  { tier_label: 2, min: 6, max: 15.99, booking_fee: 2.35 },
  { tier_label: 3, min: 16, max: 29.99, booking_fee: 2.85 },
  { tier_label: 4, min: 30, max: 60, booking_fee: 3.5 },
  { tier_label: 5, min: 60.01, max: 99.99, booking_fee: 4.5 },
  { tier_label: 6, min: 100, max: Infinity, booking_fee: 5.85 },
];

/**
 * Resolve ticket price (GBP) to tier and booking fee.
 * @param {number} ticketPrice - Price in GBP (e.g. 10.50). Can be from API (pounds) or from DB (pence / 100).
 * @returns {{ tier_label: number, booking_fee: number, distributable_pool: number }}
 * @throws {Error} INVALID_TICKET_PRICE if price is zero, negative, or non-numeric
 */
function resolveTier(ticketPrice) {
  const price = typeof ticketPrice === "number" ? ticketPrice : parseFloat(ticketPrice);
  if (Number.isNaN(price) || price <= 0) {
    const err = new Error("INVALID_TICKET_PRICE");
    err.code = "INVALID_TICKET_PRICE";
    throw err;
  }
  const tier = TIERS.find((t) => price >= t.min && price <= t.max);
  if (!tier) {
    const err = new Error("INVALID_TICKET_PRICE");
    err.code = "INVALID_TICKET_PRICE";
    throw err;
  }
  const distributable_pool = Math.max(0, price - tier.booking_fee);
  return {
    tier_label: tier.tier_label,
    booking_fee: tier.booking_fee,
    distributable_pool,
  };
}

/**
 * Get booking fee in pence (for DB storage where price_amount is in pence).
 * @param {number} ticketPricePounds
 * @returns {number} booking_fee in pence
 */
function getBookingFeePence(ticketPricePounds) {
  const { booking_fee } = resolveTier(ticketPricePounds);
  return Math.round(booking_fee * 100);
}

module.exports = {
  resolveTier,
  getBookingFeePence,
  TIERS,
};
