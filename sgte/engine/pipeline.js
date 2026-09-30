/**
 * The pipeline (§2).
 *
 *   [0] Query Enrichment      canonical key + 8–10 paraphrases
 *   [1] Structure Extraction  reference text -> Goal / Actions / steps
 *   [2] Deeplink Mapping      step groups -> exact catalog URIs, ordered
 *   [3] Fast-Path Cache       hit returns a validated plan with no extraction
 *   [4] Validation            schema + rules, enforced before anything ships
 *
 * Everything here is deterministic (§6.1). The same complaint and the same
 * reference text produce byte-identical output, which is what lets the cache
 * be trusted and the evaluation be repeatable.
 */

import { canonical, variations } from "../shared/variations.js";
import { extractGoal, topicFrom } from "./extract.js";
import { resolveScreen, opensSettingsScreen } from "./retrieval.js";
import {
  validateResponse, repairDescription, validDescription,
  CATEGORY, CATEGORY_ORDER, scrubUrls
} from "../shared/contract.js";

/* ========================================================= deeplink mapping */

/**
 * Attach an actionable deeplink to each step group, and the catalog's own
 * validation deeplink alongside it.
 *
 * §4.2.2: the URI is copied verbatim from the catalog. Nothing in this
 * function constructs, edits or infers a URI — it only decides which catalog
 * entry a group of steps refers to, and copies its fields across.
 */
export function mapDeeplinks(goal, index, { query = "", mode = "hybrid" } = {}) {
  const report = { matched: 0, placeholder: 0, none: 0, decisions: [] };

  for (const action of goal.actions) {
    for (const group of action.stepGroups) {
      // A manual action is a physical intervention — a service visit, a cable
      // swap. There is no screen to open, so §4.1 forbids a deeplink here.
      if (action.category === CATEGORY.manual) {
        group.actionableDeeplink = null;
        group.validationDeeplink = null;
        report.none++;
        report.decisions.push({ action: action.actionName, decision: "manual-no-deeplink" });
        continue;
      }

      // The action's own name is offered as a fallback retrieval target: when
      // the step trail ends on a button rather than a screen, the heading is
      // what identifies the destination.
      const hit = resolveScreen(index, group.steps, { context: query, topic: action.actionName, mode });

      if (hit.entry) {
        group.actionableDeeplink = {
          deeplink: hit.entry.deeplink,                      // verbatim
          description: scrubUrls(hit.entry.description || ""),
          message: scrubUrls(hit.entry.message || ""),
          originalType: hit.entry.originalType || null
        };

        group.validationDeeplink = hit.entry.validation
          ? {
              deeplink: hit.entry.validation.deeplink,        // verbatim
              key: hit.entry.validation.key,
              resultType: hit.entry.validation.resultType ?? null,
              condition: hit.entry.validation.condition ?? null,
              value: hit.entry.validation.value ?? null
            }
          : null;

        report.matched++;
        report.decisions.push({
          action: action.actionName, decision: "matched", target: hit.target,
          uri: hit.entry.deeplink, coverage: round(hit.coverage), message: hit.entry.message
        });
        continue;
      }

      // Nothing in the catalog fits. If the steps still land on a Settings
      // screen the catalog's own placeholder is the honest answer; otherwise
      // the group ships without a deeplink rather than with a wrong one.
      if (hit.settingsScreen && index.placeholderEntry()) {
        const ph = index.placeholderEntry();
        group.actionableDeeplink = {
          deeplink: ph.deeplink,
          description: `Open ${hit.target || "the relevant"} settings on the device`,
          message: `Open ${hit.target || "Settings"}`.slice(0, 60),
          originalType: ph.originalType || "placeholder"
        };
        group.validationDeeplink = null;
        report.placeholder++;
        report.decisions.push({ action: action.actionName, decision: "placeholder", target: hit.target });
        continue;
      }

      group.actionableDeeplink = null;
      group.validationDeeplink = null;
      report.none++;
      report.decisions.push({
        action: action.actionName, decision: "no-match",
        reason: hit.reason, target: hit.target || null
      });
    }
  }

  return report;
}

/* ================================================================ ordering */

/** §2: non-invasive settings first, critical/destructive last. Stable. */
export function orderActions(goal) {
  goal.actions = goal.actions
    .map((a, i) => ({ a, i }))
    .sort((x, y) => (CATEGORY_ORDER[x.a.category] - CATEGORY_ORDER[y.a.category]) || (x.i - y.i))
    .map(x => x.a);
  return goal;
}

/* ================================================================= scoring */

/**
 * Confidence in the plan, in [0,1].
 *
 * Built from things that are actually measurable — how much of the reference
 * text became usable steps, how many screens resolved to a real catalog entry,
 * and how well the complaint overlaps the reference title. A score that is
 * just a constant tells a reviewer nothing.
 */
export function scoreGoal(goal, { mapping, query, referenceTitle }) {
  const groups = goal.actions.reduce((n, a) => n + a.stepGroups.length, 0) || 1;
  const autoGroups = goal.actions
    .filter(a => a.category !== CATEGORY.manual)
    .reduce((n, a) => n + a.stepGroups.length, 0);

  const linkRate = autoGroups ? mapping.matched / autoGroups : 1;
  const stepDensity = Math.min(1, goal.actions.reduce((n, a) =>
    n + a.stepGroups.reduce((m, g) => m + g.steps.length, 0), 0) / 8);
  const overlap = tokenOverlap(query, referenceTitle);

  const raw = 0.45 * linkRate + 0.30 * stepDensity + 0.25 * overlap;
  return Math.max(0.05, Math.min(0.99, Math.round(raw * 100) / 100));
}

