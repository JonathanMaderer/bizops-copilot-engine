# Dashboard Resolver — Rules, Taxonomy and Remediation

Summary of the ticket-resolver / SDR lead-investigation logic already in the repo. Sources are cited per section.

## 0. What exists

| Layer | Where | Nature |
| --- | --- | --- |
| Deterministic "lead missing" diagnosis | `src/lib/resolver/missingLead.ts` | Rule engine (ordered gates) |
| Board visibility rules | `src/lib/teams/boardTables.ts`, `docs/resolver/team-lists.md` (generated from `src/lib/teams/inventory.ts`) | Data model |
| HubSpot list filter evaluator | `src/lib/resolver/listFilters.ts` | Pure evaluator (pass/fail/unknown) |
| LLM investigation ("The Resolver") | `src/lib/resolver/prompt.ts`, `skills.ts`, `tools.ts` | Heuristics in prompt and skills, read-only tools |
| Brain troubleshooting chain | `src/lib/resolver/knowledge/the-brain.md` (mirror: `docs/the-brain-architecture-and-troubleshooting-context.md`) | 7-step decision chain |
| Dashboard lead trail | `src/lib/resolver/trail.ts` | Events, claims, snapshots, list mirror |
| Ownership claims (pipeline lock) | `src/lib/ownership/claims.ts`, `app/api/lead-ownerships/route.ts` | Atomic lock with TTL |
| Workflow-alert intake | `src/lib/resolver/alerts/*`, `app/api/webhook/resolver-alert/route.ts` | Alert → investigation → Slack |
| Traffic/SLA alerts | `server.js` (~L6340), `docs/no-new-leads-triage-routing.md` | `no_leads_60m`, `no_call_30m` |
| Auto SDR status | `docs/auto-status-qa.md` | `sl_stage` derivation rules |

The resolver is **read-only**: it never writes to HubSpot. Fixes are instructions for a human. No static list of complaint reasons exists as an enum. The taxonomy below is derived from the gates, the Brain chain and alert types.

## 1. Root-cause categories

### A. "Lead missing from board" (deterministic gates)

`diagnoseMissingLead(contactId, teamKey, table, sdrId)` for tables `open_pipe`, `pending_demos`, `no_shows`. Gates run in the order the board applies them. The **first failing decisive gate is the answer**.

| # | Gate id | Root cause |
| --- | --- | --- |
| 1 | `contact` | Contact deleted or merged in HubSpot |
| 2 | `hubspot_list` | Contact not in the table's HubSpot list (fails list filter conditions) |
| 3 | `dashboard_sync` | In HubSpot list but dashboard has not synced it yet (sync lag) |
| 4 | `owner` | Owner property is empty ("wrong SDR" or "no SDR") or belongs to someone else |
| 5 | `dashboard_owner` | Dashboard snapshot owner is stale vs HubSpot |
| 6 | `roster` | SDR not on the team roster (matters only for roster-scoped tables) |
| 7 | `board_filters` (info) | Board-side filter hides it (e.g. "Needs a call only") |
| 8 | `history` (info) | What the dashboard recorded: events and claim |

### B. "Wrong team / wrong SDR / not assigned" (Brain routing)

From the Brain doc §20–21. Categories: classification error, sub-classification error, region/size branch, assignment webhook, fallback owner logic, existing SDR ownership. Alert type example: `lead_not_assigned`.

### C. "Lead disqualified / dropped unexpectedly" (Brain classification and cycle state)

- `ai_sdr_classification` ∈ `qualified_new_lead`, `active_sdr_process_prioritize`, `unqualified`.
- `ai_sdr_sub_classification` ∈ `start_cycle`, `continue_cycle`, `unqualified`.
- Cycle outcomes: Extended, Won, Lost (terminal vs non-terminal, Brain §12–14).
- Cycle closure: `cycle_end_time` known means the lead leaves the SDR list.

### D. Ownership conflicts and pipeline locks (`lead_claims`)

- Take returns **409** when a claim is held by another rep or another team (global key `contact_id`).
- Claim TTL is **2 h** (`CLAIM_TTL_MS`). Expiry unlocks the claim only. It does not return the lead to Incoming.
- HubSpot read-check after the claim is a backstop for ownership set outside the dashboard.

### E. Incoming / event-contract problems

From `docs/incoming-event-contract.md`. Webhook refusals return HTTP 200 with `stored:false` and a `reason`:

| Reason | Meaning |
| --- | --- |
| `missing team_key` | Payload has no team key |
| `unknown team_key` | Not in `src/lib/teams/registry.ts` |
| `not a contact team` | Company key sent to a contact webhook |
| `not a company team` | Contact key sent to a company webhook |

