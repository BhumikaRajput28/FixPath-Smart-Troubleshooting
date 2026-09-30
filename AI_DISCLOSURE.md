# AI Disclosure

## Project

**FixPath — Smart Guided Troubleshooting Engine**

FixPath was developed for the Samsung PRISM Generative AI Hackathon 2026–27.

## Use of AI / Generative AI

Generative AI tools were used by the team as development assistance during the project, including support for:
- brainstorming and refining troubleshooting flows;
- code suggestions and debugging;
- documentation and README refinement;
- presentation and demo-content refinement.

All AI-assisted suggestions were reviewed and adapted by the team before being included in the submission.

## Runtime Implementation

The submitted prototype is intentionally deterministic for reproducibility. Its request-processing pipeline uses query enrichment, semantic-cache retrieval, rule-based structure extraction, deeplink mapping, and validation. The prototype does **not** make an external LLM inference call during request processing.

The project therefore does not claim an AI capability that is not present in the submitted runtime code.

## Human Responsibility

The team is responsible for the final architecture, implementation, testing, validation, project materials, and submission. AI-assisted output was treated as development support rather than as an autonomous source of final decisions.

## Transparency

This disclosure is provided to clearly distinguish AI-assisted development from the components actually implemented and executed by the submitted prototype.
