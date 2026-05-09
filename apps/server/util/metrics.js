// Tiny Prometheus text-format metrics collector. Zero deps on purpose;
// swap for prom-client if we ever need histograms or summaries.
//
// Exposed shape:
//   metrics.counter(name, help?).inc(labels?, value?)
//   metrics.gauge(name, help?).set(labels?, value)
//   metrics.gauge(...).inc(labels?, value?), .dec(labels?, value?)
//   metrics.render() -> string (text/plain; version=0.0.4)

const counters = new Map();
const gauges = new Map();

function labelKey(labels) {
  if (!labels || Object.keys(labels).length === 0) return "";
  return Object.keys(labels)
    .sort()
    .map((k) => `${k}="${escapeLabelValue(String(labels[k]))}"`)
    .join(",");
}

function escapeLabelValue(v) {
  // Prometheus text format: escape backslash, newline, double-quote.
  return v.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/"/g, '\\"');
}

function makeCounter(name, help) {
  const state = {
    name,
    help: help || "",
    type: "counter",
    values: new Map(), // labelKey -> { labels, value }
  };
  counters.set(name, state);
  return {
    inc(labels, value = 1) {
      const key = labelKey(labels);
      const existing = state.values.get(key);
      if (existing) existing.value += value;
      else state.values.set(key, { labels: labels || {}, value });
    },
  };
}

function makeGauge(name, help) {
  const state = {
    name,
    help: help || "",
    type: "gauge",
    values: new Map(),
  };
  gauges.set(name, state);
  function adjust(labels, delta) {
    const key = labelKey(labels);
    const existing = state.values.get(key);
    if (existing) existing.value += delta;
    else state.values.set(key, { labels: labels || {}, value: delta });
  }
  return {
    set(labels, value) {
      const key = labelKey(labels);
      state.values.set(key, { labels: labels || {}, value });
    },
    inc(labels, value = 1) {
      adjust(labels, value);
    },
    dec(labels, value = 1) {
      adjust(labels, -value);
    },
  };
}

function counter(name, help) {
  return counters.get(name)
    ? // Reuse — inc() handle for an already-registered counter.
      {
        inc(labels, value = 1) {
          const state = counters.get(name);
          const key = labelKey(labels);
          const existing = state.values.get(key);
          if (existing) existing.value += value;
          else state.values.set(key, { labels: labels || {}, value });
        },
      }
    : makeCounter(name, help);
}

function gauge(name, help) {
  return gauges.get(name) ? gaugeHandle(name) : makeGauge(name, help);
}

function gaugeHandle(name) {
  return {
    set(labels, value) {
      const state = gauges.get(name);
      const key = labelKey(labels);
      state.values.set(key, { labels: labels || {}, value });
    },
    inc(labels, value = 1) {
      const state = gauges.get(name);
      const key = labelKey(labels);
      const existing = state.values.get(key);
      if (existing) existing.value += value;
      else state.values.set(key, { labels: labels || {}, value });
    },
    dec(labels, value = 1) {
      const state = gauges.get(name);
      const key = labelKey(labels);
      const existing = state.values.get(key);
      if (existing) existing.value -= value;
      else state.values.set(key, { labels: labels || {}, value: -value });
    },
  };
}

function renderOne(state) {
  const lines = [];
  if (state.help) lines.push(`# HELP ${state.name} ${state.help}`);
  lines.push(`# TYPE ${state.name} ${state.type}`);
  if (state.values.size === 0) {
    // Emit a zero sample so scrapers see the metric even pre-traffic.
    lines.push(`${state.name} 0`);
  } else {
    for (const { labels, value } of state.values.values()) {
      const lk = labelKey(labels);
      lines.push(lk ? `${state.name}{${lk}} ${value}` : `${state.name} ${value}`);
    }
  }
  return lines.join("\n");
}

function render() {
  const blocks = [];
  for (const state of counters.values()) blocks.push(renderOne(state));
  for (const state of gauges.values()) blocks.push(renderOne(state));
  // Always include process uptime — useful for health diffs.
  blocks.push(
    `# HELP process_uptime_seconds Process uptime in seconds\n# TYPE process_uptime_seconds gauge\nprocess_uptime_seconds ${process.uptime()}`
  );
  return blocks.join("\n\n") + "\n";
}

module.exports = { counter, gauge, render };
