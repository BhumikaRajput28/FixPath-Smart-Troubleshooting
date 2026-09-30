# System Performance Metrics & Evaluation Report

**Model(s):** none — deterministic rules engine (no provider/model in the resolution path)
**Embeddings:** hashed character n-gram vectors, computed in-process (no external embedding model)
**Environment:** 2 vCPU / 8 GB RAM / Linux 6.18.44-fc-v37 / Node v22.22.2

Generated 2026-09-27T14:04:38.040Z from `results.jsonl` (40 records, of which 20 unseen paraphrases) and `data/bench.json`.

---

## 1. Schema & Rule Compliance
Evaluated on sample datasets and held-out validation scenarios.

| Metric | Target | Measured Value |
| :--- | :--- | :--- |
| Schema-valid output lines | >= 99% | 100% |
| Rule compliance (Goal / Title / Description syntax) | >= 95% | 100% |
| Absolute URL leaks | 0 | 0 |
| Deeplink catalog validity (exact URI match) | 100% | 100% |
| Auto actions carrying valid actionable deeplink | >= 90% | 34.5% |

**Below target.** 20 of 58 auto actions carry an actionable deeplink.
The shortfall is a catalog coverage gap, not a resolution failure: the supplied
catalog contains no entry for the in-app destinations several reference articles
describe (§6 below lists them). Emitting a link anyway would break the 100%
catalog-validity row above, so the engine reports no deeplink instead.

---

## 2. Accuracy Benchmarks
Evaluated against reference ground truth scenarios across Battery, Display, Camera, and Performance.

| Evaluation Metric | Scale / Anchor | Score |
| :--- | :--- | :--- |
| Step accuracy (completeness, correctness, ordering) | 0.0 - 3.0 | 3.00 |
| Deeplink relevance (exact target screen vs. parent menu) | 0.0 - 2.0 | 0.38 |

Both figures are **automated proxies against a stated rubric**, not human ratings.
Step accuracy adds one point each for group completeness, step cleanliness, and
correct category ordering. Deeplink relevance scores 2 for an exact catalog
screen, 1 for the catalog's generic placeholder where the steps genuinely open
Settings, and 0 where an auto action got no link; manual actions are excluded
because §4.1 forbids them a deeplink.

---

## 3. Latency Benchmarks (N >= 30 requests per path)

| Execution Path | Target (P95) | P50 (ms) | P95 (ms) |
| :--- | :--- | :--- | :--- |
| Cache hit - exact query match | <= 300 ms | 0.09 | 0.15 |
| Cache hit - unseen semantic paraphrase | <= 360 ms | 0.04 | 0.09 |
| Cold query - full pipeline extraction & mapping | <= 8000 ms | 2.04 | 9.28 |

N = 200 per path. Cold start (catalog load and index build over
578 entries): 42.304 ms.

These numbers are far inside target because no network call or model inference
sits in the request path — the cost of the design choice is that resolution
quality depends on the catalog rather than on a model's world knowledge.

---

## 4. Operational Cost & Cache Efficacy

| Metric Item | Target | Measured Value |
| :--- | :--- | :--- |
| Cold query average inference cost | Tracked | $0.00 |
| Cache hit inference cost | $0.00 | $0.00 |
| Semantic cache hit rate (on unseen paraphrases) | >= 80% | 100% |
| Cost derivation method | - | (prompt tokens + completion tokens) x rate |

Inference cost is $0.00 on both paths because extraction and mapping are
deterministic and run locally; no tokens are purchased. The cost derivation
method is carried in `meta.cost_usd` and would populate from the token counts
if an optional model layer were enabled.

Cache behaviour over this run: 0 exact hits, 20/20 unseen
paraphrases served from the fast path.

---

## 5. Architectural Ablation Analysis

| Architecture Variant | Step Accuracy | Latency (P95) | Cost / Query | Key Observations |
| :--- | :--- | :--- | :--- | :--- |
| Baseline: Full LLM Deeplink Mapping | not run | not run | not run | No model in this build; a number here would be invented. Recorded as unmeasured. |
| Variant A: Hybrid BM25 + Dense Embedding Retrieval | 0.38 / 2.0 | 8.73 | $0.00 | 4 exact screens, 9 placeholder, 32 no link. Dense similarity gates out near-miss siblings. |
| Variant B: Pure Rules-Based Deeplink Mapping | 0.38 / 2.0 | 9.64 | $0.00 | 4 exact screens, 9 placeholder, 32 no link. BM25 only, dense gate bypassed. |

The step-accuracy column reports deeplink relevance (0–2), since the extraction
stage is shared by both variants and only resolution differs between them.

On this corpus both variants resolve the same screens: where an exact match
exists the catalog wording is close enough that BM25 alone finds it. The dense
component earns its place on the negative cases — it supplies the independent
signal that lets a near-miss sibling be rejected rather than accepted — so the
variants differ in what they *refuse*, not in what they find.

---

## 6. Known Edge Cases & System Limitations

* **Catalog domain gaps.** The supplied catalog is a Settings-toggle catalog. Reference articles that walk through in-app flows — Smart View, Data Transfer, App Pair, camera modes such as Super steady — have no corresponding entry, verified by direct search. Those groups ship with no actionable deeplink rather than a wrong one, which is the main reason the auto-action link rate sits below the 90% target.
* **Toggle direction without evidence.** The catalog holds both an Enable and a Disable entry for most features. When an article teaches a feature rather than instructing a change, no direction is stated, and the engine declines the link rather than guessing — guessing would silently flip a user setting. Directed steps ("tap the switch ... to disable it") do resolve.
* **Multi-intent complaints.** A single complaint naming two unrelated faults is answered from one reference article, so the second intent is not separately planned. The contract's `contexts` array is a list, so the shape supports multiple goals; the selection logic to populate it is not implemented.
* **Settings hierarchy variations.** Menu paths differ across One UI versions and device classes. The engine matches on the catalog entry's own message rather than on a hard-coded path, which absorbs some variation, but a renamed leaf screen would fall back to the placeholder.
* **Reference text is authoritative.** Steps are only ever copied from the supplied article (§4.2.3). Where an article is thin, the plan is thin; the engine will not fill the gap from general knowledge.
* **Corpus pairing.** Several supplied rows pair a complaint with an article on a different subject (row_1 is a blank-screen complaint against an email-server article). The engine grounds on the reference text as instructed, so the plan follows the article, not the complaint.
