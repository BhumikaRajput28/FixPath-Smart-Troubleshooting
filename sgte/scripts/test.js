/**
 * Regression suite.
 *
 * Every test here exists because something was actually wrong. The comments say
 * what, so a future change that reintroduces the bug fails with an explanation
 * rather than a bare assertion.
 *
 *   node scripts/test.js
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildGoal, validGoal, buildTitle, validTitle, buildDescription, validDescription,
  buildActionName, scrubUrls, containsUrl, validVariations, validateResponse, CATEGORY
} from "../shared/contract.js";
import { canonical, variations } from "../shared/variations.js";
import { classify, stepsFrom, extractGoal, topicFrom } from "../engine/extract.js";
import { DeeplinkIndex, resolveScreen, usableTarget, messageMatch } from "../engine/retrieval.js";
import { troubleshoot, mapDeeplinks, orderActions } from "../engine/pipeline.js";
import { FastPathCache } from "../server/cache.js";
import { percentiles } from "../server/metrics.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const index = DeeplinkIndex.fromFile(path.join(ROOT, "data", "deeplinks.json"));
const rows = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "siis_responses.json"), "utf8")).responses;
const queries = fs.readFileSync(path.join(ROOT, "data", "input.txt"), "utf8")
  .split(/\r?\n/).map(l => l.replace(/^\s*\d+[.)]\s*/, "").trim()).filter(Boolean);

let pass = 0;
const fails = [];
let group = "";

const describe = name => { group = name; };
const it = (name, fn) => {
  try { fn(); pass++; }
  catch (e) { fails.push(`${group} > ${name}\n      ${e.message}`); }
};
const eq = (a, b, msg) => {
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    throw new Error(`${msg || "not equal"}\n      expected ${JSON.stringify(b)}\n      actual   ${JSON.stringify(a)}`);
  }
};
const ok = (v, msg) => { if (!v) throw new Error(msg || "expected truthy"); };
const wc = s => String(s).trim().split(/\s+/).length;

/* ======================================================= §4.2.1 URL leaks */

describe("scrubUrls");

it("strips a markdown link without leaving residue", () => {
  const out = scrubUrls("See [our guide](https://example.com/help) for details.");
  ok(!containsUrl(out), `URL survived: ${out}`);
  // A previous ordering stripped the bare URL first and left "[more](" behind.
  ok(!/[\[\]()]/.test(out), `bracket residue left: ${out}`);
});

it("strips bare and www URLs and bare domains", () => {
  for (const s of ["go to https://a.co/x now", "visit www.example.org", "see samsung.com/support"]) {
    ok(!containsUrl(scrubUrls(s)), `URL survived in: ${s} -> ${scrubUrls(s)}`);
  }
});

/* ============================================================ §4.1 rules */

describe("contract rules");

it("goal matches the required sentence pattern", () => {
  const g = buildGoal("Blank Black Display");
  ok(validGoal(g), `invalid goal: ${g}`);
});

it("title is 2-3 words", () => {
  for (const src of ["Blank or black display on a smartphone or tablet", "Screen", ""]) {
    const t = buildTitle(src);
    ok(validTitle(t), `invalid title from ${JSON.stringify(src)}: ${t}`);
    ok(wc(t) >= 2 && wc(t) <= 3, `title word count ${wc(t)}: ${t}`);
  }
});

it("title drops model codes and auxiliaries", () => {
  // "Nexa Fold X1" and "Screen does not" were both shipped as titles once.
  const t = buildTitle("My Nexa Fold X1 screen does not respond to touch");
  ok(!/\bx1\b/i.test(t), `model code survived: ${t}`);
  ok(!/\b(does|not|is|the)\b/i.test(t), `auxiliary survived: ${t}`);
});

it("description is 5-7 words beginning 'It will'", () => {
  for (const src of ["Check for Physical Damage and Liquid Exposure", "Charge the Device", "Fix", ""]) {
    const d = buildDescription(src);
    ok(validDescription(d), `invalid description from ${JSON.stringify(src)}: ${d}`);
    ok(/^It will /.test(d), `missing prefix: ${d}`);
    ok(wc(d) >= 5 && wc(d) <= 7, `word count ${wc(d)}: ${d}`);
  }
});

it("short headings keep their function words instead of taking filler", () => {
  // Padding with unrelated filler produced "It will attempt power settings",
  // which describes nothing. A short heading should read as English.
  eq(buildDescription("Charge the Device"), "It will charge the device");
  eq(buildDescription("Attempt to Power On"), "It will attempt to power on");
});

