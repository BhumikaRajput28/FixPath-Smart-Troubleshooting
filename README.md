# FixPath — Smart Guided Troubleshooting Engine

**Samsung PRISM Generative AI Hackathon 3rd Edition 2026–27 · Theme ID-02 · Team Noir**  
**SRM Institute of Science and Technology, Kattankulathur**

> From “Something is wrong” to “Here’s what to do next.”

FixPath transforms informal Samsung/Galaxy device complaints into structured, validated and actionable troubleshooting plans. The prototype combines natural-language query enrichment, hybrid retrieval, reference-grounded extraction, verified screen-level deeplinks, safety-first action sequencing, validation and semantic caching.

## Team

- Bhumika Rajput
- Divyanshi Shishodia
- Hardik Upadhayay

## Prototype

The complete working prototype is in [`sgte/`](./sgte/).

### Requirements

- **Node.js 18 or newer**
- No API keys required
- No `npm install` required — the prototype has zero npm dependencies

The root `package.json` provides convenience commands that delegate to the prototype in `sgte/`.

## Run the prototype

### Windows

Double-click [`start-windows.bat`](./start-windows.bat), or run:

```bat
cd sgte
node server\index.js
```

### macOS / Linux

```bash
cd sgte
node server/index.js
```

Then open the local URL printed by the server, normally:

```text
http://127.0.0.1:8080
```

No internet connection or external model API is required for the local prototype.

## Verify the implementation

From the repository root:

```bash
npm test
npm run verify
```

The verification chain runs the regression suite, rebuilds the semantic cache, evaluates the supplied queries plus paraphrases, validates outputs against the contract/rules, benchmarks latency and regenerates the metrics report.

The latest local verification completed successfully with **41 regression tests passing** and **100% schema/rule-valid records**. The evaluation also reports 100% semantic-cache hit rate for the tested unseen paraphrases and 0 URL leaks. The measured actionable-deeplink coverage remains 34.5%, which the prototype documents as a catalog-coverage limitation rather than fabricating unsupported links.

## Demo scenario

The presentation/demo focuses on the **Blank / Black Screen Resolution** scenario:

**Home → Diagnose → Follow Steps → Guided Actions → Resolution**

Example complaint:

> “My Samsung phone screen is completely black.”

The prototype demonstrates issue understanding, structured troubleshooting actions, verified deeplinks, safe sequencing and resolution/next-step guidance.

## Demo video

**Demo video link:** https://www.loom.com/share/5e2b100b25c84ef5b3cf4b1214adb016

The hackathon instructions allow a YouTube/Google Drive link when the video is too large to store directly in GitHub.

## Presentation

The final presentation is included in the repository:

[`SRMIST_TeamNoir_Submission.pptx`](./SRMIST_TeamNoir_Submission.pptx)

It covers the problem statement, existing-solution gap, architecture, demo walkthrough, technology stack, impact/use cases, evaluation, limitations, future goals and differentiation.

## Architecture

```text
User text / voice
       ↓
Query Understanding
       ↓
Reference Retrieval
       ↓
Troubleshooting Planning
       ↓
Schema + Deeplink Validation
       ↓
Guided Step-by-Step Actions
```

Core implementation areas:

- `sgte/server/` — HTTP server, cache and metrics
- `sgte/engine/` — extraction, retrieval and pipeline orchestration
- `sgte/shared/` — output contract and query variations
- `sgte/public/` — browser prototype UI
- `sgte/data/` — reference data, deeplink catalog, cache seed and benchmarks
- `sgte/scripts/` — tests, validation, benchmarking, cache building and metrics
- `sgte/schema.py` — Python/Pydantic contract cross-check

## Key design points

- **Grounded troubleshooting:** steps are extracted from supplied reference material rather than invented.
- **Verified deeplinks:** URLs are selected from the supplied catalog rather than constructed.
- **Safety-first ordering:** less disruptive actions are ordered before critical/irreversible actions.
- **Deterministic request path:** the prototype does not require external LLM inference for request processing.
- **Semantic caching:** exact and paraphrased complaints can reuse validated plans.
- **Validation:** outputs are checked against the response contract and catalog constraints before being returned.

## Current limitations

- Deeplink coverage depends on the supplied catalog.
- Complex multi-intent complaints are not fully supported.
- Settings hierarchies can vary by device model and software version.
- Troubleshooting quality depends on the underlying reference documentation.

## Hackathon final tag

The required final Git tag is exactly:

```text
PRISM_GENAI_HACKATHON_Y2026
```

Create the tag **only after the final commit contains all required submission artifacts**, including the complete prototype, README, presentation and the final demo reference.

## Submission repository

https://github.com/BhumikaRajput28/FixPath-Smart-Troubleshooting

---

**Team Noir · FixPath · Samsung PRISM Generative AI Hackathon 2026–27**
