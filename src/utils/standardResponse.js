function ok(res, req, data, status = 200) {
  return res.status(status).json({
    error: false,
    data: data ?? null,
    meta: {
      requestId: req.requestId,
      timestamp: req.requestTimestamp,
    },
  });
}

function fail(res, req, status, code, message, details) {
  return res.status(status).json({
    error: true,
    error: {
      code,
      message,
      ...(details ? { details } : {}),
    },
    meta: {
      requestId: req.requestId,
      timestamp: req.requestTimestamp,
    },
  });
}

module.exports = { ok, fail };

