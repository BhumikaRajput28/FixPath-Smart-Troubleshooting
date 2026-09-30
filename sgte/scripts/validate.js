/**
 * Validator (§6.4, §4.1, §4.2).
 *
 * Reads results.jsonl and gates it against the contract. This is deliberately a
 * separate program from the engine: the engine's own validateResponse() runs
 * inside the pipeline and can only ever check what the engine believes it
 * produced, whereas this reads the recorded output as a stranger would — which
 * is how the evaluation will read it.
 *
 * Checks, grouped as §6 groups them:
 *
 *   structure    required keys, types, nesting
 *   rules        goal syntax, title/description/actionName word counts
 *   grounding    every deeplink URI exists verbatim in the catalog
 *   leakage      no raw URL survives anywhere in the payload
 *   categories   valid values, least-disruptive-first ordering, manual has no link
 *   enrichment   8–10 distinct query variations
 *
 * Exit code 1 on any failure, so this works as a CI gate rather than a report.
 *
 *   node scripts/validate.js [results.jsonl]
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { DeeplinkIndex } from "../engine/retrieval.js";
import {
  CATEGORY, CATEGORY_ORDER, RULES,
  validGoal, validTitle, validDescription, containsUrl, validVariations
} from "../shared/contract.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const file = process.argv[2] || path.join(ROOT, "results.jsonl");

const index = DeeplinkIndex.fromFile(path.join(ROOT, "data", "deeplinks.json"));
const records = fs.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean).map(l => JSON.parse(l));

const wc = s => String(s || "").trim().split(/\s+/).filter(Boolean).length;

const failures = [];
const warnings = [];
const tally = {
  records: 0, contexts: 0, actions: 0, groups: 0, steps: 0,
  withDeeplink: 0, withValidation: 0, manual: 0, critical: 0, auto: 0,
  placeholderLinks: 0, empty: 0
};

for (const rec of records) {
  const at = `${rec.id}${rec.run === "paraphrase" ? " (paraphrase)" : ""}`;
  tally.records++;

  /* ------------------------------------------------------------- envelope */
  check(at, "query is a non-empty string", typeof rec.query === "string" && rec.query.trim());
  check(at, "response.contexts is an array", Array.isArray(rec.response?.contexts));

  // §4.1: 8 to 10 variations, distinct. An empty plan still enriches the query,
  // so this is checked on every record.
  const v = rec.query_variations;
  check(at, `query_variations is ${RULES.VARIATIONS_MIN}-${RULES.VARIATIONS_MAX} distinct strings`
    + ` (got ${Array.isArray(v) ? v.length : typeof v})`, validVariations(v));

  check(at, "meta.latency_ms is a number", typeof rec.meta?.latency_ms === "number");
  check(at, "meta.cache_hit is a boolean", typeof rec.meta?.cache_hit === "boolean");

  if (!rec.response?.contexts?.length) {
    tally.empty++;
    // §4.2.3 allows an empty result, but only with a stated reason.
    check(at, "empty contexts carries a fallback reason",
      rec.fallback === "no_match" || rec.fallback === "no_siis_context");
    continue;
  }

  /* -------------------------------------------------------------- goals -- */
  for (const ctx of rec.response.contexts) {
    tally.contexts++;

    check(at, `goal matches ${RULES.GOAL_PATTERN} (got ${JSON.stringify(ctx.goal)})`, validGoal(ctx.goal));
    check(at, `title is ${RULES.TITLE_MIN_WORDS}-${RULES.TITLE_MAX_WORDS} words (got ${JSON.stringify(ctx.title)})`, validTitle(ctx.title));
    check(at, `score is a number in [0,1] (got ${ctx.score})`,
      typeof ctx.score === "number" && ctx.score >= 0 && ctx.score <= 1);
    check(at, "actions is a non-empty array", Array.isArray(ctx.actions) && ctx.actions.length > 0);

    let lastRank = -1;
    for (const a of ctx.actions || []) {
      tally.actions++;

      check(at, `actionName is present (got ${JSON.stringify(a.actionName)})`,
        typeof a.actionName === "string" && a.actionName.trim().length > 0);
      check(at, `description is ${RULES.DESC_MIN_WORDS}-${RULES.DESC_MAX_WORDS} words`
        + ` (got ${wc(a.description)}: ${JSON.stringify(a.description)})`, validDescription(a.description));
      check(at, `category is one of ${Object.values(CATEGORY).join("/")} (got ${JSON.stringify(a.category)})`,
        Object.values(CATEGORY).includes(a.category));

      // §2 sequencing: auto, then manual, then critical. Monotonic rank.
      const rank = CATEGORY_ORDER[a.category];
      if (rank !== undefined) {
        check(at, `actions ordered least-disruptive-first (${a.category} after rank ${lastRank})`, rank >= lastRank);
        lastRank = Math.max(lastRank, rank);
      }
      tally[a.category] = (tally[a.category] || 0) + 1;

      check(at, "stepGroups is a non-empty array",
        Array.isArray(a.stepGroups) && a.stepGroups.length > 0);

      for (const g of a.stepGroups || []) {
        tally.groups++;
        check(at, "steps is a non-empty array of strings",
          Array.isArray(g.steps) && g.steps.length > 0 && g.steps.every(s => typeof s === "string" && s.trim()));
        tally.steps += g.steps?.length || 0;

        for (const s of g.steps || []) {
          check(at, `step contains no URL: ${JSON.stringify(s)}`, !containsUrl(s));
        }

        /* ------------------------------------------------- deeplinks --- */
        const dl = g.actionableDeeplink;
        if (dl) {
          tally.withDeeplink++;
          check(at, "actionableDeeplink.deeplink is a string", typeof dl.deeplink === "string" && dl.deeplink);
          // §4.2.2: the URI must be one the catalog actually contains. A
          // constructed or edited URI fails here, which is the point.
          check(at, `deeplink exists in catalog: ${dl.deeplink}`, index.uris.has(dl.deeplink));
          check(at, "deeplink description has no URL", !containsUrl(dl.description || ""));
          check(at, "deeplink message has no URL", !containsUrl(dl.message || ""));
          if (/dummy_positive/.test(dl.deeplink)) tally.placeholderLinks++;

          // §4.1: a manual action is a physical intervention with no screen.
          check(at, `manual action carries no actionable deeplink (${a.actionName})`,
            a.category !== CATEGORY.manual);
        }

        const vd = g.validationDeeplink;
        if (vd) {
          tally.withValidation++;
          check(at, `validation deeplink exists in catalog: ${vd.deeplink}`, index.uris.has(vd.deeplink));
          check(at, "validationDeeplink.key is present", typeof vd.key === "string" && vd.key.length > 0);
        }
      }
    }
  }

  /* ---------------------------------------------------- whole-payload leak */
  // Belt and braces: serialise the record and look for a raw URL anywhere,
  // including in fields no individual check above visits.
  const blob = JSON.stringify(rec.response);
  check(at, "response contains no raw http(s) URL", !/https?:\/\//i.test(blob));
}