function tokenOverlap(a, b) {
  const t = s => new Set(String(s || "").toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter(w => w.length > 3));
  const A = t(a), B = t(b);
  if (!A.size || !B.size) return 0.4;
  let hit = 0;
  for (const x of B) if (A.has(x)) hit++;
  return hit / B.size;
}

const round = n => (typeof n === "number" ? Math.round(n * 100) / 100 : n);

/* ================================================================== repair */

/**
 * §7.5: word-count rules are enforced in code, not asked for in a prompt.
 * Anything repairable is repaired; anything that is not is dropped, because a
 * response that breaks the contract is worse than a smaller valid one.
 */
export function repairGoal(goal) {
  const notes = [];

  for (const action of goal.actions) {
    if (!validDescription(action.description)) {
      const before = action.description;
      action.description = repairDescription(action.description);
      notes.push({ action: action.actionName, fixed: "description", before, after: action.description });
    }
    action.stepGroups = action.stepGroups.filter(g => Array.isArray(g.steps) && g.steps.length);
  }

  goal.actions = goal.actions.filter(a => a.stepGroups.length && validDescription(a.description));
  return notes;
}

/* =============================================================== pipeline */

/**
 * Run the whole thing.
 *
 * @param {object} args
 *   query          the customer complaint
 *   siisResponse   optional reference text {title, content}
 *   index          DeeplinkIndex
 *   cache          FastPathCache
 *   now            injectable clock, for deterministic tests
 * @returns {{ body, meta, diagnostics }}
 */
export function troubleshoot({ query, siisResponse = null, index, cache, model = "rules", mode = "hybrid", now = () => process.hrtime.bigint() }) {
  const started = now();
  const q = scrubUrls(String(query || "")).trim();

  const key = canonical(q);
  const vars = variations(q);

  /* [3] fast path — before any extraction work */
  const hit = cache?.lookup(key, vars);
  if (hit) {
    return {
      body: {
        query: q,
        query_variations: hit.query_variations || vars,
        response: hit.response,
        meta: {
          latency_ms: msSince(started, now),
          cache_hit: true,
          cache_match: hit.match,
          model: "cache",
          cost_usd: 0
        }
      },
      meta: { cacheHit: true },
      diagnostics: { path: "fast", key, match: hit.match }
    };
  }

  /* [1] structure extraction */
  if (!siisResponse || !siisResponse.content) {
    // §4.2.3: no reference text and nothing cached means there is no grounded
    // answer, and inventing one is exactly what the rule forbids.
    return {
      body: {
        query: q,
        query_variations: vars,
        response: { contexts: [] },
        fallback: "no_siis_context",
        meta: { latency_ms: msSince(started, now), cache_hit: false, model, cost_usd: 0 }
      },
      meta: { cacheHit: false, empty: true },
      diagnostics: { path: "cold", key, reason: "no_siis_context" }
    };
  }

  const { goal, dropped, stats } = extractGoal(siisResponse, { query: q });

  if (!goal) {
    return {
      body: {
        query: q,
        query_variations: vars,
        response: { contexts: [] },
        fallback: "no_match",
        meta: { latency_ms: msSince(started, now), cache_hit: false, model, cost_usd: 0 }
      },
      meta: { cacheHit: false, empty: true },
      diagnostics: { path: "cold", key, reason: stats.reason, dropped }
    };
  }

  /* [2] deeplink mapping and ordering */
  const mapping = mapDeeplinks(goal, index, { query: q, mode });
  orderActions(goal);

  const repairs = repairGoal(goal);
  goal.score = scoreGoal(goal, { mapping, query: q, referenceTitle: siisResponse.title });

  const response = { contexts: goal.actions.length ? [stripInternals(goal)] : [] };

  /* [4] validation — nothing ships that fails the contract */
  const check = validateResponse(response, { catalogUris: index.uris });
  if (!check.ok) {
    return {
      body: {
        query: q,
        query_variations: vars,
        response: { contexts: [] },
        fallback: "no_match",
        meta: { latency_ms: msSince(started, now), cache_hit: false, model, cost_usd: 0 }
      },
      meta: { cacheHit: false, invalid: true },
      diagnostics: { path: "cold", key, validation: check.errors, repairs, mapping }
    };
  }

  cache?.store(key, vars, { response, query_variations: vars, query: q });

  return {
    body: {
      query: q,
      query_variations: vars,
      response,
      meta: { latency_ms: msSince(started, now), cache_hit: false, model, cost_usd: 0 }
    },
    meta: { cacheHit: false },
    diagnostics: { path: "cold", key, mapping, repairs, dropped, stats }
  };
}

/** Drop the extractor's bookkeeping before the payload leaves the building. */
function stripInternals(goal) {
  return {
    goal: goal.goal,
    title: goal.title,
    score: goal.score,
    actions: goal.actions.map(a => ({
      actionName: a.actionName,
      description: a.description,
      stepGroups: a.stepGroups.map(g => ({
        steps: g.steps,
        validationDeeplink: g.validationDeeplink ?? null,
        actionableDeeplink: g.actionableDeeplink ?? null
      })),
      category: a.category
    }))
  };
}

function msSince(started, now) {
  return Math.round(Number(now() - started) / 1e4) / 100;
}

export { topicFrom, opensSettingsScreen };
