const BUYER_VISIBLE_EVENT_STATUS = "published";

function isBuyerVisibleEventStatus(status) {
  return status === BUYER_VISIBLE_EVENT_STATUS;
}

module.exports = {
  BUYER_VISIBLE_EVENT_STATUS,
  isBuyerVisibleEventStatus,
};