it("reads as a sentence after 'It will'", () => {
  // Noun-phrase and gerund headings produced "It will factors affecting
  // touchscreen performance" and "It will restart device settings" — the first
  // has no verb, the second names a screen the action never touches.
  eq(buildDescription("Factors Affecting Touchscreen Performance"),
    "It will check factors affecting touchscreen performance");
  eq(buildDescription("Restarting Your Device"), "It will restart the device");
  eq(buildDescription("Safe Mode"), "It will check safe mode");
});

it("proper nouns keep their casing", () => {
  // "Techcorp" and "Wi-fi" both shipped once.
  const d = buildDescription("Verify Wi-Fi and SIM status");
  ok(/Wi-Fi/.test(d), `Wi-Fi mis-cased: ${d}`);
});

/* ==================================================== §2 [0] enrichment */

describe("query enrichment");

it("produces 8-10 distinct variations for every supplied query", () => {
  for (const q of queries) {
    const v = variations(q);
    ok(validVariations(v), `${v.length} variations for: ${q}`);
  }
});

it("collapses differently-worded reports of one fault to one cache key", () => {
  // §7.1: keying on the raw string fragments the cache across paraphrases.
  eq(canonical("My screen keeps going black"), canonical("my SCREEN keeps going black!"));
  const a = canonical("My phone screen goes completely black");
  const b = canonical("screen goes black on my phone");
  eq(a, b, "word order created a second cache key");
});

it("is deterministic", () => {
  // §6.1: identical input must give identical output, or the pre-warmed cache
  // cannot be trusted and the evaluation is not repeatable.
  eq(variations(queries[0]), variations(queries[0]));
});

/* ================================================= §4.1 categorisation */

describe("classify");

it("treats an on-screen sequence as auto even without the word Settings", () => {
  // The default used to be manual, and manual actions are denied a deeplink by
  // §4.1 — so every UI sequence that did not literally say "Settings" silently
  // lost the deeplink it should have carried.
  eq(classify([
    "Swipe up on the Home screen to access the Apps screen.",
    "Tap the All apps icon."
  ], "Open Data Transfer App"), CATEGORY.auto);
});

it("treats hardware handling as manual", () => {
  eq(classify([
    "Connect your phone to its charger and let it charge for an hour.",
    "Inspect the charging port for debris."
  ], "Charge the Device"), CATEGORY.manual);
});

it("treats a service visit as manual", () => {
  eq(classify(["Visit an authorized service centre for inspection."], "Service"), CATEGORY.manual);
});

it("treats a restart or reset as critical whatever else it contains", () => {
  eq(classify(["Navigate to Settings.", "Tap Reset.", "Perform a factory reset."], "Reset"), CATEGORY.critical);
  eq(classify(["Force a restart on your device."], "Force a Restart"), CATEGORY.critical);
});

it("recognises every wording of a factory reset", () => {
  // "factory reset" did not match "Factory data reset" — the wording the corpus
  // uses — so the most destructive action in the whole dataset was classed auto
  // and ordered FIRST, ahead of charging the device.
  for (const heading of ["Factory Data Reset", "Factory reset", "Reset your device", "Erase all data"]) {
    eq(classify(["Navigate to Settings.", "Tap the option."], heading), CATEGORY.critical,
      `not critical: ${heading}`);
  }
});

/* ============================================ §4.2.3 no invented steps */

describe("step extraction");

it("keeps imperatives and drops narration", () => {
  const steps = stepsFrom([
    "Navigate to Settings and tap Connections.",
    "This will show you the available networks.",
    "Tap Wi-Fi."
  ]);
  ok(steps.length === 2, `expected 2 steps, got ${steps.length}: ${JSON.stringify(steps)}`);
  ok(!steps.some(s => /^This will/.test(s)), "narration kept as a step");
});

it("finds the imperative behind politeness and a leading clause", () => {
  // "Now, please connect..." hid the verb from the imperative test, and whole
  // sections were dropped as a result.
  const steps = stepsFrom([
    "Now, please connect the device to Wi-Fi.",
    "After charging, disconnect the cable from the port."
  ]);
  ok(steps.length === 2, `expected 2 steps, got ${JSON.stringify(steps)}`);
});

it("drops a step whose instruction lived in a stripped URL", () => {
  // §4.2.1 removes the URL and leaves an imperative pointing nowhere.
  const steps = stepsFrom(["Find instructions on how to remove your account at the provided links."]);
  eq(steps, [], "kept a step the user cannot act on");
});

it("never emits a step containing a URL", () => {
  for (const row of rows) {
    const { goal } = extractGoal(row.siis_response, { query: row.original_query || "" });
    for (const a of goal?.actions || []) {
      for (const g of a.stepGroups) {
        for (const s of g.steps) ok(!containsUrl(s), `URL in step (${row.id}): ${s}`);
      }
    }
  }
});

