const MATCH_VALUE = { yes: 1, partial: 0.5, no: 0 };
const SENIORITY_VALUE = { match: 1, over: 0.6, under: 0.35, unclear: 0.7 };
const LOCATION_VALUE = { ok: 1, unclear: 0.6, blocked: 0 };
const DOMAIN_VALUE = { strong: 1, some: 0.6, none: 0.2 };

const WEIGHTS = {
  mustHave: 40,
  experience: 20,
  seniority: 10,
  location: 10,
  domain: 10,
  niceToHave: 10,
};

const BLOCKED_CAP = 15;

function requirementScore(items, valueWhenEmpty) {
  if (!items.length) return { value: valueWhenEmpty, detail: 'None listed' };
  const yes = items.filter((r) => r.match === 'yes').length;
  const partial = items.filter((r) => r.match === 'partial').length;
  const value = items.reduce((sum, r) => sum + (MATCH_VALUE[r.match] ?? 0), 0) / items.length;
  return { value, detail: `${yes}/${items.length} matched${partial ? `, ${partial} partial` : ''}` };
}

function experienceScore(required, have) {
  const yrs = (n) => `${n} yr${n === 1 ? '' : 's'}`;
  if (required == null) return { value: 0.85, detail: `Not stated (you: ${yrs(have)})` };
  if (required <= 0 || have >= required) return { value: 1, detail: `Needs ${yrs(required)}, you have ${yrs(have)}` };
  const value = have >= required - 1 ? 0.7 : Math.max(0, (have / required) * 0.6);
  return { value, detail: `Needs ${yrs(required)}, you have ${yrs(have)}` };
}

export function computeScore(details, a) {
  const parts = [
    { key: 'mustHave', label: 'Must-have skills', ...requirementScore(a.mustHave, 0.7) },
    { key: 'experience', label: 'Experience', ...experienceScore(details.yearsRequired, a.candidateYears) },
    { key: 'seniority', label: 'Seniority', value: SENIORITY_VALUE[a.seniorityFit] ?? 0.7, detail: a.seniorityFit },
    { key: 'location', label: 'Location / eligibility', value: LOCATION_VALUE[a.locationFit] ?? 0.6, detail: a.locationFit },
    { key: 'domain', label: 'Domain', value: DOMAIN_VALUE[a.domainFit] ?? 0.6, detail: a.domainFit },
    { key: 'niceToHave', label: 'Nice-to-haves', ...requirementScore(a.niceToHave, 0.7) },
  ].map((p) => ({ ...p, weight: WEIGHTS[p.key] }));

  let score = Math.round(parts.reduce((sum, p) => sum + p.weight * p.value, 0));
  if (a.locationFit === 'blocked') score = Math.min(score, BLOCKED_CAP);
  return { score, breakdown: parts };
}

export function fitsFromAnalysis(analysis) {
  const detail = (key) => analysis?.breakdown?.find((b) => b.key === key)?.detail;
  return {
    candidateYears: analysis?.candidateYears ?? 0,
    seniorityFit: detail('seniority') || 'unclear',
    locationFit: detail('location') || 'unclear',
    domainFit: detail('domain') || 'none',
  };
}
