const crypto = require("crypto");

function requestMeta(req, _res, next) {
  req.requestId = crypto.randomUUID();
  req.requestTimestamp = new Date().toISOString();
  next();
}

module.exports = { requestMeta };

