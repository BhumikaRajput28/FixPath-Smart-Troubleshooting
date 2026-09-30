/**
 * Hybrid retrieval over the deeplink catalog (§2 Phase 2, §8 Phase 2).
 *
 * Two indexes over the same 578 entries, fused:
 *
 *   BM25    — Okapi BM25 over description + message + qna_description.
 *             Precise on the vocabulary the catalog actually uses.
 *   Dense   — a hashed character-n-gram vector with cosine similarity.
 *             Survives wording the keyword index misses ("turn screen off"
 *             vs "Screen timeout"), and, unlike a hosted embedding model,
 *             it adds no network hop to a path with a 300 ms budget.
 *
 * §7.4 is the constraint that shapes all of this: the URIs are opaque tokens.
 * Nothing here ever reads voiceassist://masked/act/aa73a35e8d — matching is on
 * the descriptive metadata only, and the URI is copied out verbatim at the end.
 *
 * With an embeddings key configured the dense side can be swapped for a real
 * model (see denseProvider), but the default has no dependencies and runs
 * offline, which is what keeps the fast path fast.
 */

import { readFileSync } from "node:fs";

const K1 = 1.5;          // BM25 term-frequency saturation
const B = 0.75;          // BM25 length normalisation
const DENSE_DIM = 512;   // hashed n-gram space
const NGRAM = 4;

/* ================================================================ tokenise */

const STOP = new Set([
  "the", "a", "an", "of", "to", "in", "on", "for", "and", "or", "your", "you",
  "is", "are", "it", "its", "this", "that", "with", "from", "at", "by", "be",
  "will", "can", "page", "screen", "device", "settings", "setting", "opens", "open"
]);

/** Kept deliberately light — the catalog's language is already terse. */
export function tokenize(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter(t => t.length > 1 && !STOP.has(t));
}

/* =================================================================== dense */

/**
 * Hash character n-grams into a fixed vector. Cheap, deterministic, and
 * tolerant of the morphology BM25 trips on (plurals, "-ing", compounding).
 */
export function denseVector(text) {
  const s = ` ${String(text || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()} `;
  const v = new Float32Array(DENSE_DIM);

  for (let n = 3; n <= NGRAM; n++) {
    for (let i = 0; i + n <= s.length; i++) {
      const gram = s.slice(i, i + n);
      if (gram.trim().length < 2) continue;
      v[hash(gram) % DENSE_DIM] += 1;
    }
  }

  let norm = 0;
  for (let i = 0; i < DENSE_DIM; i++) norm += v[i] * v[i];
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < DENSE_DIM; i++) v[i] /= norm;
  return v;
}

export function cosine(a, b) {
  let d = 0;
  for (let i = 0; i < DENSE_DIM; i++) d += a[i] * b[i];
  return d;
}

