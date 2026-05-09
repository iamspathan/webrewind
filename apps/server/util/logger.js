// Minimal structured logger. Dependency-free on purpose — swap for pino later
// if the project grows to warrant it.
//
// Usage:
//   const log = require("./util/logger");
//   log.info("server starting", { port: 3200 });
//   log.info("capture started", { jobId, url });
//   log.warn("gif failed", { jobId, reason: e.message });
//   log.error("unexpected", { jobId, err });

function format(level, msg, meta) {
  const ts = new Date().toISOString();
  const parts = [ts, level.toUpperCase(), msg];
  if (meta && Object.keys(meta).length) {
    try {
      parts.push(JSON.stringify(meta));
    } catch {
      parts.push(String(meta));
    }
  }
  return parts.join(" ");
}

function info(msg, meta) {
  console.log(format("info", msg, meta));
}
function warn(msg, meta) {
  console.warn(format("warn", msg, meta));
}
function error(msg, meta) {
  console.error(format("error", msg, meta));
}

// Returns a logger with `bindings` merged into the `meta` of every call.
// Supports nesting: .child({a:1}).child({b:2}) emits both keys.
function child(bindings) {
  const base = bindings || {};
  return {
    info(msg, meta) {
      info(msg, { ...base, ...(meta || {}) });
    },
    warn(msg, meta) {
      warn(msg, { ...base, ...(meta || {}) });
    },
    error(msg, meta) {
      error(msg, { ...base, ...(meta || {}) });
    },
    child(more) {
      return child({ ...base, ...(more || {}) });
    },
  };
}

module.exports = { info, warn, error, child };
