/**
 * Per-ticket credit split in pence, by price tier.
 * Single source of truth: allocateCredit pays from it and the Credit Engine tab displays it.
 *
 * The Guru role no longer exists, so the share that used to be credited to a Guru (`retained`)
 * is kept by Eventopia. It is not credited to any role, except that an active promoter referral
 * is paid out of it.
 */
const TIER_CREDIT_SPLITS_PENCE = {
  1: { promoter: 50, retained: 30 },
  2: { promoter: 65, retained: 40 },
  3: { promoter: 95, retained: 55 },
  4: { promoter: 130, retained: 75 },
  5: { promoter: 180, retained: 100 },
  6: { promoter: 250, retained: 140 },
};

module.exports = { TIER_CREDIT_SPLITS_PENCE };
