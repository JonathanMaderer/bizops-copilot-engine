# SDR RevOps Copilot — Conversational UI Specification (ChatGPT Style)

## 1. Aesthetic & Principles
- **Layout:** ChatGPT-style layout with a collapsible left sidebar and a centered, clean conversational stream.
- **Palette:** Dark/Neutral minimalist theme (`bg-zinc-900` sidebar, `bg-zinc-950` chat canvas, `border-zinc-800`).
- **Typography:** Inter or system sans-serif. Monospace tags for IDs and CRM properties.

## 2. Core Layout Elements
### A. Collapsible Left Sidebar (History & Sessions)
- **Top:** `[+ New Investigation]` button.
- **Session List:** Chronological list of previously diagnosed contacts (Name, Team badge, Failure Step).
- **Bottom:** Engine Status indicator (`Deterministic Engine v1.0 • Gemini 2.5 Flash Connected`).

### B. Chat Stream Canvas
- Centered container (`max-w-3xl`) with smooth scrolling.
- **Empty State:** Clean prompt screen with quick action chips:
  - *"Missing from Open Pipe"*
  - *"Check Unassigned Incoming"*
  - *"Investigate Cadence Expiration"*

### C. Message Formats
- **User Message Bubble:**
  - Displays user text, auto-highlights extracted HubSpot URLs or Contact IDs.
- **Copilot Message Card:**
  - **Verdict Header:** Status pill (`[BLOCKED: Step 1 Deal Lock]` / `[PASS]`) with Confidence indicator (`1.0 Definitive`, `0.8 Heuristic`).
  - **SDR Plain-English Explanation:** 2 sentences directly addressing the rep.
  - **Slack Message Block:** Styled snippet box with 1-click `[📋 Copy]` button.
  - **Clarification Chips (Conditional):** If `confidence < 1.0`, render inline clickable buttons for quick response.
  - **Expandable "RevOps Inspector" Accordion:**
    - Visual 6-step waterfall status checklist (`[PASS]`, `[BLOCKED]`, `[WARN]`).
    - Property Diff table (`Property` | `Current CRM Value` | `Target Value`).
    - Direct hyperlink to the HubSpot contact record.
  - **Feedback Controls:** `[👍]` and `[👎]` buttons. Clicking `👎` slides open a 1-line note field saving to `data/corrections.jsonl`.

### D. Bottom Prompt Bar
- Pinned to bottom, floating centered input.
- Textarea supporting `Enter` to submit, auto-extracting 11+ digit HubSpot Contact IDs or full URLs from any pasted text.