function hash(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/* ================================================================== index */

export class DeeplinkIndex {
  /**
   * @param {object[]} entries raw catalog entries from deeplinks.json
   */
  constructor(entries) {
    this.entries = entries.filter(e => e && typeof e.deeplink === "string");
    this.placeholder = this.entries.find(e => /dummy_positive/.test(e.deeplink)) || null;

    // Every URI in the catalog, for the contract's integrity check.
    this.uris = new Set();
    for (const e of this.entries) {
      this.uris.add(e.deeplink);
      if (e.validation?.deeplink) this.uris.add(e.validation.deeplink);
    }

    this.docs = this.entries.map(e => {
      const text = [e.description, e.message, e.qna_description].filter(Boolean).join(" . ");
      const terms = tokenize(text);
      const tf = new Map();
      for (const t of terms) tf.set(t, (tf.get(t) || 0) + 1);
      return { entry: e, text, terms, tf, len: terms.length, vec: denseVector(text) };
    });

    this.avgLen = this.docs.reduce((a, d) => a + d.len, 0) / (this.docs.length || 1);

    // Inverted index -> document frequency.
    this.df = new Map();
    for (const d of this.docs) {
      for (const t of new Set(d.terms)) this.df.set(t, (this.df.get(t) || 0) + 1);
    }

    this.postings = new Map();
    this.docs.forEach((d, i) => {
      for (const t of new Set(d.terms)) {
        if (!this.postings.has(t)) this.postings.set(t, []);
        this.postings.get(t).push(i);
      }
    });
  }

  static fromFile(path) {
    const raw = JSON.parse(readFileSync(path, "utf8"));
    return new DeeplinkIndex(raw.deeplinks || raw);
  }

  /** Okapi BM25. */
  bm25(queryTerms) {
    const N = this.docs.length;
    const scores = new Map();

    for (const t of new Set(queryTerms)) {
      const posting = this.postings.get(t);
      if (!posting) continue;
      const idf = Math.log(1 + (N - this.df.get(t) + 0.5) / (this.df.get(t) + 0.5));

      for (const i of posting) {
        const d = this.docs[i];
        const f = d.tf.get(t) || 0;
        const denom = f + K1 * (1 - B + B * (d.len / this.avgLen));
        scores.set(i, (scores.get(i) || 0) + idf * ((f * (K1 + 1)) / denom));
      }
    }
    return scores;
  }

  /**
   * How much of the query's *distinctive* vocabulary a document actually
   * contains, weighted by IDF so that "timeout" counts for far more than
   * "screen". This is the absolute confidence signal: a normalised BM25 score
   * is always ~1.0 for whichever document ranks first, even when that document
   * is wrong, so ranking alone can never decide whether to attach a deeplink.
   */
  idfCoverage(queryTerms, docIndex) {
    const d = this.docs[docIndex];
    if (!d) return 0;
    const N = this.docs.length;
    let total = 0, matched = 0;
    for (const t of new Set(queryTerms)) {
      const df = this.df.get(t) || 0;
      const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5));
      total += idf;
      if (d.tf.has(t)) matched += idf;
    }
    return total ? matched / total : 0;
  }

  /**
   * Hybrid search. BM25 and dense scores are each normalised to [0,1] over the
   * candidate set before fusion, so neither scale dominates the other.
   *
   * @param {string} query free text describing the target screen
   * @param {object} opts  { limit, alpha }  alpha weights BM25 against dense
   * @returns {{entry, score, bm25, dense}[]}
   */
  search(query, { limit = 5, alpha = 0.6, leaf = null } = {}) {
    const terms = tokenize(query);
    const coverageTerms = leaf ? tokenize(leaf) : terms;
    if (!terms.length) return [];

    const bm = this.bm25(terms);
    const qv = denseVector(query);

    // Dense is scored over the BM25 candidates plus a widened pool, so a
    // paraphrase with no lexical overlap can still surface.
    const candidates = new Set(bm.keys());
    if (candidates.size < 40) {
      for (let i = 0; i < this.docs.length; i++) candidates.add(i);
    }

    const maxBm = Math.max(...bm.values(), 1e-9);
    const rows = [];
    for (const i of candidates) {
      const d = this.docs[i];
      const dense = cosine(qv, d.vec);
      const keyword = (bm.get(i) || 0) / maxBm;
      rows.push({
        i, entry: d.entry, bm25: keyword, dense,
        coverage: this.idfCoverage(coverageTerms.length ? coverageTerms : terms, i),
        score: alpha * keyword + (1 - alpha) * dense
      });
    }

    rows.sort((a, b) => b.score - a.score);
    return rows.slice(0, limit);
  }

  /** The generic entry, used only when nothing else matches a Settings screen. */
  placeholderEntry() {
    return this.placeholder;
  }
}

/* ========================================================= screen resolution */

/**
 * §6.2 Screen Resolution Accuracy: map to the exact target screen rather than
 * a high-level parent menu.
 *
 * Step text is the query, but raw steps are noisy ("Navigate to and open
 * Settings."). This lifts out the concrete destination — the last named screen
 * or control in a "Settings → Display → Navigation bar" chain — and searches on
 * that, so the match lands on the leaf rather than on "Settings".
 */
/**
 * Is this extracted target worth searching for?
 *
 * Step text yields fragments as well as destinations — "and drop new into",
 * "minus next", "X", a bare "Add". Searching for those cannot find the right
 * screen and might find a wrong one, so they are discarded before retrieval
 * rather than left to be rejected by a threshold.
 */
