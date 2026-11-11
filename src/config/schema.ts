export const PROPS = {
  entrySource: 'ai_sdr_entry_source',
  classification: 'ai_sdr_classification',
  subClassification: 'ai_sdr_sub_classification',
  cycleStart: 'ai_sdr_cycle_start_time',
  cycleEnd: 'ai_sdr_cycle_end_time',
  cycleOutcome: 'ai_sdr_cycle_outcome',
  trialFinishSignup: 'trial__finish_signup_date',
  qbdIndicator: 'sdr__qbd_indicator',
  generalRepliedTimestamp: 'sdr_general_replied_tiemstamp',
  socialQualifiedTimestamp: 'sdr_social_qualified_lead_timestamp',
  meetingType: 'meeting_type_cp__c',
  slStage: 'sl_stage',
  numEmployeesRange: 'numofemployeesrange',
  newUnqualifiedReason: 'new_unqualified_reason',
  unqualifiedReasonText: 'unqualified_reason___text_',
  firstRepliedAt: 'ai_sdr__first_replied_at',
  sdrTeam: 'sdr__sdr_team_',
  sdrLeadSource: 'sdr__lead_source_',
  sdrOwner: 'sdr_owner',
  xdrManager: 'exp__xdr_manager',
  mergedIds: 'hs_merged_object_ids',
  country: 'country',
} as const;

export const CONTACT_PROPERTIES: string[] = Object.values(PROPS);

export const SUB_CLASSIFICATIONS = ['start_cycle', 'continue_cycle', 'unqualified'] as const;

/** Deal stages treated as closed (won or lost): legacy names plus stage IDs from all deal pipelines. */
export const CLOSED_DEAL_STAGES = new Set<string>([
  'closedwon',
  'closedlost',
  '23995941', // Closed won 51-200 (HubSpot "Closed Won")
  '23995942', // Closed lost 51-200
  '85248606', '85248607',
  '196624992', '196624993',
  '68188087', '68188088',
  '47430440', '47430441',
  '66718887', '66718888',
  '125067306', '125067307', '125060870',
  '7860318', '7860319',
  '86362685', '53086477', '53086478', '665101',
  '1281188015', '1040446809', '147877807',
  '132675872', '132675875', '132675876', '132675877', '132675878', '132675879',
  '1258285463', '1258285464', '1258285471', '1258245890',
  '1238325599', '1238325600',
  '1300101713', '1300101714', '1300101715',
  '1330607492', '1330607024',
  'd3fa7f6d-deb0-4eb6-a101-3281e696420c',
  '0cc6b690-2676-4f21-9ca9-b52497044a28',
]);

/** Lead source (`[SDR] Lead source*`) that overrides the 1-10 employee-size block. */
export const SIZE_OVERRIDE_LEAD_SOURCE = 'False SBP';

/** Employee range that is filtered out of the SDR flow. */
export const EXCLUDED_EMPLOYEE_RANGE = '1-10';

/** Approved SDR meeting types (`meeting_type_cp__c`), matched case-insensitively. */
export const APPROVED_MEETING_TYPES: string[] = ['SDR_Demo_First_Meeting_30min', 'Sales_Demo_First_Meeting_30min'];

export const KNOWN_LISTS = {
  shared: {
    openPipe: '60989',
    pendingDemos: '62429',
    noShows: '61704',
    myPendingDemos: '50814',
    followUp: '52241',
    demoLegacyNoShows: '52759',
    demosBookedToday: '65013',
    prioritizedLeads: '69406',
    naSecondaryMyProcess: '52499',
    frIncomingHistory: '62941',
    frInProcess: '62935',
    multiThreadMembers: '77491',
    sdrLeadCounts: '52580',
  },
  legacyOpenPipeAliases: ['58569', '53337', '66263'],
  retired: ['61504'],
  teams: {
    sales_na_11_50: { incoming: '52196', secondary: '52499', openPipe: '60989', pendingDemos: '62429', noShows: '61704' },
    sales_na_trial: { incoming: '52196', openPipe: '60989', pendingDemos: '62429', noShows: '61704' },
    sales_na_51_200: { incomingStream: 'sdr-51-200-na', openPipe: '60989', pendingDemos: '62429', noShows: '61704' },
    sales_na_201_plus: { incoming: '66817', openPipe: '66817', pendingDemos: '62429', noShows: '61704', multiThread: '77491' },
    sales_apac_201_plus: { incomingStream: 'sdr-201-apac', openPipe: '60989', pendingDemos: '62429', noShows: '61704' },
    sales_emea: { primary: '54884', secondary: '54885', demo: '52635', openPipe: '60989', pendingDemos: '62429', noShows: '52759' },
    sales_apac: { primary: '52791', incomingEvents: '66207', openPipe: '60989', pendingDemos: '62429', noShows: '52759' },
    social_na_11_50: { incoming: '66955', active: '66955', openPipe: '66955', pendingDemos: '62429', noShows: '61704' },
    social_na_51_200: { incomingStream: 'social-51-200-na', incoming: '66955', active: '66955', openPipe: '66955', pendingDemos: '62429', noShows: '61704' },
    social_emea: { incoming: '64603', openPipe: '64603', pendingDemos: '62429', noShows: '61704' },
    social_apac: { incoming: '66961', openPipe: '66961', pendingDemos: '62429', noShows: '61704' },
    special_projects: { incoming: '69803', legacyDefault: '68371', openPipe: '60989', pendingDemos: '62429', noShows: '61704' },
    adp: { incoming: '68372', openPipe: '68372', pendingDemos: '68564', noShows: '68562' },
    sdr_il: { incoming: '70307', openPipe: '70307', pendingDemos: '71079', noShows: '71616' },
    live_team: { primary: '52415', inProcess: '55085', noShows: '52759' },
    xdr: { openPipe: '45770', liveLeads: '60607', pendingDemos: '63406', noShows: '60608' },
    csdr: { pros: '72786', ob: '72807', mm: '72809', tomorrowMeetings: '72811' },
  },
  tables: {
    PENDING_DEMOS: '62429',
    NO_SHOWS: '61704',
    MULTI_THREAD_201_PLUS: '77491',
  },
  meetingTypeLists: ['62429', '68564', '71079'],
  nonBoardLists: ['62941', '65013', '45770', '68371'],
  admin: { newSignups: '55275', oldLeads: '69842' },
} as const;

export const LIST_IDS = KNOWN_LISTS;
/**
 * Raw `sdr__sdr_team_` labels (slugified) -> LIST_IDS.teams key, or a `{type}_{region}` prefix that is
 * completed with the contact's employee-size tier. Assumption: unprefixed labels are Sales teams.
 */
export const TEAM_ALIASES: Record<string, string> = {
  north_america_11_100_et: 'sales_na',
  north_america_11_100_ct: 'sales_na',
  north_america_11_100_mt: 'sales_na',
  north_america_11_100_pt: 'sales_na',
  emea_11_100: 'sales_emea',
};

/** `sl_stage` values that are protected from automation (compared case-insensitively). */
export const PROTECTED_SL_STAGES = ['Unqualified', 'Qualified', 'Completed'] as const;

/** For the "North America 101+" / "NA 101+" team labels: ranges that map to the 201+ team. */
export const NA_101_PLUS_LARGE_RANGES = ['201-500', '501-1000', '1001-5000', '5001+'] as const;
