import { APPROVED_MEETING_TYPES, NA_101_PLUS_LARGE_RANGES, TEAM_ALIASES, PROTECTED_SL_STAGES, PROPS, EXCLUDED_EMPLOYEE_RANGE, SIZE_OVERRIDE_LEAD_SOURCE, LIST_IDS } from '../config/schema.ts';
import { fetchListDefinition, findDuplicateContactsByEmail, getContactPropertiesByName, type DuplicateContact, type LeadResult } from './hubspot.ts';
import { collectProperties, evaluateBranch } from './listFilters.ts';

export type StepStatus = 'PASS' | 'BLOCKED' | 'WARN';

export interface StepResult {
  step: number;
  title: string;
  status: StepStatus;
  detail: string;
  propertyKey?: string;
  currentValue?: string | number | null;
  expectedValue?: string;
  remediation?: string;
}

export interface Diagnosis {
  contactId: string;
  steps: StepResult[];
  /** Step that halted the waterfall, if any. */
  blockedAt?: StepResult;
  conclusion: string;
  /** Other contacts sharing this contact's exact email (informational; never changes the verdict). */
  duplicates?: DuplicateContact[];
}

const has = (v: string | null | undefined) => v !== null && v !== undefined && String(v).trim() !== '';

/** Runs the deterministic waterfall, then attaches exact-email duplicates (lookup failures are non-fatal). */
export async function diagnoseContact(input: LeadResult): Promise<Diagnosis> {
  const d = await runWaterfall(input);
  if (!('notFound' in input)) {
    const email = input.properties[PROPS.email];
    if (has(email)) {
      try {
        const dups = await findDuplicateContactsByEmail(String(email), input.resolvedId ?? input.contactId);
        if (dups.length) d.duplicates = dups;
      } catch (e) {
        console.error('Duplicate email check failed:', (e as Error).message);
      }
    }
  }
  return d;
}