Refused events are not stored and are never remapped. The event tables have a **7-day retention**, so absence older than that proves nothing.

### F. Traffic and SLA alerts

| Alert | Condition | Dedupe |
| --- | --- | --- |
| `no_leads_60m` | Zero arrivals on the team's incoming list in the past 60 min, inside the regional shift window (Mon–Fri) | Re-fires hourly, escalates 60→120→180, resets on any arrival or shift open |
| `no_call_30m` | A taken lead is ≥30 min past arrival with no logged HubSpot call | Once per lead ever, and only if `sl_stage` is still actionable (not unqualified, qualified or completed) |

`no_leads_60m` is routed to `#sdr-no-new-leads-triage`. OpenClaw runs a HubSpot legitimacy test and escalates only real failures. The server does no escalation.

### G. Auto-status (`sl_stage`) surprises

`docs/auto-status-qa.md`: cadence → status (`main`→Working, intent→Low/Has/High Intent, `no-show`→No Show, `demo`→none). Qualified, Completed and Unqualified are protected from `main` and intent cadences. `no-show` may override Qualified. Last action wins between manual changes and cadence changes. Writes are gated by `AUTO_STATUS_DRY_RUN` and `AUTO_STATUS_ENABLED_TEAMS`.

### H. Alert-intake / tooling failures

Malformed workflow-alert payloads (`no_contact_id`, `invalid_contact_id`, `no_alert_type`, `invalid_alert_type`, `no_alert_text`, `placeholder_alert_text`, `unknown_team_key`, `invalid_skill_id`). These return 200 with the reason. Alerts are posted raw, without the LLM, when `disabled`, `daily_limit` (default 200 per 24 h), `llm_not_configured` or `skill_unavailable`.

## 2. Logic conditions checked per category

### A. Missing-lead gates

Shared board rule: a row shows for an SDR when **contact is in the table's list AND the table's owner property = SDR's HubSpot owner id**. Contact boards use `sdr_owner`. XDR uses `exp__xdr_manager`. Region is never a row filter.

1. **`contact`**: `getContact` returns not_found → fail. Other read errors → unknown. A merged contact passes with a note.
2. **`hubspot_list`**: the contact is in the table's list or in `alsoListIds`. If not, the list's `filterBranch` is evaluated against live properties, and each failing condition is reported with the actual value ("empty" or the value). List read errors → unknown.
3. **`dashboard_sync`**:
   - Table not mirrored → unknown.
   - HubSpot in-list and no present row in `list_memberships` → fail, with the last `sync_state` success for scope `contacts:<region>`.
   - Dashboard still lists it after HubSpot removal → info (clears on the next sync).
4. **`owner`**:
   - Owner property empty → fail. For Open Pipe this means the lead is Incoming, not Open Pipe.
   - Owner ≠ SDR → fail, and it shows on the other SDR's board.
   - Owner = SDR → pass.
   - No SDR given → info only.
5. **`dashboard_owner`**:
   - No snapshot and in-list → fail.
   - Live owner ≠ snapshot owner → fail if live owner is the SDR, else info.
   - Otherwise pass.
6. **`roster`** (`team_memberships`):
   - SDR not on the team and table `rosterScoped` → fail.
   - Not scoped → info.
   - On roster but inactive in HubSpot (`owners_snapshot.active=false`) → info.
7. **`board_filters`** (always info):
   - `needsCallTimezone`: "Needs a call only" hides rows whose cadence is outside day 1 to its last day, already called today, or on a weekend.
   - Pending Demos date filter on `first_demo_start_time` is optional and off by default.
   - 201+ multi-thread stakeholder contacts (list 77491) show under their thread.
   - Team-specific `notes`.

**Verdict logic** (`verdictOf`): any decisive gate fail → `hidden`. Else any unknown → `inconclusive`. Else `should_be_visible`.

Scope guards: the team must be a contact team (company/XDR teams are refused). The table must exist for the team.

**Table → list map** (from `docs/resolver/team-lists.md`):

| Table | Typical list |
| --- | --- |
| Open Pipe | 60989 (shared); 66817 for 201+ |
| Pending Demos | 62429 |
| No-Shows & Cancellations | 61704 |

Teams: `sales_na_11_50` (FR and Trial), `sales_na_51_200`, `sales_na_201_plus`, `sales_apac_201_plus`, and others. See the generated doc for the full map.

**List filter evaluator** (`listFilters.ts`): supports `IS_KNOWN`, `IS_UNKNOWN`, `IS_EQUAL_TO`, `IS_NOT_EQUAL_TO` and similar property operators. It returns `unknown` for events, associations, other-list references and relative dates. AND/OR branches resolve only when the known children decide them.

### B. Routing and Brain troubleshooting chain (order matters)

