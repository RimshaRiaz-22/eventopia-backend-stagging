const { defaultSuccessMessage, defaultErrorMessage } = require("../utils/standardResponse");

const hasText = (v) => typeof v === "string" && v.trim() !== "";

/**
 * Makes sure every JSON envelope carries `error` (boolean) and a friendly `message`,
 * whichever style the handler used:
 *   { error: true, message }              already standard -> only a missing message is filled in
 *   { error: "SOME_CODE", message? }      code moved to `code`
 *   { error: { code, message } }          flattened
 *   { success: true|false, ... }          `error` is added, `success` is kept for existing clients
 * Anything else (health check, CSV, webhooks acknowledgements...) is left untouched.
 */
function standardize(body, status, method, req) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return body;

  let error;
  let code;
  let message = body.message;

  if (typeof body.error === "boolean") {
    error = body.error;
  } else if (typeof body.error === "string") {
    error = true;
    code = body.error;
  } else if (body.error && typeof body.error === "object") {
    error = true;
    code = body.error.code;
    message = message || body.error.message;
  } else if (typeof body.success === "boolean") {
    error = !body.success;
  } else if (status >= 400) {
    error = true;
  } else {
    return body;
  }

  const { error: _error, message: _message, ...rest } = body;
  return {
    error,
    message: hasText(message) ? message : error ? defaultErrorMessage(status) : defaultSuccessMessage(method, status, req),
    ...(code ? { code } : {}),
    ...rest,
  };
}

function ensureMessage(req, res, next) {
  const json = res.json.bind(res);
  res.json = (body) => json(standardize(body, res.statusCode, req.method, req));
  next();
}

function notFound(req, res) {
  res.status(404).json({
    error: true,
    message: "We could not find that endpoint. Please check the URL and try again.",
    code: "NOT_FOUND",
    data: null,
  });
}

// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  if (res.headersSent) return next(err);

  const status = Number.isInteger(err.status) && err.status >= 400 && err.status < 600 ? err.status : 500;
  const clientError = status < 500;
  if (!clientError) console.error("Unhandled error:", err);

  res.status(status).json({
    error: true,
    message: err.type === "entity.parse.failed"
      ? "The request body is not valid JSON. Please check it and try again."
      : defaultErrorMessage(status),
    code: err.type === "entity.parse.failed" ? "INVALID_JSON" : clientError ? "REQUEST_ERROR" : "INTERNAL_ERROR",
    data: null,
  });
}

module.exports = { ensureMessage, notFound, errorHandler };
