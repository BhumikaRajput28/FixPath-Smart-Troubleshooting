/**
 * The data contract — a JavaScript mirror of schema.py, plus the rule
 * constraints from §4.1 of the specification.
 *
 * schema.py ships alongside this file unchanged, and scripts/validate.js can
 * cross-check any run against it with pydantic when Python is available. This
 * module is the enforcement point the service actually runs on, because §7.5
 * is explicit: asking a model to respect word counts in prose is unreliable,
 * so the counts are validated, trimmed and corrected in the application layer.
 *
 * Every rule below is stated as a predicate with a repair. A plan that cannot
 * be repaired is rejected rather than shipped — a response that violates the
 * contract is worse than an empty contexts list, which the spec defines as a
 * legitimate answer.
 */

/* ============================================================ enumerations */

export const CATEGORY = Object.freeze({ auto: "auto", manual: "manual", critical: "critical" });
export const CONDITION = Object.freeze({ greater: "greater", equal: "equal", less: "less" });
export const RESULT_TYPE = Object.freeze({ boolean: "boolean", integer: "integer", str: "str", float: "float" });

/** Least disruptive first, irreversible last (§4.1 category, §2 sequencing). */
export const CATEGORY_ORDER = { auto: 0, manual: 1, critical: 2 };

/* ================================================================== limits */

export const RULES = Object.freeze({
  TITLE_MIN_WORDS: 2,
  TITLE_MAX_WORDS: 3,
  DESC_MIN_WORDS: 5,
  DESC_MAX_WORDS: 7,
  DESC_PREFIX: "It will",
  GOAL_PATTERN: /^Follow these steps to perform this .+ (Troubleshooting|Configuration)$/,
  VARIATIONS_MIN: 8,
  VARIATIONS_MAX: 10,
  SCORE_MIN: 0,
  SCORE_MAX: 1
});

/**
 * §4.2.1 Zero URL Leaks. Models inject help URLs from pretraining memory, and
 * the rule is absolute — so this runs over every string the engine emits, not
 * only the ones that came from a model.
 */
const URL_PATTERNS = [
  /\[[^\]]*\]\([^)]*\)/g,          // markdown links, before anything eats the target
  /<a\s[^>]*>.*?<\/a>/gi,
  /\bhttps?:\/\/\S+/gi,
  /\bwww\.\S+/gi,
  /\b[a-z0-9-]+\.(?:com|net|org|io|co|ai|dev|info|biz|me|us|uk|in)\b(?:\/\S*)?/gi,
  /\[[^\]]*\]\s*\(\s*\)/g,       // an emptied link shell left by the passes above
  /\(\s*\)/g
];

/** The one URI scheme the contract permits, and only verbatim from the catalog. */
const ALLOWED_URI = /^voiceassist:\/\//;

/* ================================================================ scrubbing */

/**
 * Remove any web address from a user-visible string. Phrases like "at the
 * provided links" are left alone — they are harmless prose; it is the address
 * itself that must never appear.
 */
export function scrubUrls(text) {
  if (typeof text !== "string") return text;
  let out = text;
  for (const re of URL_PATTERNS) out = out.replace(re, "");
  return out.replace(/\s{2,}/g, " ").replace(/\s+([.,;:!?])/g, "$1").trim();
}

export function containsUrl(text) {
  if (typeof text !== "string") return false;
  return URL_PATTERNS.some(re => { re.lastIndex = 0; return re.test(text); });
}

/* ================================================================== words */

const words = s => String(s || "").trim().split(/\s+/).filter(Boolean);
export const wordCount = s => words(s).length;

/* ================================================================== goal */

/** "Follow these steps to perform this Screen Damage Troubleshooting" */
export function buildGoal(topic, kind = "Troubleshooting") {
  const clean = titleCase(scrubUrls(topic)).replace(/[.,;:]+$/, "").trim();
  return `Follow these steps to perform this ${clean} ${kind}`;
}

export function validGoal(goal) {
  return typeof goal === "string" && RULES.GOAL_PATTERN.test(goal.trim());
}

/* ================================================================= title */

