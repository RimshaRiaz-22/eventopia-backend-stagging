const BUYER_VISIBLE_EVENT_STATUS = "active";

function isBuyerVisibleEventStatus(status) {
  return status === BUYER_VISIBLE_EVENT_STATUS;
}

module.exports = {
  BUYER_VISIBLE_EVENT_STATUS,
  isBuyerVisibleEventStatus,
};
