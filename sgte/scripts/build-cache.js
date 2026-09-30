/**
 * Pre-warm the fast path (§8 Phase 3).
 *
 * Runs the full pipeline over every supplied reference row and writes the
 * validated plans, with their paraphrases, to data/cache-seed.json. The server
 * loads this at boot, which is what lets a query arrive with no siis_response
 * and still be answered from cache in single-digit milliseconds.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { DeeplinkIndex } from "../engine/retrieval.js";
import { troubleshoot } from "../engine/pipeline.js";
import { FastPathCache } from "../server/cache.js";
import { canonical, variations } from "../shared/variations.js";
import { validateResponse } from "../shared/contract.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const index = DeeplinkIndex.fromFile(path.join(ROOT, "data", "deeplinks.json"));
const rows = JSON.parse(readFileSync(path.join(ROOT, "data", "siis_responses.json"), "utf8")).responses;

const cache = new FastPathCache();
const seed = [];
let valid = 0, empty = 0;

for (const row of rows) {
  const query = String(row.original_query || "").replace(/^\s*\d+\.\s*/, "").trim();
  const out = troubleshoot({ query, siisResponse: row.siis_response, index, cache });

  const contexts = out.body.response.contexts;
  if (!contexts.length) { empty++; continue; }

  const check = validateResponse(out.body.response, { catalogUris: index.uris });
  if (!check.ok) {
    console.error(`  ${row.id}: rejected —`, check.errors.slice(0, 2).join("; "));
    continue;
  }

  valid++;
  seed.push({
    id: row.id,
    key: canonical(query),
    query,
    query_variations: variations(query),
    response: out.body.response
  });
}

writeFileSync(path.join(ROOT, "data", "cache-seed.json"),
  JSON.stringify({ _readme: "Pre-warmed plans built by scripts/build-cache.js. Regenerate after changing the engine.", count: seed.length, records: seed }, null, 1));

console.log(`seeded ${valid} plans from ${rows.length} rows (${empty} produced no actionable steps)`);