1. **Why did it enter?** Raw timestamps: `trial__finish_signup_date`, `sdr__qbd_indicator`, `sdr_general_replied_tiemstamp`, `sdr_social_qualified_lead_timestamp`, `sdr_no_show_qualification_lead_timestamp`, `sdr_qualified_size_changed_timestamp`.
2. **Selected source**: `ai_sdr_entry_source`, `ai_sdr_source_reason`, `ai_sdr_source_base_score`, `ai_sdr_source_strength`. Was the most recent or correct signal chosen?
3. **LLM decision**: `ai_sdr_classification`, `ai_sdr_priority`, `ai_sdr_score`, `ai_sdr_confidence`, `raw_ai_response`.
4. **Sub-classification**: `ai_sdr_sub_classification` ∈ start_cycle / continue_cycle / unqualified.
5. **Cycle timestamps**: `ai_sdr_cycle_start_time`, `ai_sdr_cycle_end_time`, `ai_sdr_cycle_outcome`, `ai_sdr_cycle_count`.
   - Did `start_cycle` reset the start?
   - Did `continue_cycle` preserve it?
   - Was the end cleared on reactivation?
   - Was the end written only for Won/Lost?
6. **Expected in SDR list?** Active when `cycle_start_time` is known and `cycle_end_time` is empty, plus the correct SDR/team owner and the other list filters. If the cycle is active but the lead is invisible, suspect list criteria or ownership, not the Brain.
7. **Routing, inspected separately**: region, company size, team, existing owner, webhook execution, assignment wait, fallback branch. A wrong owner does not imply wrong cycle logic. Do not change AI logic for a routing bug.

**Investigation rules** (system prompt):
- Property history is the timeline, ordered by timestamp.
- Attributing a write to a workflow is **Inferred**, because HubSpot does not name the workflow. Match property, value and timestamp to the workflow's actions.
- Enrollment history is unavailable. Only current enrollments are visible.
- The dashboard keeps 7 days of events.
- Max tool rounds per answer. Stop once evidence supports a conclusion.
- Trust the data over the admin's description, and point out the disagreement.
- Known routing example: a region branch drops a lead because a country is missing from the APAC countries list, so `region` stays empty and no SDR is assigned.
- Brain limitation: cycle state lives on the contact, so a new cycle overwrites earlier start/end values. Current values are operational state, not history.
- Re-enrollment loop: a contact can re-run the Brain on any new signal, so never assume one pass.

**Change-impact checklist** (10 questions before changing the Brain) covers: property mutated, listeners, re-enrollment, new vs continued cycle, `cycle_end_time` cleared, list membership, `cycle_start_time` reset, `cycle_count`, routing/webhook, and later Brain runs.

### D. Claim / lock logic

- `lead_claims` PK = `contact_id`. A conditional upsert (`ON CONFLICT … WHERE claim is free`) lets exactly one caller win. The others get 409.
- The key is global per contact, not per team. This prevents the same contact being won in two teams. `team_key` is stored for attribution.
- Expiry after 2 h frees the claim. The lead is not re-queued. Queue availability is driven by events per `(contact_id, team_key)`.
- The `history` gate reports the live claim (`owner`, `team`, `claimedAt`, `expiresAt`).

### E. Alert pipeline

- Dedupe: one investigation per `(contactId, alertType)` per **6 h**, serialised on an advisory lock.
- Payload requires `hs_object_id`, `alert_type` (2–60 chars, `[a-z0-9_-]`) and `alert` text. Optional: `team_key`, `skill_id`, name/email. Text is capped at 2000 chars.
- The prompt tells the model to confirm the alert against the data first. If the data contradicts it (lead is assigned after all), the Resolution says so. It must not ask questions.

## 3. Taxonomy of complaint reasons

There is no stored enum. This is the consolidated classification implied by the code and docs.

