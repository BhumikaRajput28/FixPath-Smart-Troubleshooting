# FixPath — Samsung PRISM Generative AI Hackathon 2026–27

FixPath is Team Noir's Smart Guided Troubleshooting Engine for the Samsung PRISM Generative AI Hackathon (Theme ID-02).

> From “Something is wrong” to “Here’s what to do next.”

## What it does

FixPath turns informal Galaxy device complaints into structured troubleshooting plans using:

- Natural-language query normalization and deterministic query variations
- Hybrid retrieval with BM25 + dense similarity signals
- Rule-based extraction from reference troubleshooting articles
- Verified screen-level deeplinks selected only from the supplied catalog
- Safety-first action sequencing
- Schema/rule validation
- Semantic caching for fast repeated or paraphrased queries
- Text and voice complaint input in the web UI

The prototype demo scenario is a Samsung phone with a blank/black screen.

## Team

**Team Noir — SRM Institute of Science and Technology, Kattankulathur**

- Bhumika Rajput
- Divyanshi Shishodia
- Hardik Upadhayay

## Requirements

- Node.js 18+
- No external API keys required
- Local prototype data is included in this repository

## Run locally

```bash
node server/index.js
```

Then open the local URL printed by the server.

Windows users can also run `start-windows.bat`.

## Verification

```bash
npm test
npm run build:cache
npm run batch
npm run validate
npm run bench
npm run metrics
npm run verify
```

## API

```text
GET /health
POST /v1/troubleshoot
```

## Demo

The demo focuses on the **Blank / Black Screen Resolution** flow:

**Home → Diagnose → Follow Steps → Guided Actions → Resolution**

### Demo video

_Add the final YouTube or Google Drive demo URL here._

## Repository structure

- `server/` — HTTP server, cache and metrics
- `engine/` — query pipeline, extraction and retrieval
- `shared/` — response contract and query variations
- `public/` — FixPath web interface
- `data/` — reference responses, deeplinks, cache seed and benchmarks
- `scripts/` — test, validation, batch, cache, benchmark and metrics scripts
- `schema.py` — schema reference
- `start-windows.bat` — Windows launcher

## Hackathon final tag

The required final tag is:

```text
PRISM_GENAI_HACKATHON_Y2026
```

Create it only after the final submission commit contains the complete prototype, README, presentation and every artifact referenced by the submission.

```bash
git tag PRISM_GENAI_HACKATHON_Y2026
git push origin PRISM_GENAI_HACKATHON_Y2026
```

## Presentation

The submission presentation covers the problem statement, existing-solution gap, architecture, demo walkthrough, technology stack, impact/use cases, evaluation targets, limitations, future goals and differentiation.

---

**Team Noir | FixPath | Samsung PRISM Generative AI Hackathon 2026–27**