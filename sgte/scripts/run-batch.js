/**
 * Batch runner (§6 evaluation, §8 Phase 4).
 *
 * Runs every query in data/input.txt through the pipeline and writes one JSON
 * object per line to results.jsonl. That file is the input to validate.js and
 * metrics.js, so the whole evaluation chain works from one recorded run rather
 * than from three separate ones that could disagree.
 *
 *   node scripts/run-batch.js               cold, empty cache
 *   node scripts/run-batch.js --warm        seed the cache first
 *   node scripts/run-batch.js --paraphrase  also run one paraphrase per query
 *
 * --paraphrase is the interesting one: it fires a wording that was never
 * stored, only derived, and records whether the semantic cache caught it. That
 * is the number §6.2 calls "semantic hit rate", and it cannot be measured by
 * replaying the original queries, which would trivially hit.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { DeeplinkIndex } from "../engine/retrieval.js";
import { troubleshoot } from "../engine/pipeline.js";
import { FastPathCache } from "../server/cache.js";
import { variations } from "../shared/variations.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const argv = new Set(process.argv.slice(2));
const WARM = argv.has("--warm");
const PARAPHRASE = argv.has("--paraphrase");

const index = DeeplinkIndex.fromFile(path.join(ROOT, "data", "deeplinks.json"));
const rows = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "siis_responses.json"), "utf8")).responses;
const queries = fs.readFileSync(path.join(ROOT, "data", "input.txt"), "utf8")
  .split(/\r?\n/).map(l => l.replace(/^\s*\d+[.)]\s*/, "").trim()).filter(Boolean);

const cache = new FastPathCache();
if (WARM) {
  const seed = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "cache-seed.json"), "utf8"));
  cache.seed(seed.records);
}

/**
 * Pair a query with its reference text.
 *
 * The corpus is aligned: input.txt line N corresponds to responses[N]. The
 * lookup falls back to matching on original_query so a re-ordered or trimmed
 * input file still resolves rather than silently evaluating against the wrong
 * article — which would look like a retrieval failure and be a harness bug.
 */
function referenceFor(query, i) {
  const norm = s => String(s || "").toLowerCase().replace(/^\s*\d+[.)]\s*/, "").replace(/[^a-z0-9]+/g, " ").trim();
  const byText = rows.find(r => norm(r.original_query) === norm(query));
  if (byText) return byText;
  return rows[i] || null;
}

const out = [];
let ok = 0, empty = 0;

for (let i = 0; i < queries.length; i++) {
  const query = queries[i];
  const row = referenceFor(query, i);
  const res = troubleshoot({ query, siisResponse: row?.siis_response || null, index, cache });

  const contexts = res.body.response.contexts;
  if (contexts.length) ok++; else empty++;

  out.push({
    id: row?.id || `line_${i + 1}`,
    run: "primary",
    query,
    query_variations: res.body.query_variations,
    response: res.body.response,
    meta: res.body.meta,
    fallback: res.body.fallback || null,
    diagnostics: summarise(res.diagnostics)
  });

  if (PARAPHRASE) {
    // Index 6 is the keyword-only register — the least like the original
    // wording, so the hardest test of the canonical key.
    const vars = variations(query);
    const alt = vars[5] || vars[1];
    if (alt) {
      const p = troubleshoot({ query: alt, siisResponse: row?.siis_response || null, index, cache });
      out.push({
        id: row?.id || `line_${i + 1}`,
        run: "paraphrase",
        query: alt,
        of: query,
        query_variations: p.body.query_variations,
        response: p.body.response,
        meta: p.body.meta,
        fallback: p.body.fallback || null,
        diagnostics: summarise(p.diagnostics)
      });
    }
  }
}

/** Keep the decisions, drop the bulk — results.jsonl should stay readable. */
function summarise(d) {
  if (!d) return null;
  return {
    path: d.path,
    key: d.key,
    match: d.match || null,
    reason: d.reason || null,
    mapping: d.mapping ? {
      matched: d.mapping.matched, placeholder: d.mapping.placeholder, none: d.mapping.none,
      decisions: d.mapping.decisions
    } : null,
    repairs: d.repairs?.length || 0,
    dropped: d.dropped?.length || 0
  };
}

const file = path.join(ROOT, "results.jsonl");
fs.writeFileSync(file, out.map(r => JSON.stringify(r)).join("\n") + "\n");

const paraphrases = out.filter(r => r.run === "paraphrase");
const caught = paraphrases.filter(r => r.meta.cache_hit).length;

console.log(`
run-batch  (${WARM ? "warm" : "cold"} cache${PARAPHRASE ? ", with paraphrases" : ""})
  queries          ${queries.length}
  records written  ${out.length}  ->  results.jsonl
  with contexts    ${ok}
  empty            ${empty}${PARAPHRASE ? `
  paraphrases      ${paraphrases.length}, ${caught} served from cache (${pct(caught, paraphrases.length)})` : ""}
`);

function pct(a, b) { return b ? `${Math.round((a / b) * 100)}%` : "n/a"; }