async function runWaterfall(input: LeadResult): Promise<Diagnosis> {
  if ('notFound' in input) {
    const step: StepResult = {
      step: 0,
      title: 'Contact Not Found',
      status: 'BLOCKED',
      detail: 'Contact ID does not exist or was deleted in HubSpot.',
      propertyKey: 'hs_object_id',
      currentValue: input.contactId,
      expectedValue: 'an existing contact',
      remediation: 'Verify the ID, or find the surviving record via merge history.',
    };
    return { contactId: input.contactId, steps: [step], blockedAt: step, conclusion: step.detail };
  }
  const lead = input;
  const p = lead.properties;
  const steps: StepResult[] = [];
  const done = (s: StepResult, conclusion: string): Diagnosis | null => {
    steps.push(s);
    return s.status === 'BLOCKED' ? { contactId: lead.contactId, steps, blockedAt: s, conclusion } : null;
  };
  let d: Diagnosis | null;

  // 0. Contact existence / merge guard
  if (lead.guard) {
    const g = lead.guard;
    d = done(
      {
        step: 0,
        title: g.title,
        status: g.status,
        detail: g.detail,
        propertyKey: 'hs_object_id',
        currentValue: lead.resolvedId ?? null,
        expectedValue: 'an existing, primary contact',
        remediation:
          g.status === 'BLOCKED' ? 'Find the surviving record via the merge history, or re-check the ID.' : undefined,
      },
      g.status === 'BLOCKED' ? 'Contact does not exist in HubSpot.' : 'Contact was merged; diagnosed the primary record.',
    );
    if (d) return d;
  }

  // 1. Deal Lock
  d = done(
    lead.activeDeals.length
      ? {
          step: 1,
          title: 'Deal Lock',
          status: 'BLOCKED',
          detail: `Active deal(s): ${lead.activeDeals.map((x) => `${x.id} (${x.dealstage})`).join(', ')}`,
          propertyKey: 'dealstage',
          currentValue: lead.activeDeals.map((x) => x.dealstage).join(', '),
          expectedValue: 'all associated deals in a closed won/lost stage',
          remediation: 'Close or disassociate the active deal(s).',
        }
      : { step: 1, title: 'Deal Lock', status: 'PASS', detail: 'No active associated deals.', propertyKey: 'dealstage', currentValue: null, expectedValue: 'all deals closed' },
    'Lead is locked by an active associated deal.',
  );
  if (d) return d;

  // 1.5 SDR Owner Gate
  const owner = has(p[PROPS.sdrOwner]) ? p[PROPS.sdrOwner] : has(p[PROPS.xdrManager]) ? p[PROPS.xdrManager] : null;
  d = done(
    owner
      ? {
          step: 1.5,
          title: 'Owner Gate',
          status: 'PASS',
          detail: `Assigned to owner ${owner}.`,
          propertyKey: PROPS.sdrOwner,
          currentValue: owner,
          expectedValue: 'a non-empty owner id',
        }
      : {
          step: 1.5,
          title: 'Owner Gate: Unassigned SDR',
          status: 'BLOCKED',
          detail: 'Contact has no SDR owner assigned. It sits in Incoming queue, not Open Pipe.',
          propertyKey: PROPS.sdrOwner,
          currentValue: null,
          expectedValue: 'a non-empty owner id',
          remediation: 'Assign an SDR Owner in HubSpot to route to an active board.',
        },
    'Lead has no SDR owner (Incoming queue, not Open Pipe).',
  );
  if (d) return d;

  // 2. Brain State
  const started = has(p[PROPS.cycleStart]);
  const ended = has(p[PROPS.cycleEnd]);
  d = done(
    started && !ended
      ? { step: 2, title: 'Brain State', status: 'PASS', detail: `Cycle active since ${p[PROPS.cycleStart]}.`, propertyKey: PROPS.cycleStart, currentValue: p[PROPS.cycleStart] ?? null, expectedValue: 'known, with cycle_end empty' }
      : {
          step: 2,
          title: 'Brain State',
          status: 'BLOCKED',
          detail: `cycle_start=${p[PROPS.cycleStart] ?? 'null'}, cycle_end=${p[PROPS.cycleEnd] ?? 'null'}${started && ended ? `, cycle outcome: ${p[PROPS.cycleOutcome] ? String(p[PROPS.cycleOutcome]) : 'not recorded'}` : ''}`,
          propertyKey: started ? PROPS.cycleEnd : PROPS.cycleStart,
          currentValue: (started ? p[PROPS.cycleEnd] : p[PROPS.cycleStart]) ?? null,
          expectedValue: started ? 'empty (cycle still open)' : 'a start timestamp',
          remediation: started
            ? 'Cycle closed (Won/Lost/Extended/Completed). Verify cycle_end_time is cleared on reactivation via a valid signal.'
            : undefined,
        },
    started
      ? 'Cycle has ended; lead is not an Active Lead in the Brain.'
      : 'Brain never started a cycle for this lead (not an Active Lead).',
  );
  if (d) return d;

  // 3. AI Handover & Unqualified State
  const replied = has(p[PROPS.firstRepliedAt]);
  const unqSub = p[PROPS.subClassification] === 'unqualified';
  const unqClass = p[PROPS.classification] === 'unqualified';
  const unq = unqSub || unqClass;
  const slStage = p[PROPS.slStage];
  const protectedStage = has(slStage) && PROTECTED_SL_STAGES.some((x) => x.toLowerCase() === String(slStage).trim().toLowerCase());
  const handoverNote = 'AI Handover: Lead replied or is unqualified: outbound cadences are paused for AE follow-up.';
  d = done(
    replied || unq
      ? {
          step: 3,
          title: 'AI Handover',
          status: 'BLOCKED',
          detail: replied
            ? `ai_sdr__first_replied_at=${p[PROPS.firstRepliedAt]}`
            : `Flagged unqualified: ${[unqClass ? "ai_sdr_classification='unqualified'" : '', unqSub ? "ai_sdr_sub_classification='unqualified'" : ''].filter(Boolean).join(', ')}`,
          propertyKey: replied ? PROPS.firstRepliedAt : unqClass ? PROPS.classification : PROPS.subClassification,
          currentValue: replied
            ? (p[PROPS.firstRepliedAt] ?? null)
            : ((unqClass ? p[PROPS.classification] : p[PROPS.subClassification]) ?? null),
          expectedValue: replied ? 'empty' : "not 'unqualified'",
          remediation: handoverNote,
        }
      : protectedStage
        ? {
            step: 3,
            title: 'AI Handover',
            status: 'WARN',
            detail: `Protected status: sl_stage='${slStage}' (Unqualified/Qualified/Completed are protected from automation).`,
            propertyKey: PROPS.slStage,
            currentValue: slStage ?? null,
            expectedValue: 'not Unqualified / Qualified / Completed',
            remediation: 'Check whether the sl_stage was set manually or by a cadence; protected stages explain "disqualified unexpectedly".',
          }
        : {
            step: 3,
            title: 'AI Handover',
            status: 'PASS',
            detail: 'No AI reply, not unqualified, no protected sl_stage.',
            propertyKey: PROPS.firstRepliedAt,
            currentValue: p[PROPS.firstRepliedAt] ?? null,
            expectedValue: 'empty',
          },
    handoverNote,
  );
  if (d) return d;

  // 4. Filter Hygiene
  const isSmall = p[PROPS.numEmployeesRange] === EXCLUDED_EMPLOYEE_RANGE;
  const falseSbp = isSmall && p[PROPS.sdrLeadSource] === SIZE_OVERRIDE_LEAD_SOURCE;
  const smallCo = isSmall && !falseSbp;
  const reasonMissing = has(p[PROPS.unqualifiedReasonText]) && !has(p[PROPS.newUnqualifiedReason]);
  d = done(
    smallCo || reasonMissing
      ? {
          step: 4,
          title: 'Filter Hygiene',
          status: 'BLOCKED',
          detail: [
            smallCo ? `numofemployeesrange=${EXCLUDED_EMPLOYEE_RANGE}` : '',
            reasonMissing ? 'unqualified_reason___text_ set but new_unqualified_reason dropdown empty' : '',
          ]
            .filter(Boolean)
            .join('; '),
          propertyKey: smallCo ? PROPS.numEmployeesRange : PROPS.newUnqualifiedReason,
          currentValue: (smallCo ? p[PROPS.numEmployeesRange] : p[PROPS.newUnqualifiedReason]) ?? null,
          expectedValue: smallCo ? `not '${EXCLUDED_EMPLOYEE_RANGE}' (or lead source '${SIZE_OVERRIDE_LEAD_SOURCE}')` : 'dropdown filled',
          remediation: smallCo ? 'Lead is below the SDR size threshold.' : 'Fill the new_unqualified_reason dropdown.',
        }
      : {
          step: 4,
          title: 'Filter Hygiene',
          status: 'PASS',
          detail: falseSbp
            ? `Company size 1-10 allowed due to '${SIZE_OVERRIDE_LEAD_SOURCE}' lead source override.`
            : 'Employee range and unqualified reason OK.',
          propertyKey: PROPS.numEmployeesRange,
          currentValue: p[PROPS.numEmployeesRange] ?? null,
          expectedValue: `not '${EXCLUDED_EMPLOYEE_RANGE}' (or lead source '${SIZE_OVERRIDE_LEAD_SOURCE}')`,
        },
    'Lead is filtered out by hygiene rules.',
  );
  if (d) return d;

  // 5. Meeting Validation (only if a meeting type is set)
  const mt = p[PROPS.meetingType];
  if (has(mt)) {
    const allowlisted = APPROVED_MEETING_TYPES.some((t) => t.toLowerCase() === String(mt).trim().toLowerCase());
    const inApprovedList = LIST_IDS.meetingTypeLists.some((id) => lead.listIds.includes(id));
    const approved = allowlisted || inApprovedList;
    d = done(
      approved
        ? { step: 5, title: 'Meeting Validation', status: 'PASS', detail: allowlisted ? `meeting_type_cp__c="${mt}" is an APPROVED SDR meeting type.` : `meeting_type_cp__c="${mt}" is in an approved meeting-type list.`, propertyKey: PROPS.meetingType, currentValue: mt ?? null, expectedValue: 'an approved SDR meeting type' }
        : {
            step: 5,
            title: 'Meeting Validation',
            status: 'BLOCKED',
            detail: `meeting_type_cp__c="${mt}" which is not in the approved SDR meeting types (${APPROVED_MEETING_TYPES.join(', ')}) and the contact is in none of the approved lists (${LIST_IDS.meetingTypeLists.join(', ')}).`,
            propertyKey: PROPS.meetingType,
            currentValue: mt ?? null,
            expectedValue: 'an approved SDR meeting type',
            remediation: 'Update meeting type on the contact to an approved SDR type.',
          },
      'Meeting type is not an SDR-recognized meeting type.',
    );
    if (d) return d;
  } else {
    steps.push({ step: 5, title: 'Meeting Validation', status: 'PASS', detail: 'No meeting type set; skipped.', propertyKey: PROPS.meetingType, currentValue: null, expectedValue: 'optional' });
  }

  // 6. List vs UI Diff
  const teams = LIST_IDS.teams as Record<string, Record<string, string>>;
  const availableKeys = Object.keys(teams);
  const rawTeam = p[PROPS.sdrTeam];
  const rawRange = p[PROPS.numEmployeesRange];
  if (!has(rawTeam)) {
    const summary = 'Routing Blocker: Contact has no SDR Team assigned (sdr__sdr_team_ is blank).';
    steps.push({
      step: 6,
      title: 'List vs UI Diff',
      status: 'WARN',
      detail: summary,
      propertyKey: PROPS.sdrTeam,
      currentValue: null,
      expectedValue: 'a non-empty SDR team',
      remediation: 'Assign an SDR Team value in HubSpot to enable queue routing.',
    });
    return { contactId: lead.contactId, steps, conclusion: summary };
  }
  const resolved = resolveTeamKey(rawTeam, rawRange, availableKeys);
  const teamLists = resolved.key ? teams[resolved.key] : undefined;

  if (!resolved.key || !teamLists) {
    steps.push({
      step: 6,
      title: 'List vs UI Diff',
      status: 'WARN',
      detail: `${PROPS.sdrTeam}=${has(rawTeam) ? `"${rawTeam}"` : 'blank'}, ${PROPS.numEmployeesRange}=${has(rawRange) ? `"${rawRange}"` : 'blank'}. Tried: ${resolved.tried.join(', ') || '(none)'}. Available team keys: ${availableKeys.join(', ')}.`,
    });
    return {
      contactId: lead.contactId,
      steps,
      conclusion: 'Cannot verify board list membership: team could not be resolved to a LIST_IDS.teams key.',
    };
  }

  const boardId = teamLists.openPipe ?? teamLists.incoming ?? teamLists.primary;
  if (!boardId) {
    steps.push({
      step: 6,
      title: 'List vs UI Diff',
      status: 'WARN',
      detail: `Resolved team key "${resolved.key}" (${resolved.how}) has no board list. Its list keys: ${Object.keys(teamLists).join(', ')}.`,
      propertyKey: PROPS.sdrTeam,
      currentValue: rawTeam ?? null,
      expectedValue: 'a team with a board list',
    });
    return { contactId: lead.contactId, steps, conclusion: 'Resolved team has no board list configured.' };
  }

  const inList = lead.listIds.includes(boardId);
  const tableHits: string[] = [];
  if (!inList) {
    const pend = [teamLists.pendingDemos, LIST_IDS.tables.PENDING_DEMOS].filter(Boolean) as string[];
    const nos = [teamLists.noShows, LIST_IDS.tables.NO_SHOWS].filter(Boolean) as string[];
    const pendHit = pend.find((id) => lead.listIds.includes(id));
    const noHit = nos.find((id) => lead.listIds.includes(id));
    if (pendHit) tableHits.push(`Pending Demos (${pendHit})`);
    if (noHit) tableHits.push(`No-Shows (${noHit})`);
    if (lead.listIds.includes(LIST_IDS.tables.MULTI_THREAD_201_PLUS)) {
      tableHits.push(`Multi-Thread 201+ (${LIST_IDS.tables.MULTI_THREAD_201_PLUS})`);
    }
  }

  if (inList) {
    steps.push({
      step: 6,
      title: 'List vs UI Diff',
      status: 'PASS',
      detail: `Resolved team key "${resolved.key}" (${resolved.how}); checked board list ${boardId}: member.`,
      propertyKey: 'listMembership',
      currentValue: boardId,
      expectedValue: `member of list ${boardId}`,
    });
    return {
      contactId: lead.contactId,
      steps,
      conclusion: 'All checks pass and contact is in the board list: dashboard cache delay.',
    };
  }

  if (tableHits.length) {
    const names = tableHits.join(', ');
    steps.push({
      step: 6,
      title: 'List vs UI Diff',
      status: 'PASS',
      detail: `Team "${resolved.key}" Open Pipe list ${boardId}: not a member. Contact is active on board under ${names} queue.`,
      propertyKey: 'listMembership',
      currentValue: names,
      expectedValue: `member of Open Pipe ${boardId} or another board table`,
    });
    return { contactId: lead.contactId, steps, conclusion: `Contact is active on board under ${names} queue.` };
  }

  // In none of the team's lists: introspect the Open Pipe list's filter criteria.
  let mismatchDetail = '';
  let mismatches: string[] = [];
  try {
    const def = await fetchListDefinition(boardId);
    if (def.filterBranch) {
      const names = [...collectProperties(def.filterBranch)];
      const live = names.length ? await getContactPropertiesByName(lead.resolvedId ?? lead.contactId, names) : {};
      const ev = evaluateBranch(def.filterBranch, { ...p, ...live });
      mismatches = ev.mismatches;
      mismatchDetail =
        ev.result === 'fail'
          ? ev.mismatches.join('; ')
          : ev.result === 'pass'
            ? 'Contact meets all list filter conditions (membership likely not yet refreshed).'
            : 'List filters could not be fully evaluated (unsupported filter types).';
    } else {
      mismatchDetail = `List ${boardId} has no filterBranch (static or manual list).`;
    }
  } catch (e) {
    mismatchDetail = `Could not read list definition: ${(e as Error).message.slice(0, 120)}`;
  }
  steps.push({
    step: 6,
    title: 'List vs UI Diff',
    status: 'WARN',
    detail: `Team "${resolved.key}" (${resolved.how}); in none of the team's lists (Open Pipe ${boardId}). ${mismatchDetail}`,
    propertyKey: 'listMembership',
    currentValue: null,
    expectedValue: `member of list ${boardId}`,
    remediation: mismatches.length
      ? 'Fix the contact property named in the failing filter condition, or fix the list/workflow that feeds it.'
      : 'Check list enrollment criteria / wait for list refresh.',
  });
  return {
    contactId: lead.contactId,
    steps,
    conclusion: mismatches.length
      ? `Not in Open Pipe: ${mismatches.join('; ')}`
      : 'All checks pass but contact is not in the board list: list membership/enrollment issue.',
  };
}

