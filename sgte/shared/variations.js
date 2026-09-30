/**
 * Phase 0 — Query Enrichment (§2 [0], §4.1 query_variations).
 *
 * Two jobs:
 *
 *   canonical()  — normalise colloquial phrasing into one technical query.
 *                  This is the semantic cache key, and it is why "my screen
 *                  keeps going black" and "display turns off by itself" do not
 *                  fragment the cache into two entries (§7.1).
 *
 *   variations() — 8 to 10 distinct paraphrases across registers: formal,
 *                  casual, keyword-only, frustrated, typo-inclusive. These are
 *                  pre-computed so an unseen paraphrase of a cached problem
 *                  still lands on the fast path (§6.2 semantic hit rate).
 *
 * Deterministic, because §6.1 requires identical output for identical input,
 * and because this runs inside a 300 ms budget.
 */

import { scrubUrls } from "./contract.js";

/* ============================================================== normalise */

/** Colloquial → canonical. Longest phrases first so they win. */
const PHRASES = [
  [/\bwon'?t turn on\b/gi, "does not power on"],
  [/\bwont power up\b/gi, "does not power on"],
  [/\bdoesn'?t turn on\b/gi, "does not power on"],
  [/\bkeeps? (?:going|turning) (?:black|blank|off)\b/gi, "displays blank screen"],
  [/\bgoes? (?:completely )?(?:black|blank)\b/gi, "displays blank screen"],
  [/\bblack screen\b/gi, "blank display"],
  [/\bscreen is dead\b/gi, "blank display"],
  [/\bnothing (?:shows|appears|displays)\b/gi, "displays blank screen"],
  [/\bflickers?\b/gi, "flickering display"],
  [/\bblinks?\b/gi, "flickering display"],
  [/\bdies (?:so )?fast\b/gi, "drains rapidly"],
  [/\bdrain(?:s|ing)? (?:really |so |very )?(?:fast|quick(?:ly)?)\b/gi, "drains rapidly"],
  [/\bruns? out of (?:charge|battery)\b/gi, "drains rapidly"],
  [/\b(?:really |very |so )?(?:slow|laggy|sluggish)\b/gi, "degraded performance"],
  [/\bfreez(?:es|ing)\b/gi, "degraded performance"],
  [/\bhangs?\b/gi, "degraded performance"],
  [/\btouch (?:isn'?t|is not) working\b/gi, "unresponsive touchscreen"],
  [/\bnot responding to touch\b/gi, "unresponsive touchscreen"],
  [/\bcracked\b/gi, "physically damaged screen"],
  [/\bbroken screen\b/gi, "physically damaged screen"],
  [/\bcan'?t see anything\b/gi, "blank display"],
  [/\bwhite screen\b/gi, "blank display"],
  [/\bhalf (?:the )?screen\b/gi, "partial display failure"]
];

/** Device and brand nouns carry no diagnostic signal in a cache key. */
const NOISE = /\b(?:my|the|a|an|i|i'?m|im|on|of|to|in|is|are|it|its|this|that|and|or|so|but|please|help|hi|hello|thanks?)\b/gi;
const MODELS = /\b(?:techcorp|nexa|galaxy|samsung|fold|flip|ultra|plus|pro|lite|tab(?:let)?|smart ?phone|phone|device|mobile|[a-z]\d{1,3}[a-z]?g?)\b/gi;

/**
 * One canonical technical query. Used as the semantic cache key, so two
 * differently-worded reports of the same fault collapse to one entry.
 */
export function canonical(query) {
  let q = scrubUrls(String(query || "")).toLowerCase();
  for (const [re, to] of PHRASES) q = q.replace(re, to);

  q = q
    .replace(MODELS, " ")
    .replace(NOISE, " ")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();

  // Token set, sorted: word order should not create a second cache entry.
  const tokens = [...new Set(q.split(" ").filter(t => t.length > 2))].sort();
  return tokens.join(" ");
}

/**
 * Generic modifiers that survive canonicalisation but carry no diagnostic
 * signal: intensity words, auxiliaries, vague time references.
 *
 * These are not stripped from the cache key itself — the key stays a faithful
 * reduction of the query — but they are dropped when two keys are compared for
 * similarity. Counted as content, they sink real paraphrases: "screen went
 * completely black" and "screen is totally black" share every meaningful word,
 * yet "went/completely" against "totally" pushed the overlap below threshold
 * and the pair missed the cache.
 */
const GENERIC = new Set([
  "went", "going", "goes", "keeps", "kept", "completely", "totally", "really", "very",
  "suddenly", "randomly", "constantly", "always", "never", "still", "just", "now",
  "cannot", "cant", "can", "wont", "want", "does", "doesnt", "didnt", "isnt", "arent",
  "been", "being", "have", "has", "had", "get", "gets", "got", "getting",
  "something", "anything", "nothing", "everything", "sometimes", "even", "much",
  "when", "while", "after", "before", "with", "without", "from", "into", "than",
  "about", "over", "there", "their", "then", "they", "them", "what", "which",
  "any", "all", "out", "off", "for", "but", "not", "one", "seems", "seem", "like",
  "try", "tried", "trying", "able", "unable", "problem", "issue", "help"
]);

/** The meaningful tokens of a canonical key, for similarity comparison. */
export function contentTokens(key) {
  return String(key || "").split(" ").filter(t => t && !GENERIC.has(t));
}

/* ============================================================= variations */

const TYPOS = [
  [/screen/gi, "scren"], [/display/gi, "dispaly"], [/battery/gi, "bettery"],
  [/phone/gi, "phne"], [/settings/gi, "setings"], [/black/gi, "blak"],
  [/touch/gi, "tuch"], [/flicker/gi, "flikker"], [/charging/gi, "chargin"]
];

/**
 * 8–10 distinct paraphrases across registers (§4.1).
 *
 * Built by transformation rather than generation: the same input always yields
 * the same list, which is what makes the pre-warmed cache reproducible. Each
 * template is checked for distinctness before it is kept.
 */
export function variations(query, { min = 8, max = 10 } = {}) {
  const base = scrubUrls(String(query || "")).replace(/\s{2,}/g, " ").trim();
  if (!base) return [];

  const core = symptomCore(base);
  const out = [];
  const push = v => {
    const t = String(v || "").replace(/\s{2,}/g, " ").trim();
    if (!t || t.length < 8) return;
    if (out.some(x => x.toLowerCase() === t.toLowerCase())) return;
    if (out.length < max) out.push(t);
  };

  // 1. the complaint itself, tidied
  push(base.endsWith(".") ? base : base + ".");

  // 2. formal / support-ticket register
  push(`The device is experiencing ${core}.`);

  // 3. first-person plain
  push(`My phone ${startsWithVerb(core) ? core : `has ${core}`}.`);

  // 4. question form
  push(`Why does my phone ${startsWithVerb(core) ? core : `have ${core}`}?`);

  // 5. help-seeking
  push(`How do I fix ${core} on my phone?`);

  // 6. keyword-only, the way someone searches
  push(keywordsOf(base));

  // 7. frustrated register
  push(`This is so annoying - ${core} and nothing I try works.`);

  // 8. casual
  push(`Hey so my phone ${startsWithVerb(core) ? core : `keeps having ${core}`}, any ideas?`);

  // 9. typo-inclusive, because real support queues are full of them
  push(withTypo(base));

  // 10. after-an-event framing
  push(`Ever since yesterday my phone ${startsWithVerb(core) ? core : `has ${core}`}.`);

  // Padding, only if the transformations collided and left us short.
  const spares = [
    `Need help with ${core}.`,
    `${cap(core)} - what should I do?`,
    `Device issue: ${core}.`,
    `Phone problem - ${core}.`
  ];
  for (const s of spares) { if (out.length >= min) break; push(s); }

  return out.slice(0, Math.max(min, Math.min(max, out.length)));
}

/** The symptom, stripped of device nouns and first-person framing. */
function symptomCore(query) {
  let c = String(query)
    .replace(/^\s*\d+[.)]\s*/, "")
    .replace(/^["']|["']$/g, "")
    .replace(/\bmy\s+(?:techcorp\s+)?(?:nexa\s+)?(?:[a-z]\d{1,3}[a-z]?g?\s+)?(?:fold\s+)?(?:smart ?phone|phone|tablet|device|screen)\b/gi, "")
    .replace(/^\s*(?:i\s+(?:have|am having|'m having)\s+)/i, "")
    .replace(/[.!?]+$/, "")
    .replace(/\s{2,}/g, " ")
    .trim();

  if (c.length > 110) c = c.slice(0, 110).replace(/\s+\S*$/, "");
  return c.charAt(0).toLowerCase() + c.slice(1);
}

const VERBS = /^(?:is|are|was|were|has|have|goes|go|keeps?|stays?|turns?|shows?|flickers?|drains?|freezes?|crashes?|stops?|won'?t|doesn'?t|does|can'?t|cannot|fails?|displays?|responds?)\b/i;
const startsWithVerb = s => VERBS.test(String(s).trim());

function keywordsOf(query) {
  const stop = new Set(["my", "the", "a", "an", "and", "or", "to", "of", "in", "on", "is", "are", "it", "its", "i", "so", "that", "this", "when", "with", "for", "but", "then", "after", "before"]);
  const words = String(query).toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/)
    .filter(w => w.length > 2 && !stop.has(w));
  return [...new Set(words)].slice(0, 6).join(" ");
}

function withTypo(query) {
  for (const [re, bad] of TYPOS) {
    if (re.test(query)) { re.lastIndex = 0; return query.replace(re, bad); }
  }
  // No known word to misspell — drop a space instead, which is just as common.
  return query.replace(/\b(\w{3,})\s(\w{3,})\b/, "$1$2");
}

const cap = s => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);
