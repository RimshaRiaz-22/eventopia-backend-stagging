const crypto = require("crypto");

function signQRHash(payload) {
  const secret = process.env.QR_SECRET || "changeme_secret";
  return crypto.createHmac("sha256", secret).update(JSON.stringify(payload)).digest("hex");
}

function buildQR({ ticketItemId, orderId, eventId, buyerId, attendeeName, tierName }) {
  const qrPayload = {
    ticket_item_id: ticketItemId,
    order_id: orderId,
    event_id: eventId,
    buyer_id: buyerId,
    attendee_name: attendeeName,
    tier_name: tierName,
  };
  const qrCodeHash = signQRHash(qrPayload);
  return { qrPayload, qrCodeHash };
}

function verifyQRHash(hash, payload) {
  const expected = signQRHash(payload);
  return crypto.timingSafeEqual(Buffer.from(hash, "hex"), Buffer.from(expected, "hex"));
}

module.exports = {
  signQRHash,
  buildQR,
  verifyQRHash,
};
