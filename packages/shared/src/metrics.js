/**
 * Tiny dependency-free Prometheus-compatible metrics registry.
 *
 * Deliberately hand-rolled: it is ~100 lines, has no dependencies, and makes it
 * obvious what a counter/histogram actually is when explaining the system.
 */

const registry = new Map(); // name -> metric

function labelsToKey(labels) {
  const keys = Object.keys(labels).sort();
  if (!keys.length) return '';
  return keys.map((k) => `${k}="${String(labels[k]).replace(/"/g, '')}"`).join(',');
}

class Counter {
  constructor(name, help) {
    this.name = name;
    this.help = help;
    this.type = 'counter';
    this.values = new Map();
  }

  inc(labels = {}, amount = 1) {
    const key = labelsToKey(labels);
    this.values.set(key, (this.values.get(key) || 0) + amount);
  }

  get(labels = {}) {
    return this.values.get(labelsToKey(labels)) || 0;
  }

  reset() {
    this.values.clear();
  }

  render() {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} counter`];
    for (const [key, value] of this.values) {
      lines.push(key ? `${this.name}{${key}} ${value}` : `${this.name} ${value}`);
    }
    return lines.join('\n');
  }
}

class Histogram {
  constructor(name, help, buckets = [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000]) {
    this.name = name;
    this.help = help;
    this.type = 'histogram';
    this.buckets = buckets;
    this.series = new Map(); // labelKey -> { counts:number[], sum, count }
  }

  observe(labels = {}, value = 0) {
    const key = labelsToKey(labels);
    let s = this.series.get(key);
    if (!s) {
      s = { counts: new Array(this.buckets.length).fill(0), sum: 0, count: 0 };
      this.series.set(key, s);
    }
    s.sum += value;
    s.count += 1;
    for (let i = 0; i < this.buckets.length; i += 1) {
      if (value <= this.buckets[i]) s.counts[i] += 1;
    }
  }

  /** Approximate percentile from bucket counts — good enough for a demo SLO. */
  percentile(labels, p) {
    const s = this.series.get(labelsToKey(labels));
    if (!s || !s.count) return null;
    const target = s.count * p;
    let cumulative = 0;
    for (let i = 0; i < this.buckets.length; i += 1) {
      cumulative = s.counts[i];
      if (cumulative >= target) return this.buckets[i];
    }
    return this.buckets[this.buckets.length - 1];
  }

  reset() {
    this.series.clear();
  }

  render() {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} histogram`];
    for (const [key, s] of this.series) {
      const sep = key ? `${key},` : '';
      let cumulative = 0;
      for (let i = 0; i < this.buckets.length; i += 1) {
        cumulative = s.counts[i];
        lines.push(`${this.name}_bucket{${sep}le="${this.buckets[i]}"} ${cumulative}`);
      }
      lines.push(`${this.name}_bucket{${sep}le="+Inf"} ${s.count}`);
      lines.push(key ? `${this.name}_sum{${key}} ${s.sum}` : `${this.name}_sum ${s.sum}`);
      lines.push(key ? `${this.name}_count{${key}} ${s.count}` : `${this.name}_count ${s.count}`);
    }
    return lines.join('\n');
  }
}

function counter(name, help) {
  if (!registry.has(name)) registry.set(name, new Counter(name, help));
  return registry.get(name);
}

function histogram(name, help, buckets) {
  if (!registry.has(name)) registry.set(name, new Histogram(name, help, buckets));
  return registry.get(name);
}

export const metrics = {
  counter,
  histogram,
  httpRequests: counter('http_requests_total', 'HTTP requests handled'),
  httpDuration: histogram('http_request_duration_ms', 'HTTP request duration in ms'),
  cacheHits: counter('cache_hits_total', 'Cache hits'),
  cacheMisses: counter('cache_misses_total', 'Cache misses'),
  eventsPublished: counter('events_published_total', 'Domain events published to the bus'),
  eventsConsumed: counter('events_consumed_total', 'Domain events consumed from the bus'),
  eventsFailed: counter('events_failed_total', 'Event handler failures'),
  sagaTransitions: counter('saga_transitions_total', 'Saga state transitions'),
  sagaCompleted: counter('saga_completed_total', 'Sagas reaching a terminal state'),

  render() {
    return `${[...registry.values()].map((m) => m.render()).join('\n\n')}\n`;
  },

  resetAll() {
    for (const m of registry.values()) m.reset();
  }
};
