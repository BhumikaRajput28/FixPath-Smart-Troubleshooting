/**
 * Latency benchmark (§6.2, §2 [3]).
 *
 * The specification sets a sub-300 ms target for the fast path. An average
 * across both paths would satisfy that number while hiding a slow cold path, so
 * every path is measured separately and reported as percentiles:
 *
 *   cold        full extraction, empty cache
 *   warm-exact  the same query again, canonical key hit
 *   warm-para   a paraphrase never stored, only derived — the semantic hit
 *   index       catalog load and index build, i.e. cold-start cost
 *
 *   node scripts/bench.js [iterations]
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { DeeplinkIndex } from "../engine/retrieval.js";
import { troubleshoot } from "../engine/pipeline.js";
import { FastPathCache } from "../server/cache.js";
import { percentiles } from "../server/metrics.js";
import { variations } from "../shared/variations.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const ITER = Number(process.argv[2] || 5);

const f = n => `${n.toFixed(2)} ms`.padStart(8);
const share = (a, limit) => (a.length ? round(a.filter(x => x < limit).length / a.length) : 1);
const fmtPct = n => `${Math.round(n * 100)}%`;
const round = n => Math.round(n * 1000) / 1000;


/* cold-start: how long before the service can answer at all */
const t0 = process.hrtime.bigint();
const index = DeeplinkIndex.fromFile(path.join(ROOT, "data", "deeplinks.json"));
const indexMs = ms(process.hrtime.bigint() - t0);

const rows = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "siis_responses.json"), "utf8")).responses;
const queries = fs.readFileSync(path.join(ROOT, "data", "input.txt"), "utf8")
  .split(/\r?\n/).map(l => l.replace(/^\s*\d+[.)]\s*/, "").trim()).filter(Boolean);

const cold = [], warmExact = [], warmPara = [];
let paraHits = 0, paraTotal = 0;

for (let it = 0; it < ITER; it++) {
  // A fresh cache each iteration, so "cold" stays genuinely cold rather than
  // measuring the first pass only and calling the rest cold too.
  const cache = new FastPathCache();

  for (let i = 0; i < queries.length; i++) {
    const q = queries[i];
    const siis = rows[i]?.siis_response || null;

    cold.push(time(() => troubleshoot({ query: q, siisResponse: siis, index, cache })));
    warmExact.push(time(() => troubleshoot({ query: q, siisResponse: siis, index, cache })));

    const alt = variations(q)[5];
    if (alt) {
      paraTotal++;
      let hit = false;
      warmPara.push(time(() => {
        const r = troubleshoot({ query: alt, siisResponse: siis, index, cache });
        hit = r.body.meta.cache_hit;
      }));
      if (hit) paraHits++;
    }
  }
}

function time(fn) {
  const s = process.hrtime.bigint();
  fn();
  return ms(process.hrtime.bigint() - s);
}
function ms(ns) { return Number(ns) / 1e6; }

const report = {
  iterations: ITER,
  queries: queries.length,
  coldStartMs: round(indexMs),
  catalogEntries: index.docs.length,
  paths: {
    cold: percentiles(cold),
    warmExact: percentiles(warmExact),
    warmParaphrase: percentiles(warmPara)
  },
  semanticHitRate: paraTotal ? round(paraHits / paraTotal) : 0,
  budget300ms: {
    cold: share(cold, 300),
    warmExact: share(warmExact, 300),
    warmParaphrase: share(warmPara, 300)
  }
};

fs.writeFileSync(path.join(ROOT, "data", "bench.json"), JSON.stringify(report, null, 2));

console.log(`
bench   ${ITER} iteration(s) x ${queries.length} queries
  cold start (index build)   ${report.coldStartMs} ms for ${index.docs.length} catalog entries

  path             n     p50      p95      p99      max
  cold          ${pad(report.paths.cold)}
  warm exact    ${pad(report.paths.warmExact)}
  warm paraph.  ${pad(report.paths.warmParaphrase)}

  within 300 ms  cold ${fmtPct(report.budget300ms.cold)}   exact ${fmtPct(report.budget300ms.warmExact)}   paraphrase ${fmtPct(report.budget300ms.warmParaphrase)}
  semantic hit rate (unseen paraphrase served from cache)  ${fmtPct(report.semanticHitRate)}

  written to data/bench.json
`);

function pad(p) {
  return [String(p.n).padStart(4), f(p.p50), f(p.p95), f(p.p99), f(p.max)].join("  ");
}
