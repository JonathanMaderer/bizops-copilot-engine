import type { ContactProps } from './hubspot.ts';

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface FilterEval {
  result: 'pass' | 'fail' | 'unknown';
  /** Human-readable failing conditions (only populated when result is 'fail'). */
  mismatches: string[];
}

const isEmpty = (v: unknown) => v === null || v === undefined || String(v).trim() === '';

/** Collects every PROPERTY filter's property name in a filterBranch. */
export function collectProperties(branch: any, out = new Set<string>()): Set<string> {
  for (const f of branch?.filters ?? []) if (f.filterType === 'PROPERTY' && f.property) out.add(f.property);
  for (const b of branch?.filterBranches ?? []) collectProperties(b, out);
  return out;
}

function evalFilter(f: any, props: ContactProps): { result: 'pass' | 'fail' | 'unknown'; msg: string } {
  if (f.filterType !== 'PROPERTY') return { result: 'unknown', msg: `unsupported filter type ${f.filterType}` };
  const prop: string = f.property;
  const op = f.operation ?? {};
  const operator: string = op.operator;
  const actual = props[prop];
  const found = isEmpty(actual) ? 'empty' : String(actual);
  const expectedList: string[] = (op.values ?? (op.value !== undefined ? [op.value] : [])).map(String);
  const expectedStr = expectedList.join(' | ');
  const eq = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
  const fail = (expected: string) => ({
    result: 'fail' as const,
    msg: `Filter mismatch on property '${prop}': expected ${expected}, found ${found}`,
  });
  const ok = { result: 'pass' as const, msg: '' };

  switch (operator) {
    case 'IS_KNOWN':
      return isEmpty(actual) ? fail('a known value') : ok;
    case 'IS_UNKNOWN':
      return isEmpty(actual) ? ok : fail('empty');
    case 'IS_EQUAL_TO':
    case 'IS_ANY_OF': {
      if (isEmpty(actual)) return fail(expectedStr);
      return expectedList.some((e) => eq(String(actual), e)) ? ok : fail(expectedStr);
    }
    case 'IS_NOT_EQUAL_TO':
    case 'IS_NONE_OF': {
      if (isEmpty(actual)) return op.includeObjectsWithNoValueSet === false ? fail(`not ${expectedStr}`) : ok;
      return expectedList.some((e) => eq(String(actual), e)) ? fail(`not ${expectedStr}`) : ok;
    }
    case 'CONTAINS':
      return !isEmpty(actual) && expectedList.some((e) => String(actual).toLowerCase().includes(e.toLowerCase()))
        ? ok
        : fail(`contains ${expectedStr}`);
    case 'DOES_NOT_CONTAIN':
      return isEmpty(actual) || !expectedList.some((e) => String(actual).toLowerCase().includes(e.toLowerCase()))
        ? ok
        : fail(`not containing ${expectedStr}`);
    default:
      return { result: 'unknown', msg: `unsupported operator ${operator} on '${prop}'` };
  }
}

/**
 * Evaluates a HubSpot list filterBranch against live contact properties.
 * AND branches fail on any failing child; OR branches pass on any passing child. When an OR
 * fails, the mismatches of the closest branch (fewest failures) are reported.
 */
export function evaluateBranch(branch: any, props: ContactProps): FilterEval {
  if (!branch) return { result: 'unknown', mismatches: [] };
  const type: string = branch.filterBranchType ?? 'AND';
  const children: FilterEval[] = [];
  for (const f of branch.filters ?? []) {
    const r = evalFilter(f, props);
    children.push({ result: r.result, mismatches: r.result === 'fail' ? [r.msg] : [] });
  }
  for (const b of branch.filterBranches ?? []) children.push(evaluateBranch(b, props));
  if (!children.length) return { result: 'pass', mismatches: [] };

  if (type === 'OR') {
    if (children.some((c) => c.result === 'pass')) return { result: 'pass', mismatches: [] };
    if (children.some((c) => c.result === 'unknown')) return { result: 'unknown', mismatches: [] };
    const closest = children.reduce((a, b) => (b.mismatches.length < a.mismatches.length ? b : a));
    return { result: 'fail', mismatches: closest.mismatches };
  }
  // AND (also covers ASSOCIATED/UNIFIED_EVENTS wrapper types: treated as AND of children)
  const fails = children.filter((c) => c.result === 'fail');
  if (fails.length) return { result: 'fail', mismatches: fails.flatMap((c) => c.mismatches) };
  if (children.some((c) => c.result === 'unknown')) return { result: 'unknown', mismatches: [] };
  return { result: 'pass', mismatches: [] };
}