it("extracts at least one action from every supplied reference row", () => {
  for (const row of rows) {
    const { goal } = extractGoal(row.siis_response, { query: row.original_query || "" });
    ok(goal && goal.actions.length > 0, `no actions extracted from ${row.id}`);
  }
});

/* ======================================== §4.2.2 deeplink authenticity */

describe("deeplink resolution");

it("matches a named screen in the catalog", () => {
  const hit = resolveScreen(index, ["Go to Settings, tap Connections, then tap Wi-Fi."], { context: "wifi" });
  ok(hit.entry, "Wi-Fi did not resolve");
  ok(/wifi|wi-fi/i.test(hit.entry.message), `wrong entry: ${hit.entry.message}`);
});

it("rejects fragment targets before searching", () => {
  // Targets like these came out of step text and can only find a wrong screen.
  for (const junk of ["X", "and drop new into", "minus next", "Add", "input", ""]) {
    ok(!usableTarget(junk), `accepted junk target: ${JSON.stringify(junk)}`);
  }
  for (const real of ["Wi-Fi", "Navigation bar", "Touch sensitivity"]) {
    ok(usableTarget(real), `rejected real target: ${real}`);
  }
});

it("will not pick a toggle direction the steps never stated", () => {
  // The catalog holds both Enable and Disable for a feature. An article that
  // teaches you to USE multi window states no direction, and guessing one would
  // silently flip a setting — row_7 and row_12 once resolved the same action to
  // opposite toggles.
  const hit = resolveScreen(index, [
    "Tap the All apps icon.",
    "Drag the app to the edge of the screen."
  ], { context: "multi window", topic: "Use Multi Window" });
  if (hit.entry) {
    eq(hit.entry.originalType, "onClickURL",
      `picked a toggle (${hit.entry.message}) with no direction in the steps`);
  }
});

it("accepts a toggle when the steps do state a direction", () => {
  const hit = resolveScreen(index, [
    "Tap the switch next to Touch sensitivity to disable it."
  ], { context: "touch sensitivity", topic: "Touch Sensitivity Setting" });
  ok(hit.entry, "directed toggle did not resolve");
  ok(/disable/i.test(hit.entry.message), `wrong direction: ${hit.entry.message}`);
});

it("distinguishes a screen from one that merely shares a word", () => {
  // IDF coverage alone scored "Storage" as a full match for "Storage Share".
  const share = index.docs.find(e => /storage share/i.test(e.message || ""));
  if (share) ok(messageMatch("Storage", share) < 1, "Storage matched Storage Share fully");
});

it("emits only URIs that exist verbatim in the catalog", () => {
  for (const row of rows) {
    const { goal } = extractGoal(row.siis_response, { query: row.original_query || "" });
    if (!goal) continue;
    mapDeeplinks(goal, index, { query: row.original_query || "" });
    for (const a of goal.actions) {
      for (const g of a.stepGroups) {
        if (g.actionableDeeplink) {
          ok(index.uris.has(g.actionableDeeplink.deeplink),
            `invented URI (${row.id}): ${g.actionableDeeplink.deeplink}`);
        }
        if (g.validationDeeplink) {
          ok(index.uris.has(g.validationDeeplink.deeplink),
            `invented validation URI (${row.id}): ${g.validationDeeplink.deeplink}`);
        }
      }
    }
  }
});

it("never attaches a deeplink to a manual action", () => {
  // §4.1: a physical intervention has no screen to open.
  for (const row of rows) {
    const { goal } = extractGoal(row.siis_response, { query: row.original_query || "" });
    if (!goal) continue;
    mapDeeplinks(goal, index, { query: row.original_query || "" });
    for (const a of goal.actions.filter(x => x.category === CATEGORY.manual)) {
      for (const g of a.stepGroups) {
        ok(!g.actionableDeeplink, `manual action carried a deeplink (${row.id}): ${a.actionName}`);
      }
    }
  }
});

/* ======================================================== §2 sequencing */

describe("ordering");

it("puts non-invasive actions first and critical last", () => {
  const goal = {
    actions: [
      { actionName: "C", category: CATEGORY.critical, stepGroups: [] },
      { actionName: "M", category: CATEGORY.manual, stepGroups: [] },
      { actionName: "A", category: CATEGORY.auto, stepGroups: [] }
    ]
  };
  orderActions(goal);
  eq(goal.actions.map(a => a.actionName), ["A", "M", "C"]);
});

it("keeps the reference order inside a category", () => {
  const goal = {
    actions: [
      { actionName: "A1", category: CATEGORY.auto, stepGroups: [] },
      { actionName: "A2", category: CATEGORY.auto, stepGroups: [] },
      { actionName: "A3", category: CATEGORY.auto, stepGroups: [] }
    ]
  };
  orderActions(goal);
  eq(goal.actions.map(a => a.actionName), ["A1", "A2", "A3"], "sort was not stable");
});

