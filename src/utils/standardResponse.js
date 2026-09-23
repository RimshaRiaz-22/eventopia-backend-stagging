/**
 * Standard API response helpers.
 *
 * Every API response has the same core shape:
 *   { error: boolean, message: string, data: any }
 * Helper responses also carry `meta` (request id + timestamp), and failures carry a
 * machine-readable `code` (for example "WRONG_ROLE").
 */

const { messageForRoute } = require("./responseMessages");

const SUCCESS_MESSAGES = {
  GET: "Retrieved successfully.",
  PUT: "Updated successfully.",
  PATCH: "Updated successfully.",
  DELETE: "Deleted successfully.",
};

const ERROR_MESSAGES = {
  400: "The request is not valid. Please check your input and try again.",
  401: "Please log in to continue.",
  403: "You do not have permission to do this.",
  404: "We could not find what you were looking for.",
  409: "This conflicts with existing data. Please check and try again.",
  410: "This is no longer available.",
  422: "Some of the information provided is not valid.",
  429: "Too many requests. Please wait a moment and try again.",
};

function defaultSuccessMessage(method, status, req) {
  const routeMessage = messageForRoute(req);
  if (routeMessage) return routeMessage;
  if (status === 201) return "Created successfully.";
  if (status === 202) return "Your request has been accepted.";
  return SUCCESS_MESSAGES[method] || "Request completed successfully.";
}

function defaultErrorMessage(status) {
  if (status >= 500) return "Something went wrong on our side. Please try again later.";
  return ERROR_MESSAGES[status] || ERROR_MESSAGES[400];
}

function meta(req) {
  return { requestId: req.requestId, timestamp: req.requestTimestamp };
}

/**
 * Success response.
 * @param {*} data - payload returned to the client
 * @param {string} [message] - friendly message; when omitted, the endpoint's line in
 *   utils/responseMessages.js is used, then a generic default
 * @param {number} [status=200]
 */
function ok(res, req, data, message, status = 200) {
  return res.status(status).json({
    error: false,
    message: message || defaultSuccessMessage(req.method, status, req),
    data: data ?? null,
    meta: meta(req),
  });
}

/**
 * Failure response.
 * @param {string} code - machine-readable error code, e.g. "VALIDATION_ERROR"
 * @param {string} [message] - friendly message; a sensible default is used when omitted
 */
function fail(res, req, status, code, message, details) {
  return res.status(status).json({
    error: true,
    message: message || defaultErrorMessage(status),
    code,
    ...(details ? { details } : {}),
    data: null,
    meta: meta(req),
  });
}

module.exports = { ok, fail, defaultSuccessMessage, defaultErrorMessage };