const FRAGMENT_START = /^(?:and|or|to|into|from|next|then|with|for|the|a|an|at|of|on|in)\b/i;
const GENERIC_CONTROL = new Set([
  "add", "edit", "remove", "next", "done", "ok", "okay", "close", "cancel", "back",
  "start", "stop", "input", "minus", "plus", "more", "menu", "x", "yes", "no",
  "delete", "save", "apply", "select", "confirm", "continue", "finish"
]);

export function usableTarget(leaf) {
  const t = String(leaf || "").trim();
  if (t.length < 3 || !/[a-z]/i.test(t)) return false;
  if (FRAGMENT_START.test(t)) return false;

  const tokens = tokenize(t);
  if (!tokens.length) return false;
  // Generic control words name buttons, not screens — whether there is one of
  // them ("Add") or several ("minus next").
  if (tokens.every(w => GENERIC_CONTROL.has(w.toLowerCase()))) return false;
  return true;
}

/**
 * @param {object} opts
 *   context  the original complaint, for disambiguation
 *   topic    the action's own subject ("Use Multi Window"), tried as a last
 *            candidate when the step trail yields nothing usable
 */
/**
 * @param {"hybrid"|"keyword"} mode
 *   hybrid  BM25 fused with dense similarity, and the dense gate applied
 *   keyword BM25 only, dense gate bypassed — the "pure rules-based" variant
 *           the specification asks to be compared against in Appendix C §5
 */
