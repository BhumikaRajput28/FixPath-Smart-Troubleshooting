/**
 * Metrics (§6.2, Appendix C).
 *
 * The specification asks for latency percentiles split by path, cache hit rate
 * broken down by how the hit was found, and schema-compliance counts. An
 * average latency would hide exactly the thing that matters here: a fast path
 * that answers in 2 ms and a cold path that answers in 40 ms average to
 * something that describes neither.
 *
 * Kept in memory with a lazy flush to disk so a restart does not lose the
 * demo's numbers. No external store, because that would be a dependency.
 */

import fs from "node:fs";

const MAX_SAMPLES = 5000;

export class MetricsStore {
  constructor(file = null) {
    this.file = file;
    this.samples = [];
    this.counters = {
      requests: 0,
      cacheHits: 0,
      coldPath: 0,
      exact: 0,
      variation: 0,
      fuzzy: 0,
      empty: 0,
      noSiisContext: 0,
      noMatch: 0
    };
    this.startedAt = Date.now();
    this.#load();
    this._dirty = false;
    this._timer = null;
  }

  record({ latencyMs = 0, cacheHit = false, match = null, contexts = 0, fallback = null }) {
    this.counters.requests++;
    if (cacheHit) {
      this.counters.cacheHits++;
      if (match && this.counters[match] !== undefined) this.counters[match]++;
    } else {
      this.counters.coldPath++;
    }
    if (!contexts) this.counters.empty++;
    if (fallback === "no_siis_context") this.counters.noSiisContext++;
    if (fallback === "no_match") this.counters.noMatch++;

    this.samples.push({ t: Date.now(), ms: latencyMs, hit: !!cacheHit, contexts });
    if (this.samples.length > MAX_SAMPLES) this.samples.splice(0, this.samples.length - MAX_SAMPLES);

    this.#scheduleFlush();
  }

  summary() {
    const all = this.samples.map(s => s.ms);
    const warm = this.samples.filter(s => s.hit).map(s => s.ms);
    const cold = this.samples.filter(s => !s.hit).map(s => s.ms);

    const c = this.counters;
    return {
      uptimeSec: Math.round((Date.now() - this.startedAt) / 1000),
      counters: { ...c },
      cacheHitRate: c.requests ? round(c.cacheHits / c.requests) : 0,
      emptyRate: c.requests ? round(c.empty / c.requests) : 0,
      latency: {
        all: percentiles(all),
        fastPath: percentiles(warm),
        coldPath: percentiles(cold)
      },
      // §6.2 names sub-300 ms as the fast-path target, so the share of
      // responses inside the budget is reported rather than left to be
      // inferred from a percentile.
      withinBudget: all.length ? round(all.filter(ms => ms < 300).length / all.length) : 1
    };
  }

  reset() {
    this.samples = [];
    for (const k of Object.keys(this.counters)) this.counters[k] = 0;
    this.startedAt = Date.now();
    this.#flush();
  }

  /* ---------------------------------------------------------- persistence */

  #scheduleFlush() {
    if (!this.file || this._timer) return;
    this._timer = setTimeout(() => { this._timer = null; this.#flush(); }, 2000);
    this._timer.unref?.();
  }

  #flush() {
    if (!this.file) return;
    try {
      fs.writeFileSync(this.file, JSON.stringify({
        startedAt: this.startedAt, counters: this.counters,
        samples: this.samples.slice(-1000)
      }));
    } catch { /* metrics are diagnostic; losing them must never break a request */ }
  }

  #load() {
    if (!this.file) return;
    try {
      const saved = JSON.parse(fs.readFileSync(this.file, "utf8"));
      if (saved?.counters) Object.assign(this.counters, saved.counters);
      if (Array.isArray(saved?.samples)) this.samples = saved.samples;
      if (saved?.startedAt) this.startedAt = saved.startedAt;
    } catch { /* first run */ }
  }
}

/** P50/P95/P99 by nearest-rank, which is what a reviewer will reproduce. */
export function percentiles(values) {
  if (!values.length) return { n: 0, p50: 0, p95: 0, p99: 0, min: 0, max: 0, mean: 0 };
  const v = [...values].sort((a, b) => a - b);
  const at = p => v[Math.min(v.length - 1, Math.ceil((p / 100) * v.length) - 1)];
  return {
    n: v.length,
    p50: round(at(50)), p95: round(at(95)), p99: round(at(99)),
    min: round(v[0]), max: round(v[v.length - 1]),
    mean: round(v.reduce((a, b) => a + b, 0) / v.length)
  };
}

const round = n => Math.round(n * 100) / 100;