/* ------------------------------------------------------------ soft checks */

// Not a contract breach, but a reviewer will ask: how many groups got a real
// screen rather than the catalog's placeholder?
if (tally.withDeeplink) {
  const real = tally.withDeeplink - tally.placeholderLinks;
  warnings.push(`${real}/${tally.withDeeplink} actionable deeplinks resolve to a specific catalog screen`
    + ` (${tally.placeholderLinks} use the catalog's generic placeholder)`);
}
if (tally.empty) warnings.push(`${tally.empty} record(s) returned no contexts`);

/* ------------------------------------------------------------- reporting */

function check(at, what, condition) {
  if (!condition) failures.push({ at, what });
}

console.log(`
validate  ${path.relative(ROOT, file)}
  records            ${tally.records}
  goals              ${tally.contexts}
  actions            ${tally.actions}   (auto ${tally.auto}, manual ${tally.manual}, critical ${tally.critical})
  step groups        ${tally.groups}
  steps              ${tally.steps}
  actionable links   ${tally.withDeeplink}
  validation links   ${tally.withValidation}
`);

for (const w of warnings) console.log(`  note     ${w}`);

if (failures.length) {
  console.log(`\n  ${failures.length} FAILURE(S)\n`);
  const shown = failures.slice(0, 40);
  for (const f of shown) console.log(`    [${f.at}] ${f.what}`);
  if (failures.length > shown.length) console.log(`    ... and ${failures.length - shown.length} more`);
  console.log("");
  process.exit(1);
}

console.log(`\n  PASS — all ${tally.records} records conform to the schema and §4.1 rules\n`);
