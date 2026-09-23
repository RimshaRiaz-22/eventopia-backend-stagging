/**
 * Territory inventory constants.
 */

const UI_STATUS = {
  AVAILABLE: "AVAILABLE",
  WAITLIST: "WAITLIST",
  LOCKED: "LOCKED",
};

const TERRITORY_STATUS = {
  ACTIVE: "ACTIVE",
  LOCKED: "LOCKED",
  UPCOMING: "UPCOMING",
  DISABLED: "DISABLED",
};

/** Licences that hold a slot (count toward max_slots) */
const LICENCE_STATUSES_HOLDING_SLOT = ["ACTIVE", "CLEARED"];

module.exports = {
  UI_STATUS,
  TERRITORY_STATUS,
  LICENCE_STATUSES_HOLDING_SLOT,
};