export function resolveScreen(index, steps, { context = "", limit = 6, topic = "", mode = "hybrid" } = {}) {
  const keywordOnly = mode === "keyword";
  const trail = screenTrail(steps);

  // The step trail names where the taps land; the action heading names what the
  // whole group is for. When the trail's leaf is a button ("Tap X") the heading
  // is the better query — that is how "Use Multi Window" reaches the catalog's
  // Multi window entries, which the leaf "X" never could.
  const candidates = [
    ...(trail ? trail.candidates : []).filter(usableTarget),
    ...(usableTarget(topic) ? [String(topic).trim()] : [])
  ];
  const seen = new Set();
  const queue = candidates.filter(c => {
    const k = c.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  if (!queue.length) {
    return { entry: null, reason: trail ? "no-usable-target" : "no-screen-in-steps", target: trail?.leaf || null };
  }

  const polarity = stepPolarity(steps);

  // Each candidate destination is searched on its own and the strongest wins,
  // so the trail's shape does not decide the answer.
  // Candidates are tried deepest-first and the FIRST one that genuinely passes
  // wins. Scoring them against each other lets a generic parent menu outrank
  // the screen the user actually needs — §2 calls that out as parent-menu
  // matching, and it is the main way a deeplink lands on the wrong page.
  const topicKey = usableTarget(topic) ? String(topic).trim().toLowerCase() : null;
  let ranked = [], best = null, chosenLeaf = queue[0], accepted = false;

  for (const [depth, leaf] of queue.entries()) {
    const hits = index.search(`${leaf} ${context}`.trim(),
      { limit, leaf, alpha: keywordOnly ? 1 : 0.6 });
    if (!hits.length) continue;

    // A topic-derived candidate is the action's heading, not a destination the
    // steps named. The catalog usually holds both an Enable and a Disable entry
    // for a feature, so the question is whether anything grounds a direction.
    //
    //   steps say "tap the switch ... to disable it"  -> polarity off, and the
    //     Disable entry is what the article actually instructs
    //   steps merely explain how to use a feature     -> no direction at all,
    //     and picking Enable or Disable would silently flip a setting the
    //     article never asked the user to change
    //
    // So a toggle may win from a topic only when the steps state a direction;
    // otherwise only a navigational entry is eligible.
    const fromTopic = topicKey !== null && leaf.toLowerCase() === topicKey;
    const directed = polarity === "on" || polarity === "off";
    const usable = (fromTopic && !directed)
      ? hits.filter(h => h.entry.originalType === "onClickURL")
      : hits;
    if (!usable.length) continue;

    const withPolarity = applyPolarity(usable, polarity);
    for (const h of withPolarity) h.messageMatch = messageMatch(leaf, h.entry);

    // Polarity re-ranking can lift a near-miss above a genuine match, so the
    // top few are all tested against the gates and the first that clears them
    // wins. Checking only the first would discard a correct entry because a
    // sibling toggle happened to sort above it.
    const gates = h =>
      h.coverage >= ACCEPT_COVERAGE &&
      (keywordOnly || h.dense >= ACCEPT_DENSE) &&
      h.messageMatch >= ACCEPT_MESSAGE;

    const top = withPolarity.find(gates) || withPolarity[0];
    const passes = gates(top);

    // Keep the strongest near-miss for diagnostics even when nothing passes.
    if (!best || top.coverage * top.messageMatch > (best.coverage || 0) * (best.messageMatch || 0)) {
      best = top; ranked = withPolarity; chosenLeaf = leaf;
    }

    if (passes) {
      best = top; ranked = withPolarity; chosenLeaf = leaf; accepted = true;
      break;
    }
    void depth;
  }

  if (!best) return { entry: null, reason: "no-candidates", target: queue[0] };

  if (accepted) {
    return {
      entry: best.entry, score: best.score, coverage: best.coverage,
      dense: best.dense, messageMatch: best.messageMatch,
      target: chosenLeaf, polarity, best, runnerUp: ranked[1] || null, reason: "matched"
    };
  }

  // No catalog entry fits. If the steps still land the user on a Settings
  // screen, the catalog's own generic placeholder is the honest answer; if they
  // do not — a button hold, a phone call, a visit to a service centre — the
  // group gets no actionable deeplink at all.
  return {
    entry: null, weak: true, best, target: chosenLeaf, polarity,
    coverage: best.coverage, dense: best.dense, messageMatch: best.messageMatch,
    reason: "below-threshold",
    settingsScreen: opensSettingsScreen(steps)
  };
}

/**
 * Re-rank so the toggle direction the steps asked for wins. Without this the
 * Enable and Disable entries for one screen are indistinguishable and the
 * choice between them is effectively a coin flip.
 */
function applyPolarity(hits, polarity) {
  const want = { on: "onURL", off: "offURL", open: "onClickURL" }[polarity];
  return hits
    .map(h => {
      const type = h.entry.originalType;
      let bonus = 0;
      if (type === want) bonus = 0.12;
      else if (polarity !== "open" && type === "onClickURL") bonus = 0.04;
      else if (polarity !== "open" && (type === "onURL" || type === "offURL")) bonus = -0.08;
      return { ...h, score: h.score + bonus };
    })
    .sort((a, b) => b.score - a.score);
}

/**
 * How tightly the target screen's own name matches the leaf.
 *
 * IDF coverage alone is unreliable for a one-word destination: "Storage"
 * scores full coverage against "Storage Share", which is a different screen
 * entirely. Comparing against the entry's message — its screen name, with the
 * catalog's leading verb removed — is what separates the screen you asked for
 * from a screen that merely mentions the same word.
 */
export function messageMatch(leaf, entry) {
  // Catalog messages stack verbs — "View Adjust Brightness" — so every leading
  // verb comes off before the screen's actual name is compared.
  const strip = /^(view|open|enable|disable|adjust|update|switch|set|turn|check|go|see|tap|change|choose)\s+/i;
  let name = String(entry?.message || "");
  for (let i = 0; i < 4 && strip.test(name); i++) name = name.replace(strip, "");
  const nameTokens = tokenize(name);
  if (!nameTokens.length) return 0;

  const leafTokens = new Set(tokenize(leaf).map(collapse));
  if (!leafTokens.size) return 0;

  const covered = nameTokens.filter(t => leafTokens.has(collapse(t))).length;
  return covered / nameTokens.length;
}

/** "wi-fi" and "wifi" are the same screen; so are "backups" and "backup". */
const collapse = t => String(t).replace(/[^a-z0-9]/g, "").replace(/s$/, "");

/** Acceptance thresholds, tuned against the supplied catalog. */
export const ACCEPT_COVERAGE = 0.55;
export const ACCEPT_DENSE = 0.33;
export const ACCEPT_MESSAGE = 0.6;

/**
 * Does this group of steps actually put the user on a Settings screen? That is
 * the precondition the catalog places on its own placeholder entry.
 */
export function opensSettingsScreen(steps) {
  const text = (Array.isArray(steps) ? steps : [steps]).join(" ").toLowerCase();
  if (!/\bsettings\b|\bquick settings\b|\bnotification panel\b/.test(text)) return false;
  // A physical or off-device instruction is not a screen, even if it mentions
  // the word "settings" in passing.
  if (/service cent(er|re)|customer support|call|visit|insert the ejector|press and hold (the )?power/i.test(text)) return false;
  return true;
}

/**
 * Pull the destination out of a group of steps.
 *
 * Steps read as a trail — "Settings → Apps → your email app → Storage → Clear
 * cache" — and the *leaf* is what the deeplink has to open. Concatenating the
 * whole trail dilutes the match: every step adds common words like "Settings"
 * that every catalog entry also contains, so the distinctive term at the end
 * stops carrying the query. The leaf is therefore searched on its own, with
 * the trail passed only as weak context.
 *
 * @returns {{leaf:string, trail:string, verbs:string[]}|null}
 */
export function screenTrail(steps) {
  const list = Array.isArray(steps) ? steps : [steps];
  const parts = [];
  const verbs = [];

  for (const raw of list) {
    const s = String(raw || "");

    const chain = s.match(/settings\s*(?:>|→|›)\s*([^.]+)/i);
    if (chain) {
      for (const seg of chain[1].split(/[>→›]/)) {
        const t = seg.trim();
        if (t && !/^settings?$/i.test(t)) parts.push(t);
      }
      continue;
    }

    // Every verb+destination pair in the sentence, not just the first. A single
    // non-global match took only the leading one, so "Go to Settings, tap
    // Connections, then tap Wi-Fi" yielded "Settings" — which is then excluded
    // as the root menu — and the real destination was never seen at all.
    const pairs = s.matchAll(
      /\b(tap(?:\s+on)?|select|choose|toggle|switch|touch(?:\s+and\s+hold)?|turn\s+(?:on|off)|enable|disable|go\s+to|navigate\s+to(?:\s+and\s+open)?|open|adjust|move|drag)\s+(.+?)(?:\s*[,.]|\s+(?:and\s+then|then|to|so|until|for|if|which|that)\b|$)/gi);

    for (const verb of pairs) {
      verbs.push(verb[1].toLowerCase().replace(/\s+/g, " "));
      const phrase = verb[2]
        .replace(/\b(the|your|a|an|icon|button|option|menu|slider|switch|app|page|screen)\b/gi, " ")
        .replace(/[^A-Za-z0-9\s-]/g, " ")
        .replace(/\s{2,}/g, " ")
        .trim();
      if (phrase && !/^settings?$/i.test(phrase)) parts.push(phrase);
    }
  }

  if (!parts.length) return null;

  const trim = p => p.split(/\s+/).slice(0, 4).join(" ");

  // The last step is not always the screen. "Tap Navigation bar. Select your
  // preferred navigation type." ends on the choice, but the screen the
  // deeplink must open is the one before it. So the final few destinations all
  // become candidate leaves and the index decides which is a real screen.
  const tail = parts.slice(-3).map(trim).filter(Boolean);
  const candidates = [...new Set([...tail].reverse())];

  return {
    leaf: candidates[0],
    candidates,
    trail: parts.slice(0, -1).join(" "),
    verbs
  };
}

/** Back-compat helper: the flat phrase, used by tests and diagnostics. */
export function screenPhrase(steps) {
  const t = screenTrail(steps);
  return t ? [t.trail, t.leaf].filter(Boolean).join(" ").trim() || null : null;
}

/**
 * Which polarity of a toggle the steps are asking for.
 *
 * The catalog carries Enable and Disable variants of the same screen with
 * near-identical descriptions, so text similarity cannot separate them — only
 * the instruction's own verb can. onURL enables, offURL disables, onClickURL
 * just opens the screen.
 */
export function stepPolarity(steps) {
  const text = (Array.isArray(steps) ? steps : [steps]).join(" ").toLowerCase();
  if (/\b(turn off|switch off|disable|deactivate|uncheck|untick|remove|delete|clear)\b/.test(text)) return "off";
  if (/\b(turn on|switch on|enable|activate|check|tick|select|back up|allow)\b/.test(text)) return "on";
  return "open";
}

/**
 * Optional dense provider. When an embeddings key is configured the caller can
 * swap in real embeddings; the index keeps working either way, and the default
 * never leaves the machine.
 */
export const denseProvider = {
  name: "hashed-char-ngram",
  dim: DENSE_DIM,
  embed: denseVector
};
