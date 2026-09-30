# Smart Guided Troubleshooting Engine

Turns a customer's plain-language complaint into a structured, ordered
troubleshooting plan: a **Goal**, a list of categorised **Actions**, **step
groups** of single UI interactions, and **deeplinks** copied verbatim from the
supplied catalog.

Node 18+, **zero npm dependencies**, one command to run.

```bash
node server/index.js          # or: npm start
```

Then open <http://127.0.0.1:8080>.

---

## The pipeline

```
complaint
   │
   ├─[0] Query Enrichment ........ canonical technical query + 8–10 paraphrases
   │                               shared/variations.js
   ├─[3] Fast-Path Cache ......... checked BEFORE any extraction work
   │                               server/cache.js
   ├─[1] Structure Extraction .... reference article → Goal / Actions / steps
   │                               engine/extract.js
   ├─[2] Deeplink Mapping ........ step groups → exact catalog URIs, ordered
   │                               engine/retrieval.js
   └─[4] Validation .............. schema + §4.1 rules, before anything ships
                                   shared/contract.js
```

`engine/pipeline.js` orchestrates all five. Everything is deterministic: the
same complaint and article produce byte-identical output, which is what lets the
pre-warmed cache be trusted and the evaluation be repeated.

---

## API

### `POST /v1/troubleshoot`

```json
{ "query": "my screen went completely black", "siis_response": { "title": "...", "content": "..." } }
```

`siis_response` is optional. Without it the engine answers from the cache, and if
nothing matches it returns an empty `contexts` with `fallback: "no_siis_context"`
rather than inventing steps.

```json
{
  "query": "my screen went completely black",
  "query_variations": ["…", "…"],
  "response": {
    "contexts": [{
      "goal": "Follow these steps to perform this Blank Black Display Troubleshooting",
      "title": "Blank black display",
      "score": 0.42,
      "actions": [{
        "actionName": "Check for Physical Damage and Liquid",
        "description": "It will check physical damage liquid",
        "category": "manual",
        "stepGroups": [{
          "steps": ["Remove any cases or accessories…"],
          "actionableDeeplink": null,
          "validationDeeplink": null
        }]
      }]
    }]
  },
  "meta": { "latency_ms": 2.7, "cache_hit": false, "model": "rules", "cost_usd": 0 }
}
```

### `GET /health`

`{"status":"ok"}` once the catalog index and cache are loaded, `503` before that.

Everything else is namespaced under `/api/` and exists only for the console UI,
so it can never be mistaken for the graded contract.

---

## Verification

```bash
npm run verify
```

runs, in order:

| command | what it does |
| :-- | :-- |
| `npm test` | 41 regression tests — every one guards a bug that actually occurred |
| `npm run build:cache` | pre-warms the fast path from all 20 reference rows |
| `npm run batch` | writes `results.jsonl`, including one unseen paraphrase per query |
| `npm run validate` | gates schema, §4.1 rules, URL leaks, catalog validity — exits 1 on failure |
| `npm run bench` | latency percentiles per execution path → `data/bench.json` |
| `npm run metrics` | the Appendix C evaluation report → `metrics.md` |

Current results are in **`metrics.md`**. Summary:

| Metric | Target | Measured |
| :-- | :-- | :-- |
| Schema-valid output lines | ≥ 99% | 100% |
| Rule compliance (Goal / Title / Description) | ≥ 95% | 100% |
| Absolute URL leaks | 0 | 0 |
| Deeplink catalog validity | 100% | 100% |
| Semantic cache hit rate | ≥ 80% | 100% |
| Auto actions carrying an actionable deeplink | ≥ 90% | **34.5%** |

The last row is the one honest gap, and it is a catalog coverage limit rather
than a resolution failure — see below.

---

## Design decisions worth knowing

**Steps are never invented.** Every step is a sentence that appeared in the
supplied reference article, cleaned and split to one interaction each. If an
article has no usable instruction the engine returns an empty plan with a
reason. This is §4.2.3, and it is enforced in code rather than asked for in a
prompt.

**Deeplink URIs are copied, never constructed.** `engine/retrieval.js` only ever
*chooses* a catalog entry; the URI, its description, message and validation
block are copied across whole. `scripts/validate.js` independently re-checks
every emitted URI against the catalog, and the test suite asserts it too.

**Three honest outcomes, not two.** A step group resolves to an exact catalog
screen, or to the catalog's own generic placeholder when the steps genuinely land
on a Settings screen, or to no deeplink at all. Forcing a link where the catalog
has none would break the 100% validity row above.

**Why the auto-link rate is 34.5%.** The supplied catalog is a Settings-toggle
catalog. Several reference articles walk through in-app flows — Smart View, Data
Transfer, App Pair, camera modes — that have no entry in it, verified by direct
search. Separately, the catalog holds both an *Enable* and a *Disable* entry for
most features; when an article explains how to use a feature rather than telling
the user to change it, no direction is stated, and the engine declines rather
than guessing, because guessing would silently flip a user's setting. Directed
steps ("tap the switch next to Touch sensitivity **to disable it**") do resolve.

**Ordering is a safety property.** Actions are sorted least-disruptive-first and
irreversible-last, stably, so the article's own order survives inside each
category. A regression test covers the wording of every reset variant, because a
gap there once classified *Factory Data Reset* as `auto` and ordered it first.

**Rules are enforced programmatically.** Word counts, the `It will` prefix, the
goal sentence pattern, title length — all built and checked in
`shared/contract.js` (§7.5), then re-checked by an independent validator.

**No model in the request path.** Extraction and mapping are deterministic, so
inference cost is $0.00 and latency is ~2 ms cold / ~0.1 ms warm. The trade is
that resolution quality depends on the catalog rather than on a model's world
knowledge. `meta.cost_usd` and `meta.model` carry the contract fields an optional
model layer would populate.

---

## Layout

```
server/index.js        HTTP service: /v1/troubleshoot, /health, static UI
server/cache.js        three-level semantic cache (exact / variation / fuzzy)
server/metrics.js      percentile and counter store

engine/pipeline.js     phases 0–4 end to end
engine/extract.js      article → Goal, Actions, categories, step groups
engine/retrieval.js    BM25 + dense hybrid, acceptance gates, polarity

shared/contract.js     the schema contract and §4.1 rules, in one place
shared/variations.js   canonical key + deterministic paraphrase generation

public/                the console UI (vanilla, no build step)
scripts/               test, build-cache, run-batch, validate, bench, metrics
data/                  supplied catalog + reference rows, generated cache seed
schema.py              the original Pydantic contract, kept for cross-checking
```

## Note on the supplied `sample_output.json`

It breaks its own rule: two of its `description` values are 9 and 13 words
against the documented 5–7. Appendix B complies. This engine enforces the
documented rule, so its descriptions are shorter than that sample's.