/** 2–3 words, sentence case. "Screen display damage", "Battery fast drain". */
export function buildTitle(raw) {
  let w = words(scrubUrls(raw))
    .map(x => x.replace(/[^A-Za-z0-9'-]/g, ""))
    .filter(x => x && !STOPWORDS.has(bare(x)) && !MODEL_CODE.test(x));

  if (!w.length) w = ["Device", "issue"];
  w = w.slice(0, RULES.TITLE_MAX_WORDS);
  while (w.length < RULES.TITLE_MIN_WORDS) w.push("issue");

  // Sentence case: first word capitalised, the rest lowercased unless they are
  // product nouns that read wrong in lower case.
  return w
    .map((x, i) => properCase(x) || (i === 0 ? cap(x) : x.toLowerCase()))
    .join(" ");
}

export function validTitle(title) {
  const n = wordCount(title);
  if (n < RULES.TITLE_MIN_WORDS || n > RULES.TITLE_MAX_WORDS) return false;
  return /^[A-Z]/.test(String(title).trim());
}

/* =========================================================== actionName */

/** Title Case, naming exactly one physical screen or feature. */
export function buildActionName(raw) {
  const cleaned = scrubUrls(String(raw || ""))
    .replace(/^\s*(?:###?\s*)?(?:step\s*\d+\s*[:.\-]\s*)/i, "")
    .replace(/^\d+[.)]\s*/, "")
    .replace(/[.:;]+$/, "")
    .trim();
  const w = words(cleaned).slice(0, 6);
  if (!w.length) return "Review Device Settings";
  return w.map((x, i) => properCase(x) || (MINOR.has(x.toLowerCase()) && i !== 0 ? x.toLowerCase() : cap(x))).join(" ");
}

export function validActionName(name) {
  if (typeof name !== "string" || !name.trim()) return false;
  if (containsUrl(name)) return false;
  const w = words(name);
  if (w.length > 8) return false;
  return /^[A-Z0-9]/.test(w[0]);
}

/* =========================================================== description */

/**
 * Exactly 5–7 words, starting "It will". "It will" is two of them, so the
 * benefit clause gets 3–5. Built rather than prompted, then trimmed to fit —
 * §7.5 again.
 */
export function buildDescription(benefit) {
  const maxBody = RULES.DESC_MAX_WORDS - 2;
  const minBody = RULES.DESC_MIN_WORDS - 2;

  const body = words(scrubUrls(String(benefit || "")))
    .map(w => w.replace(/[^A-Za-z0-9'-]/g, ""))
    .filter(Boolean)
    .filter(w => !/^it$/i.test(w) && !/^will$/i.test(w))
    .filter(w => !/^your$/i.test(w));   // "Verify Your Phone's..." -> "verify phone's..."

  // Two passes, gentle first. A heading that already fits keeps its function
  // words, because they are what makes the clause read like English: "Attempt
  // to Power On" -> "It will attempt to power on". Only a heading too long to
  // fit gets the function words squeezed out, which is the lesser evil against
  // truncating the meaning. Padding with unrelated filler produced sentences
  // like "It will attempt power settings", which describes nothing.
  let chosen = body.length <= maxBody
    ? body
    : body.filter(w => !STOPWORDS.has(w.toLowerCase()));

  // "It will" needs a verb after it. Many section headings are noun phrases
  // ("Factors Affecting Touchscreen Performance") or gerunds ("Restarting Your
  // Device"), and dropping those in unchanged produced "It will factors
  // affecting touchscreen performance", which is not a sentence. A gerund is
  // turned back into its base form; anything else gets a verb in front.
  chosen = ensureVerbLead(chosen);

  if (chosen.length > maxBody) chosen = chosen.slice(0, maxBody);
  if (!chosen.length) chosen = ["restore", "normal", "behaviour"];

  // Still short. Filling with unrelated words gave "It will restart device
  // settings", which names a screen the action never touches, so the clause is
  // completed grammatically instead: an article after the verb, then a plain
  // object. Only if that still falls short does generic filler apply.
  if (chosen.length < minBody && chosen.length >= 2 && !isFunctionWord(chosen[1])) {
    chosen = [chosen[0], "the", ...chosen.slice(1)];
  }
  while (chosen.length < minBody && chosen.length < 3) {
    chosen = chosen.length === 1 ? [...chosen, "the", "device"] : [...chosen, "device"];
  }
  while (chosen.length < minBody) chosen.push(FILLER[chosen.length % FILLER.length]);

  return `${RULES.DESC_PREFIX} ${chosen.map(w =>
    properCase(w) || w.toLowerCase()
  ).join(" ")}`.replace(/\s{2,}/g, " ").trim();
}

/** Articles and prepositions that already make the clause read. */
const isFunctionWord = w => /^(the|a|an|to|for|on|in|of|with|your|this|from|off|up|out|at)$/i.test(String(w));

/** Imperative verbs the reference headings actually open with. */
const LEAD_VERBS = new Set([
  "check", "charge", "attempt", "force", "verify", "review", "clear", "use",
  "open", "select", "remove", "restart", "reboot", "adjust", "enable", "disable",
  "test", "transfer", "create", "mirror", "access", "disconnect", "connect",
  "troubleshoot", "configure", "set", "reset", "update", "install", "uninstall",
  "turn", "switch", "change", "confirm", "inspect", "examine", "clean", "replace",
  "contact", "visit", "try", "perform", "run", "start", "stop", "delete", "backup",
  "restore", "scan", "close", "exit", "hold", "press", "tap", "swipe", "navigate"
]);

/**
 * Make the clause after "It will" start with a verb.
 *
 * A gerund is reduced to its base form ("Restarting" -> "restart",
 * "Charging" -> "charge"); otherwise a neutral verb is placed in front, which
 * costs one of the five body words but buys a sentence that reads.
 */
function ensureVerbLead(w) {
  if (!w.length) return w;
  const first = w[0].toLowerCase();
  if (LEAD_VERBS.has(first)) return w;

  if (first.endsWith("ing") && first.length > 5) {
    const stem = first.slice(0, -3);
    for (const candidate of [stem, `${stem}e`]) {
      if (LEAD_VERBS.has(candidate)) return [candidate, ...w.slice(1)];
    }
  }

  return ["check", ...w];
}

export function validDescription(desc) {
  if (typeof desc !== "string") return false;
  if (containsUrl(desc)) return false;
  if (!desc.trim().toLowerCase().startsWith(RULES.DESC_PREFIX.toLowerCase())) return false;
  const n = wordCount(desc);
  return n >= RULES.DESC_MIN_WORDS && n <= RULES.DESC_MAX_WORDS;
}

/** Bring a non-compliant description back inside the window without losing sense. */
export function repairDescription(desc) {
  if (validDescription(desc)) return desc;
  const stripped = String(desc || "").replace(/^\s*it\s+will\s*/i, "");
  return buildDescription(stripped);
}

/* ================================================================== steps */

export function cleanStep(text) {
  let s = scrubUrls(String(text || ""))
    .replace(/^[\s\-*•·]+/, "")
    .replace(/^\d+[.)]\s*/, "")
    .replace(/\s{2,}/g, " ")
    .trim();
  if (!s) return null;
  if (!/[.!?]$/.test(s)) s += ".";
  return cap(s);
}

export function validStep(step) {
  return typeof step === "string" && step.trim().length > 3 && !containsUrl(step);
}

/* ============================================================== deeplinks */

/**
 * §4.2.2 Catalog Integrity. A deeplink is only valid if the URI came verbatim
 * from deeplinks.json. `catalogUris` is the Set built from the catalog at boot;
 * anything outside it is dropped, never rewritten.
 */
export function validActionableDeeplink(dl, catalogUris) {
  if (!dl || typeof dl !== "object") return false;
  if (typeof dl.deeplink !== "string" || !ALLOWED_URI.test(dl.deeplink)) return false;
  if (catalogUris && !catalogUris.has(dl.deeplink)) return false;
  if (typeof dl.description !== "string" || !dl.description.trim()) return false;
  if (containsUrl(dl.description) || containsUrl(dl.message || "")) return false;
  return true;
}

export function validValidationDeeplink(dl, catalogUris) {
  if (dl === null || dl === undefined) return true;
  if (typeof dl !== "object") return false;
  if (typeof dl.deeplink !== "string" || !ALLOWED_URI.test(dl.deeplink)) return false;
  if (catalogUris && !catalogUris.has(dl.deeplink)) return false;
  if (typeof dl.key !== "string" || !dl.key.trim()) return false;
  if (dl.resultType != null && !Object.values(RESULT_TYPE).includes(dl.resultType)) return false;
  if (dl.condition != null && !Object.values(CONDITION).includes(dl.condition)) return false;
  return true;
}

/* ============================================================== validation */

/**
 * Validate a whole ContextDeeplinkResponse against schema.py's shape and the
 * §4.1 rules. Returns every violation rather than the first, so the batch
 * report can show exactly which rule a run fails.
 */
export function validateResponse(payload, { catalogUris } = {}) {
  const errors = [];
  const at = (p, m) => errors.push(`${p}: ${m}`);

  if (!payload || typeof payload !== "object") return { ok: false, errors: ["response: not an object"] };
  if (!Array.isArray(payload.contexts)) return { ok: false, errors: ["response.contexts: not a list"] };

  payload.contexts.forEach((goal, gi) => {
    const gp = `contexts[${gi}]`;

    if (!validGoal(goal.goal)) at(`${gp}.goal`, `must match "Follow these steps to perform this <Topic> Troubleshooting" — got "${goal.goal}"`);
    if (!validTitle(goal.title)) at(`${gp}.title`, `must be ${RULES.TITLE_MIN_WORDS}-${RULES.TITLE_MAX_WORDS} words in sentence case — got "${goal.title}"`);
    if (typeof goal.score !== "number" || goal.score < RULES.SCORE_MIN || goal.score > RULES.SCORE_MAX) {
      at(`${gp}.score`, `must be a float in [0,1] — got ${goal.score}`);
    }
    if (!Array.isArray(goal.actions) || !goal.actions.length) {
      at(`${gp}.actions`, "must be a non-empty list");
      return;
    }

    // Ordering: least disruptive first, critical strictly last.
    const ranks = goal.actions.map(a => CATEGORY_ORDER[a.category ?? CATEGORY.manual] ?? 1);
    for (let i = 1; i < ranks.length; i++) {
      if (ranks[i] < ranks[i - 1]) {
        at(`${gp}.actions`, `out of order — ${goal.actions[i].category} follows ${goal.actions[i - 1].category}`);
        break;
      }
    }

    goal.actions.forEach((action, ai) => {
      const ap = `${gp}.actions[${ai}]`;

      if (!validActionName(action.actionName)) at(`${ap}.actionName`, `invalid — got "${action.actionName}"`);
      if (!validDescription(action.description)) {
        at(`${ap}.description`, `must be ${RULES.DESC_MIN_WORDS}-${RULES.DESC_MAX_WORDS} words starting "${RULES.DESC_PREFIX}" — got ${wordCount(action.description)} words: "${action.description}"`);
      }

      const cat = action.category ?? CATEGORY.manual;
      if (!Object.values(CATEGORY).includes(cat)) at(`${ap}.category`, `unknown category "${cat}"`);

      if (!Array.isArray(action.stepGroups) || !action.stepGroups.length) {
        at(`${ap}.stepGroups`, "must be a non-empty list");
        return;
      }

      action.stepGroups.forEach((sg, si) => {
        const sp = `${ap}.stepGroups[${si}]`;

        if (!Array.isArray(sg.steps) || !sg.steps.length) at(`${sp}.steps`, "must be a non-empty list");
        else sg.steps.forEach((st, sti) => {
          if (!validStep(st)) at(`${sp}.steps[${sti}]`, containsUrl(st) ? "contains a web URL" : `invalid step "${st}"`);
        });

        if (sg.actionableDeeplink != null) {
          // §4.1: a manual action is a physical intervention and cannot carry
          // an in-app deeplink, because there is no screen to open.
          if (cat === CATEGORY.manual) at(`${sp}.actionableDeeplink`, "a manual action must not carry an actionable deeplink");
          if (!validActionableDeeplink(sg.actionableDeeplink, catalogUris)) {
            at(`${sp}.actionableDeeplink`, `not a verbatim catalog entry — "${sg.actionableDeeplink.deeplink}"`);
          }
        }

        if (!validValidationDeeplink(sg.validationDeeplink, catalogUris)) {
          at(`${sp}.validationDeeplink`, "invalid validation deeplink");
        }
      });
    });
  });

  return { ok: errors.length === 0, errors };
}

/** §4.1 query_variations: 8–10 distinct paraphrases. */
export function validVariations(list) {
  if (!Array.isArray(list)) return false;
  if (list.length < RULES.VARIATIONS_MIN || list.length > RULES.VARIATIONS_MAX) return false;
  if (list.some(v => typeof v !== "string" || !v.trim() || containsUrl(v))) return false;
  return new Set(list.map(v => v.toLowerCase().trim())).size === list.length;
}

/* ================================================================ helpers */

const cap = s => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

export const STOPWORDS = new Set([
  "a", "an", "the", "on", "in", "at", "of", "for", "to", "and", "or", "your",
  "my", "with", "from", "is", "are", "was", "were", "this", "that", "it", "its",
  // Auxiliaries and filler. A title of "Screen does not" says nothing; dropping
  // these leaves the two or three words that actually name the problem.
  "does", "do", "did", "not", "no", "some", "things", "thing", "first", "use",
  "using", "when", "while", "how", "what", "you", "smartphone", "tablet",
  "phone", "device", "mobile", "issues", "issue", "problem", "problems",
  // Model names identify the hardware, not the fault. "Nexa Fold X1" is not a
  // title; "Screen half black" is.
  "nexa", "techcorp", "galaxy", "fold", "flip", "ultra", "plus", "pro", "lite",
  // Intensity and narrative filler. A complaint is mostly these words, and when
  // a reference article is generically titled the complaint becomes the title
  // source — leaving "Screen went completely" where "Screen black" was wanted.
  "went", "goes", "going", "gone", "keeps", "kept", "completely", "totally",
  "suddenly", "randomly", "constantly", "really", "very", "so", "just", "still",
  "can", "cant", "cannot", "wont", "doesn", "didn", "isn", "see", "seeing",
  "anything", "nothing", "something", "everything", "interact", "trying", "try",
  "then", "than", "also", "now", "after", "before", "because", "but", "if",
  "again", "i", "me", "we", "am", "be", "been", "have", "has", "had", "get"
]);

/** Model codes: x1, a14, a15g, s23, z5 — never the subject of a title. */
export const MODEL_CODE = /^(?:[a-z]\d{1,3}[a-z]?|\d+)$/i;

/** Stopword lookup ignores apostrophes, so "can't" matches "cant". */
const bare = w => String(w).toLowerCase().replace(/['’]/g, "");

const MINOR = new Set(["a", "an", "the", "and", "or", "of", "to", "in", "on", "for", "with", "at", "by"]);

/** Product nouns keep their own spelling wherever they appear. */
const PROPER_CASE = {
  "wi-fi": "Wi-Fi", wifi: "Wi-Fi", bluetooth: "Bluetooth", nfc: "NFC", gps: "GPS",
  sim: "SIM", usb: "USB", led: "LED", ldi: "LDI", techcorp: "TechCorp",
  nexa: "Nexa", android: "Android", gmail: "Gmail", dex: "DeX", qr: "QR"
};
const PROPER = new Set(Object.keys(PROPER_CASE));
const properCase = w => PROPER_CASE[String(w).toLowerCase()] || null;

const FILLER = ["device", "behaviour", "settings", "normally", "again"];

/** Title Case, used for the <Topic> inside a goal. */
export function titleCase(s) {
  return words(s)
    .map((w, i) => properCase(w) || (MINOR.has(w.toLowerCase()) && i !== 0 ? w.toLowerCase() : cap(w.toLowerCase())))
    .join(" ");
}