const slug = (s: string) => s.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');

function regionCode(s: string): string | null {
  if (/north[\s_-]*america|\bna\b|\busa?\b|\bcanada\b/i.test(s)) return 'na';
  if (/emea|europe|\bemea\b|middle[\s_-]*east|africa/i.test(s)) return 'emea';
  if (/apac|asia|pacific|australia/i.test(s)) return 'apac';
  return null;
}

/** Maps an employee range ("11-50", "201-500", "1001+") or a plain count to a tier suffix. */
function sizeTier(range: string | null | undefined): string | null {
  if (!has(range)) return null;
  const m = String(range).replace(/,/g, '').match(/\d+/);
  if (!m) return null;
  const lo = Number(m[0]);
  if (lo <= 10) return '1_10';
  if (lo <= 50) return '11_50';
  if (lo <= 200) return '51_200';
  return '201_plus';
}

function resolveTeamKey(
  team: string | null | undefined,
  range: string | null | undefined,
  keys: string[],
): { key: string | null; how: string; tried: string[] } {
  const tried: string[] = [];
  if (!has(team)) return { key: null, how: 'blank team', tried };
  const t = String(team);
  const direct = slug(t);
  tried.push(direct);
  if (keys.includes(direct)) return { key: direct, how: 'direct match', tried };

  // "North America 101+" / "NA 101+": 201+ team for large ranges, otherwise 51-200.
  if (/^(north[\s_-]*america|na)\s*101\s*\+?$/i.test(t.trim())) {
    const large = (NA_101_PLUS_LARGE_RANGES as readonly string[]).includes(String(range ?? '').trim());
    const key = large ? 'sales_na_201_plus' : 'sales_na_51_200';
    tried.push(key);
    if (keys.includes(key)) return { key, how: `"${t}" + range ${has(range) ? range : 'blank'} -> ${key}`, tried };
  }

  const alias = TEAM_ALIASES[direct];
  if (alias) {
    tried.push(alias);
    if (keys.includes(alias)) return { key: alias, how: `alias "${t}"`, tried };
    const at = sizeTier(range);
    const comp = at ? `${alias}_${at}` : null;
    if (comp) tried.push(comp);
    if (comp && keys.includes(comp)) return { key: comp, how: `alias "${t}" + size tier ${at}`, tried };
  }

  const type = /social/i.test(t) ? 'social' : /sales/i.test(t) ? 'sales' : null;
  const region = regionCode(t);
  if (!type || !region) return { key: null, how: 'unrecognized team', tried };

  const tier = sizeTier(range);
  if (tier) {
    const composite = `${type}_${region}_${tier}`;
    tried.push(composite);
    if (keys.includes(composite)) return { key: composite, how: `umbrella "${t}" + size tier ${tier}`, tried };
  }
  const regional = `${type}_${region}`;
  tried.push(regional);
  if (keys.includes(regional)) return { key: regional, how: `umbrella "${t}" (regional key)`, tried };

  return { key: null, how: 'no composite match', tried };
}
