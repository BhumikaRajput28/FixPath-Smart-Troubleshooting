/**
 * Phase 1 — Structure Extraction (§2 [1], §8 Phase 1).
 *
 * Turns the unstructured customer-care reference text into a Goal object with
 * categorised Actions and atomic UI steps.
 *
 * The rule that shapes this module is §4.2.3: no hallucinated steps. Every
 * step emitted here is a sentence that appeared in the supplied reference
 * text, cleaned and trimmed — never invented, never inferred. If the text
 * contains no viable instruction the extractor returns nothing, and the caller
 * answers with an empty contexts list, which the specification defines as a
 * legitimate response.
 *
 * A model is not required. When one is configured it may re-word an
 * actionName or a description, but it is never the source of a step — see
 * engine/llm.js.
 */

import {
  buildGoal, buildTitle, buildActionName, buildDescription,
  cleanStep, scrubUrls, CATEGORY, CATEGORY_ORDER, MODEL_CODE, STOPWORDS
} from "../shared/contract.js";

/* ============================================================== sectioning */

/** Headings in the corpus are "## Step 3: ..." or "### 2. ..." or plain "## X". */
const HEADING = /^(#{1,4})\s*(.+?)\s*$/;

/**
 * Split reference content into titled sections. The corpus is consistently
 * heading-delimited, so this is parsing, not guessing; text before the first
 * heading is kept as a preamble and used only for context, never for steps.
 */
export function sections(content) {
  const lines = String(content || "").split(/\r?\n/);
  const out = [];
  let current = null;
  let preamble = [];

  for (const line of lines) {
    const m = line.match(HEADING);
    if (m && m[2].replace(/[#\s]/g, "").length > 1) {
      if (current) out.push(current);
      current = { heading: m[2].trim(), body: [] };
    } else if (current) {
      if (line.trim()) current.body.push(line.trim());
    } else if (line.trim()) {
      preamble.push(line.trim());
    }
  }
  if (current) out.push(current);

  // Some rows are a single unheaded block; the whole thing is then one section
  // titled from the leading line.
  if (!out.length && preamble.length) {
    out.push({ heading: preamble[0].slice(0, 80), body: preamble.slice(1) });
  }

  return { sections: out, preamble: preamble.join(" ") };
}

/* ================================================================== steps */

/** Sentences that are instructions, not commentary. */
const IMPERATIVE = /^(navigate|go|open|tap|touch|select|choose|press|hold|swipe|scroll|turn|switch|toggle|enable|disable|check|verify|confirm|ensure|insert|remove|connect|disconnect|plug|unplug|charge|restart|reboot|power|clear|delete|uninstall|install|update|download|contact|visit|call|try|attempt|shine|examine|inspect|wait|hold|drag|move|adjust|set|add|back up|sign|log|restore|reset|force|close|exit|return|repeat|locate|find|look|place|put|enter|type|scan|point)\b/i;

/** Commentary that describes an outcome rather than an action to take. */
const NARRATION = /^(this|that|if|when|the|your|you(?:'|’)?ll|you will|it|these|those|there|here(?:'|’)?s|here is|remember|note|please note|for example|in such|sometimes|normally|once)\b/i;

/**
 * A step whose instruction lived in a link.
 *
 * §4.2.1 strips URLs, which is right, but it leaves sentences like "Find
 * instructions on how to remove your account at the provided links" — an
 * imperative that now points nowhere. A step the user cannot act on is worse
 * than one fewer step, so these are dropped rather than shipped.
 */
const LINK_DEPENDENT = /\b(?:at the (?:provided|following|below) links?|see the links? below|refer to the links?|click (?:here|the link)|visit the links?|using the links? (?:above|below)|from the links? (?:above|below))\b/i;

/**
 * Break a section body into single-interaction steps.
 *
 * "One physical interaction per step" (§4.1) is the constraint, so compound
 * sentences joined by "and then" are split, and prose that merely explains
 * what will happen is dropped.
 */
export function stepsFrom(body) {
  const raw = [];

  for (const line of body) {
    const cleaned = scrubUrls(line);
    if (!cleaned) continue;

    // Split into sentences, then split those on sequencing conjunctions.
    for (const sentence of cleaned.split(/(?<=[.!?])\s+/)) {
      for (const piece of sentence.split(/\s*,?\s+(?:and\s+then|then)\s+/i)) {
        const t = piece.trim();
        if (t) raw.push(t);
      }
    }
  }

  const steps = [];
  for (const candidate of raw) {
    // Instructions in this corpus open with politeness and sequencing —
    // "Now, please connect...", "After charging, disconnect..." — which hides
    // the verb from the imperative test. Strip a leading adverbial clause,
    // then any politeness, before deciding.
    let stripped = candidate
      .replace(/^(?:first|next|now|finally|also|alternatively|afterwards?|lastly|additionally)[,\s]+/i, "")
      .replace(/^(?:after|before|once|when|while|if)\b[^,]{0,48},\s*/i, "")
      .replace(/^(?:please|kindly|try to|make sure to|be sure to|you (?:should|can|may|will need to))\s+/i, "")
      .replace(/^(?:let(?:'|’)?s|we(?:'|’)?ll)\s+(?:try to\s+|now\s+)?/i, "")
      .trim();
    stripped = stripped.charAt(0).toUpperCase() + stripped.slice(1);
    if (!stripped) continue;

    // Keep only instructions. A sentence that opens with narration is context
    // for the reader, not a step for the checklist.
    const isImperative = IMPERATIVE.test(stripped) && !NARRATION.test(stripped);
    if (!isImperative) continue;
    if (LINK_DEPENDENT.test(stripped)) continue;
    // "Tap Wi-Fi." is two words and a perfectly good atomic step, so the floor
    // is two — but a two-word step whose object is a pronoun ("Tap it") carries
    // no destination and is dropped.
    const n = stripped.split(/\s+/).length;
    if (n < 2) continue;
    if (n === 2 && /\b(it|them|this|that|these|those|here|there|again)\b[.!]?$/i.test(stripped)) continue;
    if (stripped.split(/\s+/).length > 34) continue;

    const step = cleanStep(stripped);
    if (step && !steps.includes(step)) steps.push(step);
  }

  return steps;
}

/* ============================================================== categories */

/**
 * Irreversible or disruptive actions, which §2 orders last.
 *
 * The reset alternatives are spelled out with an optional middle word because
 * "factory reset" alone does not match "Factory data reset" — the wording the
 * corpus actually uses. That gap classified the single most destructive action
 * in the whole corpus as `auto`, which ordered it FIRST, ahead of charging the
 * device. Matching the phrase loosely is the whole point of this pattern.
 */
const CRITICAL = /\b(factory(?:\s+\w+)?\s+reset|reset\s+(?:your\s+)?(?:\w+\s+)?(?:phone|device|tablet|settings)|erase all|erase (?:your )?data|delete all data|safe mode|restart|reboot|power (?:off|cycle)|force a? ?restart|remove the battery|firmware|software update|wipe|format|recovery mode|hard reset)\b/i;

/**
 * Evidence that the user has to do something away from the screen: handle
 * hardware, look at the device, go somewhere, use another machine.
 */
const PHYSICAL = [
  /\bservice cent(?:er|re)\b/i, /\bauthori[sz]ed\b/i, /\btechnician\b/i, /\bwarranty\b/i,
  /\bappointment\b/i, /\bcontact (?:customer )?(?:support|care|us)\b/i,
  /\bphysical damage\b/i, /\bliquid\b/i, /\bldi\b/i, /\bcrack(?:s|ed)?\b/i, /\bdent(?:s|ed)?\b/i,
  /\bcharging port\b/i, /\bcharger\b/i, /\bcable\b/i, /\busb\b/i, /\bplug\b/i, /\bunplug\b/i,
  /\bremove [^.]{0,24}(?:case|cover|accessor|protector)/i, /\b(?:soft|dry|damp) cloth\b/i,
  /\bclean\b/i, /\bsim (?:card|tray)\b/i, /\bejector\b/i,
  /\bpersonal computer\b/i, /\bon a pc\b/i, /\banother (?:phone|device)\b/i,
  /\bpress and hold\b/i, /\bside button\b/i, /\bvolume (?:up|down) (?:key|button)\b/i
];

/** Evidence that the steps are a sequence of on-screen interactions. */
const UI = [
  /\btaps?\b/i, /\bswipes?\b/i, /\btoggle\b/i, /\bnavigate to\b/i, /\bselect\b/i,
  /\bsettings\b/i, /\bopen\b/i, /\bscroll\b/i, /\bmenu\b/i, /\bicon\b/i,
  /\bpanel\b/i, /\bscreen\b/i, /\benable\b/i, /\bdisable\b/i, /\bswitch\b/i,
  /\bslider\b/i, /\bcheckbox\b/i, /\bapps? screen\b/i, /\bhome screen\b/i, /\btouch\b/i
];

const hits = (patterns, text) => patterns.reduce((n, re) => n + (re.test(text) ? 1 : 0), 0);

/**
 * §4.1 categories.
 *
 * critical is checked first, because a destructive step outranks everything
 * else in a group — a section that opens a settings screen and then tells you
 * to factory reset is critical, and must be ordered last.
 *
 * The auto/manual split is then decided on evidence rather than on a default.
 * Defaulting to manual was wrong in a way that quietly cost the whole feature:
 * manual actions are forbidden a deeplink by §4.1, so every UI sequence that
 * happened not to contain the literal word "Settings" — "Tap the All apps
 * icon", "Swipe up on the Home screen" — was classed manual and stripped of the
 * deeplink it should have carried. So a step sequence is auto unless the text
 * shows more hardware-handling evidence than on-screen evidence.
 */
export function classify(steps, heading = "") {
  const text = `${heading} ${steps.join(" ")}`;
  if (CRITICAL.test(text)) return CATEGORY.critical;

  const physical = hits(PHYSICAL, text);
  const ui = hits(UI, text);

  if (!ui) return CATEGORY.manual;         // nothing on screen to open
  return physical > ui ? CATEGORY.manual : CATEGORY.auto;
}

/* =========================================================== step grouping */

/**
 * Group steps that happen on one screen.
 *
 * §7.2 is explicit that one action equals one screen. A section that walks the
 * user back to Settings a second time is describing a second destination, so a
 * new group starts there and can carry its own deeplink.
 */
export function groupSteps(steps) {
  const groups = [];
  let current = [];

  const isEntry = s => /^(?:navigate to|go to|open)\s+(?:and open\s+)?settings\b/i.test(s) ||
                       /^swipe down from the top/i.test(s);

  for (const step of steps) {
    if (isEntry(step) && current.length) {
      groups.push(current);
      current = [step];
    } else {
      current.push(step);
    }
  }
  if (current.length) groups.push(current);

  return groups.length ? groups : [steps];
}

/* ================================================================ benefit */

/**
 * The benefit clause behind an action's description.
 *
 * Built from the section's own heading, which is already a verb phrase in this
 * corpus ("Force a Restart", "Check for Physical Damage"). That keeps the
 * wording traceable to the source text and produces something a person can
 * read, which mining a random explanatory sentence did not.
 */
function benefitFor(heading, body) {
  const cleaned = String(heading || "")
    .replace(/^\s*(?:step\s*\d+\s*[:.\-]\s*|\d+[.)]\s*)/i, "")
    .replace(/[^A-Za-z0-9'\s-]/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();

  const words = cleaned.split(/\s+/).filter(Boolean);
  if (words.length >= 2) return words.join(" ");

  // A one-word heading carries no benefit, so fall back to the first
  // instruction's own verb phrase.
  const first = (body || []).find(l => l.split(/\s+/).length > 3);
  return first ? first.split(/\s+/).slice(0, 6).join(" ") : cleaned || "resolve the issue";
}

/* ================================================================ extract */

/**
 * @param {{title?:string, content?:string}} siis reference text
 * @param {{query?:string, topic?:string}} opts
 * @returns {{goal:object|null, dropped:object[], stats:object}}
 */
export function extractGoal(siis, { query = "", topic = null } = {}) {
  const content = scrubUrls(siis?.content || "");
  if (!content.trim()) return { goal: null, dropped: [], stats: { reason: "no_siis_context" } };

  const { sections: secs, preamble } = sections(content);
  const dropped = [];
  const actions = [];

  for (const sec of secs) {
    const steps = stepsFrom(sec.body);

    if (!steps.length) {
      dropped.push({ heading: sec.heading, reason: "no imperative steps in section" });
      continue;
    }

    const category = classify(steps, sec.heading);
    const groups = groupSteps(steps);

    actions.push({
      actionName: buildActionName(sec.heading),
      description: buildDescription(benefitFor(sec.heading, sec.body)),
      category,
      stepGroups: groups.map(g => ({ steps: g, validationDeeplink: null, actionableDeeplink: null })),
      _source: { heading: sec.heading, stepCount: steps.length }
    });
  }

  if (!actions.length) {
    return { goal: null, dropped, stats: { reason: "no_actionable_steps", sections: secs.length } };
  }

  // §2 sequencing: least disruptive first, irreversible last. The sort is
  // stable, so the reference text's own order survives inside each category.
  actions.sort((a, b) => CATEGORY_ORDER[a.category] - CATEGORY_ORDER[b.category]);

  // Some reference articles are titled generically ("Some things to check
  // first"). That names the article, not the user's problem, so the complaint
  // itself becomes the title instead.
  const generic = /^(some things|things to check|before you (?:begin|start)|overview|introduction|getting started)/i;
  const refTitle = siis?.title || "";
  const titleSource = (!refTitle || generic.test(refTitle)) ? (query || refTitle) : refTitle;
  const topicText = topic || titleSource;

  return {
    goal: {
      goal: buildGoal(topicFrom(topicText)),
      title: buildTitle(titleSource),
      score: 0,                       // set by the pipeline from retrieval confidence
      actions
    },
    dropped,
    stats: { sections: secs.length, actions: actions.length, preambleChars: preamble.length }
  };
}

/**
 * Compress a long reference title into the <Topic> that goes inside the goal
 * sentence: "Blank or black display on a smartphone or tablet" -> "Blank Black
 * Display".
 */
export function topicFrom(text) {
  const cut = String(text || "")
    .replace(/\bon (?:a |your )?(?:smartphone|phone|tablet|device)s?\b.*$/i, "")
    .replace(/\bfor (?:a |your )?(?:smartphone|phone|tablet|device)s?\b.*$/i, "")
    .replace(/[(){}\[\]]/g, " ")
    .trim();

  // The topic goes inside the goal sentence, so it has to name the problem, not
  // the hardware. When a reference article is generically titled the complaint
  // becomes the source, and a complaint carries the device: "Follow these steps
  // to perform this Nexa Fold X1 Troubleshooting" names the phone and says
  // nothing about what is wrong with it. Brand and model words come out here
  // for the same reason buildTitle already drops them.
  const BRAND = /^(?:techcorp|nexa|samsung|galaxy|fold|flip|ultra|plus|pro|lite|tab|tablet|smartphone|phone|device|mobile)$/i;

  const words = cut.split(/\s+/)
    .map(w => w.replace(/[^A-Za-z0-9'-]/g, ""))
    .filter(w => w &&
      !STOPWORDS.has(w.toLowerCase().replace(/['’]/g, "")) &&
      !BRAND.test(w) &&
      !MODEL_CODE.test(w));

  return words.slice(0, 3).join(" ") || "Device";
}
