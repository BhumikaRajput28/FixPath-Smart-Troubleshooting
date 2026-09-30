/**
 * Fast-path semantic cache (§2 [3], §6.3, §7.1).
 *
 * §7.1 names the failure this exists to avoid: keying on the raw string means
 * every paraphrase misses, and every miss costs a full extraction. So entries
 * are keyed on the canonical technical query, and the 8–10 pre-computed
 * paraphrases of a complaint are all indexed to the same entry when it is
 * stored. A wording nobody has typed before still lands on the fast path.
 *
 * Three levels, cheapest first:
 *
 *   exact     canonical key equality
 *   variation the query matches a stored paraphrase of a known problem
 *   fuzzy     Jaccard overlap of canonical token sets above a threshold
 *
 * Only validated plans are admitted, so a hit can be served with no further
 * checking — which is what makes the sub-300 ms budget reachable at all.
 */

import { canonical, contentTokens } from "../shared/variations.js";

const DEFAULT_TTL_MS = 60 * 60 * 1000;
const FUZZY_FLOOR = 0.62;
/** Containment: what share of the shorter key's content the other one covers. */
const CONTAINMENT_FLOOR = 0.8;
const CONTAINMENT_MIN_TOKENS = 3;

export class FastPathCache {
  constructor({ ttlMs = DEFAULT_TTL_MS, max = 2000 } = {}) {
    this.ttlMs = ttlMs;
    this.max = max;
    this.entries = new Map();      // canonical key -> record
    this.variationIndex = new Map(); // canonical(paraphrase) -> canonical key
    this.stats = { exact: 0, variation: 0, fuzzy: 0, miss: 0, stored: 0, evicted: 0 };
  }

  /**
   * @param {string} key      canonical technical query
   * @param {string[]} vars   the 8–10 paraphrases
   * @param {object} payload  { response, query_variations, query }
   */
  store(key, vars = [], payload) {
    if (!key || !payload?.response) return null;

    this.entries.set(key, {
      key,
      response: payload.response,
      query_variations: payload.query_variations || vars,
      sample: payload.query || "",
      storedAt: Date.now(),
      hits: 0
    });

    // Every paraphrase points at the same entry, which is the whole point.
    for (const v of vars) {
      const vk = canonical(v);
      if (vk && vk !== key) this.variationIndex.set(vk, key);
    }

    this.stats.stored++;
    this.#evict();
    return key;
  }

  /**
   * @returns {{response, query_variations, match}|null}
   */
  lookup(key, vars = []) {
    if (!key) return null;

    const exact = this.#live(key);
    if (exact) { this.stats.exact++; exact.hits++; return { ...exact, match: "exact" }; }

    // The incoming query may itself be a stored paraphrase.
    const viaVariation = this.variationIndex.get(key);
    if (viaVariation) {
      const rec = this.#live(viaVariation);
      if (rec) { this.stats.variation++; rec.hits++; return { ...rec, match: "variation" }; }
    }

    // Or one of its own paraphrases may match something stored.
    for (const v of vars) {
      const vk = canonical(v);
      const direct = this.#live(vk) || this.#live(this.variationIndex.get(vk));
      if (direct) { this.stats.variation++; direct.hits++; return { ...direct, match: "variation" }; }
    }

    const near = this.#fuzzy(key);
    if (near) { this.stats.fuzzy++; near.hits++; return { ...near, match: "fuzzy" }; }

    this.stats.miss++;
    return null;
  }

  /**
   * Jaccard overlap over the *content* tokens of two canonical keys.
   *
   * Comparing raw keys let generic filler dominate: "screen went completely
   * black" and "screen is totally black" describe one fault and share every
   * meaningful word, but the filler inflated the union enough to push them
   * apart. Dropping it first compares what the two complaints actually say.
   */
  #fuzzy(key) {
    const target = new Set(contentTokens(key));
    if (target.size < 2) return null;

    let best = null, bestScore = 0;
    for (const [k, rec] of this.entries) {
      if (Date.now() - rec.storedAt > this.ttlMs) continue;
      const other = new Set(contentTokens(k));
      if (!other.size) continue;

      let inter = 0;
      for (const t of target) if (other.has(t)) inter++;
      if (!inter) continue;

      const jaccard = inter / (target.size + other.size - inter);

      // Jaccard alone punishes a short complaint for being short. A stored key
      // built from a long, detailed query has many content tokens; a user who
      // types the same fault in six words can match every one of them and still
      // score under 0.5, because the union is dominated by the detail they
      // simply did not repeat. Containment asks the question that actually
      // matters — is this complaint's content a subset of one we have seen? —
      // and the absolute floor of three shared tokens keeps a two-word query
      // from latching onto a long unrelated entry.
      const containment = inter / Math.min(target.size, other.size);
      const score = Math.max(
        jaccard,
        (containment >= CONTAINMENT_FLOOR && inter >= CONTAINMENT_MIN_TOKENS) ? containment : 0
      );

      if (score > bestScore) { bestScore = score; best = rec; }
    }
    return bestScore >= FUZZY_FLOOR ? best : null;
  }

  #live(key) {
    if (!key) return null;
    const rec = this.entries.get(key);
    if (!rec) return null;
    if (Date.now() - rec.storedAt > this.ttlMs) { this.entries.delete(key); return null; }
    return rec;
  }

  #evict() {
    if (this.entries.size <= this.max) return;
    const oldest = [...this.entries.entries()].sort((a, b) => a[1].storedAt - b[1].storedAt)[0];
    if (!oldest) return;
    this.entries.delete(oldest[0]);
    for (const [v, k] of this.variationIndex) if (k === oldest[0]) this.variationIndex.delete(v);
    this.stats.evicted++;
  }

  /** Pre-warm from a seed file built by scripts/build-cache.js. */
  seed(records) {
    let n = 0;
    for (const r of records || []) {
      if (!r?.key || !r?.response) continue;
      this.store(r.key, r.query_variations || [], {
        response: r.response,
        query_variations: r.query_variations,
        query: r.query
      });
      n++;
    }
    this.stats.stored = n;
    return n;
  }

  list() {
    return [...this.entries.values()].map(r => ({
      key: r.key, sample: r.sample, hits: r.hits,
      contexts: r.response?.contexts?.length ?? 0,
      ageSec: Math.round((Date.now() - r.storedAt) / 1000)
    }));
  }

  get size() { return this.entries.size; }

  clear() {
    this.entries.clear();
    this.variationIndex.clear();
    this.stats = { exact: 0, variation: 0, fuzzy: 0, miss: 0, stored: 0, evicted: 0 };
  }
}