| Complaint | Mapped root cause | Gate / check |
| --- | --- | --- |
| Lead missing from board | Not in HubSpot list | `hubspot_list` |
| Lead missing from board | Sync lag | `dashboard_sync` |
| Lead missing from board | Stale dashboard owner | `dashboard_owner` |
| Lead missing from board | Board filter on | `board_filters` |
| Lead missing from board | Contact deleted or merged | `contact` |
| Lead missing from board | Cycle ended or Lost | Brain steps 5–6 |
| Wrong SDR assigned | `sdr_owner` is another rep | `owner` |
| Wrong SDR assigned | Routing branch (region, size, team) | Brain step 7 |
| Wrong SDR assigned | Existing owner or fallback | Brain step 7 |
| Wrong SDR assigned | Another rep or team holds the claim | `lead_claims` |
| Not assigned / no SDR | Owner property empty (shows as Incoming) | `owner` |
| Not assigned / no SDR | Assignment webhook or wait failed, or no fallback | Brain step 7 |
| Not assigned / no SDR | Missing region mapping | Brain step 7 |
| Disqualified unexpectedly | Classification `unqualified` | Brain steps 3–4 |
| Disqualified unexpectedly | Cycle outcome Won/Lost sets `cycle_end_time` | Brain step 5 |
| Disqualified unexpectedly | `sl_stage` Unqualified / Qualified / Completed | `docs/auto-status-qa.md` |
| SDR not on team | Roster gap | `roster` |
| Can't take lead (409) | Claim held (2 h TTL) | `lead_claims` |
| No new leads | Upstream traffic or workflow outage | `no_leads_60m` |
| Lead untouched | SLA miss | `no_call_30m` |
| Status changed by itself | Cadence → status derivation | Auto-status rules |
| Lead keeps coming back | Re-enrollment loop | Brain §19 |
| Lead never reached the dashboard | Webhook refused (`team_key`) or older than retention | Event contract |

## 4. Remediation steps surfaced to users

The model is told to give concrete manual steps with the owner of the action: the SDR, the team lead, or a HubSpot/RevOps admin. Preset follow-ups on the built-in skill "Lead missing from dashboard" are *Re-check now*, *Check the other tables*, *Summary for the SDR* and *Who needs to fix it?*.

| Root cause | Remediation | Who |
| --- | --- | --- |
| Contact missing | Find the surviving record via the merge (`mergedFrom`). Re-check the merged id. | Team lead / RevOps |
| Not in HubSpot list | Fix the contact property named in the failing filter condition (shown with its actual value), or fix the list or workflow that feeds it. Open the linked list. | RevOps / HubSpot admin |
| Sync lag | Wait one sync cycle, then run "Re-check now". Hard-refresh the board. | SDR |
| Owner empty | Assign `sdr_owner` (or `exp__xdr_manager`). For Open Pipe, note the lead sits in Incoming until owned. | Team lead |
| Owner is another rep | Reassign in HubSpot, or tell the SDR it is on the other rep's board. | Team lead |
| Stale dashboard owner | The next sync aligns it. Re-check afterwards. | None |
| SDR not on roster | Add them in the dashboard User management. | Team admin |
| Inactive HubSpot owner | Reactivate or reassign. | RevOps |
| Board filter hides it | Turn off "Needs a call only" or the optional demo date filter. Check the selected SDR. | SDR |
| All gates pass | Lead should be visible. Check board filters, selected SDR, and hard refresh. | SDR |
| Routing failure | Open the workflow action where it diverged (region/size branch, webhook, fallback). Fix the mapping, e.g. add a missing country to the region list. | RevOps |
| Wrong classification | Review the Brain's AI classification inputs and `raw_ai_response`. Do not change routing for it. | RevOps |
| Stuck or closed cycle | Verify `cycle_end_time` is cleared on reactivation. Re-enroll via a valid signal. | RevOps |
| Claim conflict (409) | Wait for the 2 h expiry, or have the holder release (`/release`). Check `/api/lead-ownerships`. | Team lead |
| Webhook refused | Fix the workflow payload: send a registered, correct-type `team_key`. Check the HubSpot action log for the `reason`. | RevOps |
| Alert payload invalid | Put the real alert text in the `alert` value, and send `hs_object_id` and `alert_type`. | Workflow author |
| `no_leads_60m` | Triage channel check: HubSpot legitimacy test (OpenClaw). Real failure → escalated to `#sdr-sla-and-traffic-alerts`. Quiet period → no action. | OpenClaw / TL |
| `no_call_30m` | Rep calls the lead. Alert fires once per lead. | SDR |
| Auto-status unexpected | Check `stageAuto` stamp in `sdr_general_cadence_progression`, the dry-run flag, and enabled teams. | Admin |

**Verdict format** (every answer): Resolution (one sentence, ≤~35 words, Slack-pasteable), Next step, Where it went, Where it stopped, Why, Evidence (each bullet marked Observed or Inferred), Confidence (High/Medium/Low), Suggested fix (with downstream impact). Workflows, lists and contacts are linked in HubSpot.

## 5. Gaps worth knowing

- No persisted taxonomy of ticket reasons. The "lead missing" skill is the only deterministic category. All others are LLM-guided by the Brain doc and approved lessons.
- Approved "lessons" live in the DB (`listLessons`) and are not in the repo. They override the docs and could hold more rules.
- Only the `lead-missing-from-dashboard` guided skill is built in (plus the product-admin `free-investigation`). Wrong-SDR, disqualified and unassigned cases rely on free investigation.
- Company/XDR boards are not covered by `diagnoseMissingLead`.
- Event history older than 7 days cannot confirm a webhook was or was not received.