/* ============================================================== caching */

describe("fast-path cache");

it("serves a paraphrase that was never stored as a key", () => {
  const cache = new FastPathCache();
  const q = "My screen keeps going black";
  const vars = variations(q);
  cache.store(canonical(q), vars, { response: { contexts: [] }, query_variations: vars, query: q });

  const alt = vars[5] || vars[1];
  const hit = cache.lookup(canonical(alt), variations(alt));
  ok(hit, `paraphrase missed the cache: ${alt}`);
});

it("matches a short complaint against a long stored query", () => {
  // Jaccard punished a short complaint for being short: every content word
  // could match a detailed stored query and still score under 0.5, because the
  // union was dominated by detail the user simply did not repeat.
  const cache = new FastPathCache();
  const stored = "My Nexa Fold X1 screen went completely black, so I can't see or interact with it";
  cache.store(canonical(stored), variations(stored),
    { response: { contexts: [] }, query: stored });

  const short = "screen is totally black cannot see or interact";
  ok(cache.lookup(canonical(short), variations(short)), `short paraphrase missed: ${short}`);
});

it("does not latch a short query onto an unrelated long entry", () => {
  // The containment rule above must not fire on a couple of incidental words.
  const cache = new FastPathCache();
  const stored = "My Nexa Fold X1 screen went completely black, so I can't see or interact with it";
  cache.store(canonical(stored), variations(stored), { response: { contexts: [] }, query: stored });

  for (const q of ["bluetooth will not pair with my car stereo", "how do I bake sourdough bread"]) {
    ok(!cache.lookup(canonical(q), variations(q)), `false cache hit for: ${q}`);
  }
});

it("misses on an unrelated query", () => {
  const cache = new FastPathCache();
  cache.store(canonical("screen is black"), variations("screen is black"),
    { response: { contexts: [] }, query: "screen is black" });
  ok(!cache.lookup(canonical("bluetooth will not pair with my car")), "unrelated query hit the cache");
});

/* ============================================================= pipeline */

describe("pipeline");

it("returns a contract-valid payload for every supplied row", () => {
  for (let i = 0; i < rows.length; i++) {
    const cache = new FastPathCache();
    const out = troubleshoot({
      query: queries[i] || rows[i].original_query,
      siisResponse: rows[i].siis_response, index, cache
    });
    const check = validateResponse(out.body.response, { catalogUris: index.uris });
    ok(check.ok, `${rows[i].id} failed validation: ${JSON.stringify(check.errors)}`);
    ok(validVariations(out.body.query_variations), `${rows[i].id} bad variations`);
  }
});

it("is byte-identical for identical input", () => {
  // §6.1. Without this the cache can serve something the cold path would not
  // have produced, and two evaluation runs can disagree.
  const a = troubleshoot({ query: queries[0], siisResponse: rows[0].siis_response, index, cache: new FastPathCache() });
  const b = troubleshoot({ query: queries[0], siisResponse: rows[0].siis_response, index, cache: new FastPathCache() });
  eq(a.body.response, b.body.response, "same input produced different plans");
});

it("answers with an empty plan and a reason when there is no reference text", () => {
  // §4.2.3: inventing a plan here is exactly what the rule forbids.
  const out = troubleshoot({ query: "something is broken", siisResponse: null, index, cache: new FastPathCache() });
  eq(out.body.response.contexts, []);
  eq(out.body.fallback, "no_siis_context");
});

it("reports cache_hit and a latency for every call", () => {
  const cache = new FastPathCache();
  const first = troubleshoot({ query: queries[0], siisResponse: rows[0].siis_response, index, cache });
  const second = troubleshoot({ query: queries[0], siisResponse: rows[0].siis_response, index, cache });
  eq(first.body.meta.cache_hit, false);
  eq(second.body.meta.cache_hit, true);
  ok(typeof first.body.meta.latency_ms === "number", "latency_ms missing");
});

/* ============================================================== metrics */

describe("metrics");

it("computes percentiles by nearest rank", () => {
  const p = percentiles([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  eq(p.n, 10);
  eq(p.p50, 5);
  eq(p.max, 10);
});

it("handles an empty sample without dividing by zero", () => {
  eq(percentiles([]).n, 0);
});

/* =============================================================== report */

console.log(`\n  ${pass} passing`);
if (fails.length) {
  console.log(`  ${fails.length} failing\n`);
  for (const f of fails) console.log(`    ${f}\n`);
  process.exit(1);
}
console.log("");
