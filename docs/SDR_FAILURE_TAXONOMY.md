# SDR Failure Taxonomy

_Generated 2026-11-09 by `scripts/test-claw-batch.ts` from 205 historical contacts (URL + raw-number IDs) extracted from SDR tickets. Verdicts reflect the contacts' **current** HubSpot state, not their state when the ticket was filed._

## 1. Volume and distribution

| Failure mode | Contacts | Share |
| --- | ---: | ---: |
| Step 0: Contact Not Found | 3 | 1.5% |
| Step 1: Deal Lock | 9 | 4.4% |
| Step 1.5: Owner Gate (Unassigned SDR) | 47 | 22.9% |
| Step 2: Brain Cycle Ended | 139 | 67.8% |
| Step 3: AI Handover / Unqualified | 4 | 2.0% |
| Step 5: Meeting Validation | 3 | 1.5% |
| **Total** | **205** | **100%** |

## 2. Top drivers

### Step 2: Brain Cycle Ended: 139 contacts (67.8%)

Brain cycle ended (cadence expiry or Won/Lost outcome), which removes the lead from the SDR board regardless of list membership.

Most common ticket themes: Other (54), No-show / meeting handling (29).

Examples:
- `224564459884`: Leads getting held up Thursday night
- `191737204375`: Why where those leads reassigned? from Social to signup
- `238888754338`: Unqualified Contacts in Vantage

### Step 1.5: Owner Gate (Unassigned SDR): 47 contacts (22.9%)

Leads reach the lists with no `sdr_owner` and sit in Incoming instead of Open Pipe.

Most common ticket themes: Lead missing from board/dashboard (13), Deal / pipeline issue (10).

Examples:
- `190811138648`: New pipe dashboard in hubspot not filtering correctly
- `259360715789`: No Show's from AE's not automatically populating in my dashboard
- `235991018326`: Issues with vantage

### Step 1: Deal Lock: 9 contacts (4.4%)

Leads hidden by an active associated deal (the lead is "locked" by a deal that is not Closed Won/Lost).

Most common ticket themes: Other (4), Lead missing from board/dashboard (2).

Examples:
- `650640002`: US Rep scheduled for Israel client
- `249996493717`: Follow-up meetings that are booked on the contact level do not appear on the deal level.
- `214909071708`: FR Reps Not Listed as SDR Manager

### Step 3: AI Handover / Unqualified: 4 contacts (2.0%)

Lead replied to the AI SDR or was classified unqualified; outbound cadences are paused for AE follow-up.

Most common ticket themes: No-show / meeting handling (2), Lead missing from board/dashboard (2).

Examples:
- `242600023735`: Leads both booked and completed are staying in open pipe section
- `239778832549`: No-show stage did not enter the no-show flow
- `245394878835`: HubSpot / Google Calendar / Vantage Not Sync'd

## 3. Recommended RevOps automations

**1. Step 2: Brain Cycle Ended** (139 contacts)
- Show "cycle ended on <date>, outcome <X>" on the dashboard so SDRs know why a lead vanished.
- Notify the SDR 24h before cycle expiry and offer an "extend cycle" action.
- Verify `ai_sdr_cycle_end_time` is cleared on re-activation (start_cycle) and re-enroll on new signals.

**2. Step 1.5: Owner Gate (Unassigned SDR)** (47 contacts)
- Workflow: auto-assign `sdr_owner` by team/round-robin when a lead enters a team list.
- Alert in Slack when a lead has been unowned for > 15 minutes during shift hours.
- Fallback owner branch for unmapped regions/sizes so routing never leaves the owner empty.

**3. Step 1: Deal Lock** (9 contacts)
- Show the blocking deal (ID, stage, owner) directly on the SDR board row.
- Nightly job to flag deals stale in a pre-sales stage > N days and ask the owner to close or advance them.
- Keep `CLOSED_DEAL_STAGES` in sync with HubSpot pipelines (auto-generate from the pipelines API).

**4. Step 3: AI Handover / Unqualified** (4 contacts)
- Create an AE task automatically on first reply.
- Display an "AI handover" badge with the reply timestamp on the board.

**5. Step 0: Contact Not Found** (3 contacts)
- Resolve merged IDs automatically (follow `hs_merged_object_ids`) before opening a ticket.
- Validate contact links in the ticket form.

**6. Step 5: Meeting Validation** (3 contacts)
- Maintain a single allowlist of approved `meeting_type_cp__c` values and drive the lists from it.
- Warn the booker when an unapproved meeting type is chosen.

## 4. Low-confidence and review cases

6 contact(s) scored below 0.8 or returned WARN/ERROR; these indicate gaps in the engine's mappings (unmapped teams, meeting types or deal stages) and should be reviewed with `scripts/investigate.ts`.

- `241708690446` (BLOCKED, conf 0.5): Meeting type is not an SDR-recognized meeting type.
- `247274364565` (BLOCKED, conf 0.5): Meeting type is not an SDR-recognized meeting type.
- `249055549332` (BLOCKED, conf 0.5): Meeting type is not an SDR-recognized meeting type.
- `83144925469` (BLOCKED, conf 0.5): Contact ID does not exist or was deleted in HubSpot.
- `41310877232` (BLOCKED, conf 0.5): Contact ID does not exist or was deleted in HubSpot.
- `19124451386` (BLOCKED, conf 0.5): Contact ID does not exist or was deleted in HubSpot.
