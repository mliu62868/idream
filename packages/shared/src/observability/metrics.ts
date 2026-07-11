type LabelValue = string | number | boolean;
export type MetricLabels = Readonly<Record<string, LabelValue>>;

type CounterSeries = { labels: MetricLabels; value: number };
type HistogramSeries = {
  labels: MetricLabels;
  count: number;
  sum: number;
  buckets: number[];
};

type CounterMetric = {
  type: "counter" | "gauge";
  help: string;
  series: Map<string, CounterSeries>;
};

type HistogramMetric = {
  type: "histogram";
  help: string;
  boundaries: readonly number[];
  series: Map<string, HistogramSeries>;
};

type Metric = CounterMetric | HistogramMetric;

const defaultBoundaries = [0.01, 0.05, 0.1, 0.25, 0.5, 0.75, 1, 2.5, 5, 10] as const;
const metrics = new Map<string, Metric>();

function assertMetricName(name: string) {
  if (!/^[a-zA-Z_:][a-zA-Z0-9_:]*$/.test(name)) {
    throw new Error(`Invalid metric name: ${name}`);
  }
}

function seriesKey(labels: MetricLabels) {
  return Object.entries(labels)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${String(value)}`)
    .join("\u0000");
}

function counterMetric(name: string, help: string, type: "counter" | "gauge") {
  assertMetricName(name);
  const current = metrics.get(name);
  if (current) {
    if (current.type !== type) throw new Error(`Metric ${name} already registered as ${current.type}`);
    return current;
  }
  const created: CounterMetric = { type, help, series: new Map() };
  metrics.set(name, created);
  return created;
}

export function incrementCounter(
  name: string,
  help: string,
  labels: MetricLabels = {},
  amount = 1,
) {
  if (!Number.isFinite(amount) || amount < 0) throw new Error("Counter increment must be finite and non-negative");
  const metric = counterMetric(name, help, "counter");
  const key = seriesKey(labels);
  const current = metric.series.get(key);
  metric.series.set(key, { labels, value: (current?.value ?? 0) + amount });
}

export function setGauge(name: string, help: string, labels: MetricLabels, value: number) {
  if (!Number.isFinite(value)) throw new Error("Gauge value must be finite");
  const metric = counterMetric(name, help, "gauge");
  metric.series.set(seriesKey(labels), { labels, value });
}

export function observeHistogram(
  name: string,
  help: string,
  labels: MetricLabels,
  value: number,
  boundaries: readonly number[] = defaultBoundaries,
) {
  if (!Number.isFinite(value) || value < 0) throw new Error("Histogram observation must be finite and non-negative");
  assertMetricName(name);
  const current = metrics.get(name);
  let metric: HistogramMetric;
  if (current) {
    if (current.type !== "histogram") throw new Error(`Metric ${name} already registered as ${current.type}`);
    metric = current;
  } else {
    metric = { type: "histogram", help, boundaries, series: new Map() };
    metrics.set(name, metric);
  }
  const key = seriesKey(labels);
  const series = metric.series.get(key) ?? {
    labels,
    count: 0,
    sum: 0,
    buckets: metric.boundaries.map(() => 0),
  };
  series.count += 1;
  series.sum += value;
  metric.boundaries.forEach((boundary, index) => {
    if (value <= boundary) series.buckets[index] += 1;
  });
  metric.series.set(key, series);
}

function escapeLabel(value: LabelValue) {
  return String(value).replaceAll("\\", "\\\\").replaceAll("\n", "\\n").replaceAll('"', '\\"');
}

function formattedLabels(labels: MetricLabels, extra?: readonly [string, LabelValue]) {
  const entries = [...Object.entries(labels), ...(extra ? [extra] : [])]
    .sort(([left], [right]) => left.localeCompare(right));
  if (entries.length === 0) return "";
  return `{${entries.map(([key, value]) => `${key}="${escapeLabel(value)}"`).join(",")}}`;
}

export function renderPrometheusMetrics() {
  const lines: string[] = [];
  for (const [name, metric] of [...metrics.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    lines.push(`# HELP ${name} ${metric.help}`, `# TYPE ${name} ${metric.type}`);
    if (metric.type === "counter" || metric.type === "gauge") {
      for (const series of metric.series.values()) {
        lines.push(`${name}${formattedLabels(series.labels)} ${series.value}`);
      }
      continue;
    }
    const histogram = metric as HistogramMetric;
    for (const series of histogram.series.values()) {
      histogram.boundaries.forEach((boundary, index) => {
        lines.push(`${name}_bucket${formattedLabels(series.labels, ["le", boundary])} ${series.buckets[index]}`);
      });
      lines.push(
        `${name}_bucket${formattedLabels(series.labels, ["le", "+Inf"])} ${series.count}`,
        `${name}_sum${formattedLabels(series.labels)} ${series.sum}`,
        `${name}_count${formattedLabels(series.labels)} ${series.count}`,
      );
    }
  }
  return `${lines.join("\n")}${lines.length > 0 ? "\n" : ""}`;
}

export function resetMetricsForTests() {
  metrics.clear();
}
