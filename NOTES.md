# SDR Copilot Engine: Resume Notes

## Setup after restart
1. Node via nvm (`nvm use --lts`), `npm install`.
2. Restore secrets (NOT in git): `.env.local` (HubSpot token, GCP vars) and `gcp-key.json` (Vertex AI service account).
3. `npm run dev` -> http://localhost:5173 (chat UI + API). `npm test` -> golden benchmark (needs live HubSpot).

## Architecture
- `src/engine/` deterministic waterfall (Steps 0, 1, 1.5, 2, 3, 4, 5, 6), confidence scoring, dossier.
- `src/ai/copilot.ts` Gemini (Vertex, `@google/genai`) with deterministic fallback.
- `src/api/` `diagnoseLead` (+ clarification flow), feedback to `data/corrections.jsonl`.
- `web/` Vite + React + Tailwind v4 ChatGPT-style UI (`DESIGN.md` is the spec).
- `scripts/` test-lead, test-batch, find-case-studies, investigate (`--ai`), eval-benchmark, claw ingest.
- `docs/` failure taxonomy, dashboard resolver rules.

## Known gaps
- Golden benchmark only covers Steps 1, 1.5, 2, 3.
- Step 6 filter-mismatch output only tested with synthetic data; Step 5/6 clarification questions never run on a live contact.
- Chat UI not yet verified in a browser.
- Gemini Slack draft may include the contact's email.
- `scripts/test-batch.ts` still has placeholder fallback IDs.

## Next steps
- Browser-test the chat UI end to end.
- Extend benchmark to Steps 4-6.
- Fix email leak in Slack draft.
