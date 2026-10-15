const OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434';
export const MODEL = process.env.MODEL || 'qwen2.5:7b';
const KEEP_ALIVE = process.env.OLLAMA_KEEP_ALIVE || '30m';

const EXTRACT_SCHEMA = {
  type: 'object',
  properties: {
    isJobDescription: { type: 'boolean' },
    company: { type: 'string' },
    role: { type: 'string' },
    location: { type: 'string' },
    workMode: { type: 'string', enum: ['remote', 'hybrid', 'onsite', 'unknown'] },
    salary: { type: 'string' },
    seniority: { type: 'string', enum: ['intern', 'junior', 'mid', 'senior', 'lead', 'manager', 'unknown'] },
    yearsRequired: { type: ['number', 'null'] },
    mustHave: { type: 'array', items: { type: 'string' } },
    niceToHave: { type: 'array', items: { type: 'string' } },
    domain: { type: 'string' },
    summary: { type: 'string' },
    interviewRounds: { type: ['number', 'null'] },
  },
  required: [
    'isJobDescription', 'company', 'role', 'location', 'workMode', 'salary',
    'seniority', 'yearsRequired', 'mustHave', 'niceToHave', 'domain', 'summary', 'interviewRounds',
  ],
};

const MATCH = { type: 'string', enum: ['yes', 'partial', 'no'] };

// Requirements and CV lines are referred to by number, so the model doesn't spend output tokens repeating text the app already has.
const LINE_MATCH = {
  type: 'object',
  properties: { line: { type: 'integer' }, match: MATCH },
  required: ['line', 'match'],
};

const INFERRED_MATCH = {
  type: 'object',
  properties: { requirement: { type: 'string' }, line: { type: 'integer' }, match: MATCH },
  required: ['requirement', 'line', 'match'],
};

const exactly = (n) => ({ minItems: n, maxItems: n });

function assessSchema(mustHaveCount, niceToHaveCount) {
  return {
    type: 'object',
    properties: {
      mustHave: mustHaveCount
        ? { type: 'array', items: LINE_MATCH, ...exactly(mustHaveCount) }
        : { type: 'array', items: INFERRED_MATCH, minItems: 1, maxItems: 6 },
      niceToHave: { type: 'array', items: LINE_MATCH, ...exactly(niceToHaveCount) },
      seniorityFit: { type: 'string', enum: ['under', 'match', 'over', 'unclear'] },
      locationFit: { type: 'string', enum: ['ok', 'unclear', 'blocked'] },
      domainFit: { type: 'string', enum: ['strong', 'some', 'none'] },
      missingKeywords: { type: 'array', items: { type: 'string' }, maxItems: 8 },
      suggestions: { type: 'array', items: { type: 'string' }, maxItems: 3 },
      verdict: { type: 'string' },
    },
    required: [
      'mustHave', 'niceToHave', 'seniorityFit', 'locationFit',
      'domainFit', 'missingKeywords', 'suggestions', 'verdict',
    ],
  };
}

const PROFILE_SCHEMA = {
  type: 'object',
  properties: {
    roles: {
      type: 'array',
      items: {
        type: 'object',
        properties: { title: { type: 'string' }, company: { type: 'string' }, start: { type: 'string' }, end: { type: 'string' } },
        required: ['title', 'company', 'start', 'end'],
      },
    },
  },
  required: ['roles'],
};

const EXTRACT_PROMPT = `You extract structured data from a job posting. Use only information stated in the text.
- Use "" for unknown text fields and null for yearsRequired when no number of years is stated.
- role: the job title. company: the hiring company (not the job board).
- yearsRequired: minimum years of experience required as a number ("5+ years" -> 5, "3-5 years" -> 3), or null if not stated.
- salary: as written, including currency and period, or "".
- mustHave: required skills/qualifications as short phrases (e.g. "React", "AWS", "Bachelor's in CS"), at most 10. Do not include years of experience here.
- niceToHave: preferred/bonus items, at most 8.
- domain: industry or product area in a few words. summary: 1-2 sentences describing the role.
- interviewRounds: number of interview stages if the posting describes its interview process (count each listed stage), otherwise null.
- isJobDescription: false if the text is a login page, error page, list of search results, or anything other than a single job posting.`;

const ASSESS_RULES = `You are a strict recruiter screening the candidate's CV (below) against one job (in the next message). Judge only from evidence in the CV and candidate notes; never assume skills that are not shown.
- mustHave / niceToHave: one entry per listed requirement, in the same order. line = the number of the CV line that best shows it (0 if none), then match:
  "yes" = the CV names this skill/tool/qualification (or an obvious equivalent, e.g. "Postgres" for PostgreSQL) in a job, project, or skills list.
  "partial" = the CV only shows something adjacent (e.g. ECS for Kubernetes, RabbitMQ for Kafka).
  "no" = nothing related in the CV.
- seniorityFit: candidate level versus the role's level.
- locationFit: "blocked" only if the job clearly requires a location or work authorization that the candidate notes say they lack; "unclear" if it can't be determined; otherwise "ok".
- domainFit: experience in the same industry or product area.
- missingKeywords: important skills or tools the job asks for that the CV lacks, as 1-4 word phrases.
- suggestions: 1-3 specific, truthful CV edits that would improve fit for this job, one sentence each. Never suggest inventing experience.
- verdict: one sentence on how likely this CV is to get an interview and why.`;

const PROFILE_PROMPT = `List every job or position in the CV, most recent first. start and end as "YYYY-MM" (end "present" for current roles; use "-01" if only the year is given). Do not include education.`;

const CHROME_LINE = /^(apply|save|join or sign in|email or phone|password|show|forgot password|sign in|sign in with|or|new to linkedin|report this job|see who |\d+\s+(applicants|weeks? ago|days? ago|hours? ago)|join now)$/i;
const DROP_SECTION = /^(perks?|benefits?|why\b|about us|about the company|about \w+$|company overview|life at|our (culture|values|privacy)|privacy|eeo|equal opportunit|anti-discrim|accommodations?|inclusive hiring|safe hiring|what we stand for|values|the extras|a bit about us|the core values|how we use ai|newsroom|referral|relocation|position type|travel requirements?|department overview|aperçu|visit our)/i;
const KEEP_SECTION = /^(about the role|the role|the (winning )?recipe|role overview|role purpose|responsibilit|what you.?ll|what you bring|what we.?re looking|qualif|skills?|requirements?|must-have|nice to have|preferred|bonus|interview|hiring process|location|compensation range|salary|essential|your skills|experience|basic (qualif|requirements)|key responsibilities|required|the opportunity)/i;
const CLUE_LINE = /\b(remote|hybrid|onsite|on-site|visa|sponsor(ship)?|work.?auth|citizen|permanent resident|eligib|salary|compensation|\$\d|€|£|CAD|USD|GBP|\d\+?\s*years?)\b/i;

function isHeading(line) {
  return line.length < 60 && !/[.?!]$/.test(line) && (KEEP_SECTION.test(line) || DROP_SECTION.test(line) || /^[A-Z][\w /&'-]{2,50}$/.test(line));
}

// Drop legal, benefits and site chrome. Keep role, requirements, location, salary and interview process.
export function cleanJd(text) {
  const lines = String(text || '').split('\n').map((l) => l.replace(/\s+/g, ' ').trim());
  const out = [];
  let dropping = false;
  for (const line of lines) {
    if (!line || line === '-') continue;
    if (CHROME_LINE.test(line)) continue;
    if (isHeading(line)) {
      dropping = DROP_SECTION.test(line) && !KEEP_SECTION.test(line);
      if (!dropping) out.push(line);
      continue;
    }
    if (dropping && !CLUE_LINE.test(line)) continue;
    out.push(line);
  }
  const cleaned = out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  return cleaned.length >= 400 ? cleaned : String(text || '').trim();
}

export function trimCv(text) {
  return String(text || '')
    .split('\n')
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .filter((l) => l && !/^(tel|phone|mobile|email|linkedin|github):/i.test(l) && !/^https?:\/\//i.test(l) && !/^[^\s]+@[^\s]+\.[a-z]{2,}$/i.test(l) && !/^\+?\d[\d\s().-]{8,}$/.test(l))
    .join('\n');
}

export function numberedCv(text) {
  const lines = trimCv(text).split('\n').map((l) => l.trim()).filter(Boolean);
  return { lines, numbered: lines.map((l, i) => `${i + 1}. ${l}`).join('\n') };
}

// Streams the response: Node's fetch aborts if response headers take over 5 minutes,
// which a non-streaming request for long output can exceed.
async function chat(system, user, schema, { maxTokens = 2048, label = 'chat' } = {}) {
  let res;
  try {
    res = await fetch(`${OLLAMA_URL}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: MODEL,
        stream: true,
        keep_alive: KEEP_ALIVE,
        format: schema,
        options: { temperature: 0, num_ctx: 8192, num_predict: maxTokens },
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
      }),
    });
  } catch (e) {
    throw new Error(`Could not reach Ollama (${e.cause?.code || e.message}). Make sure the Ollama app is running.`);
  }
  if (!res.ok) throw new Error(`Ollama error ${res.status}: ${await res.text()}`);

  const decoder = new TextDecoder();
  let buffer = '';
  let content = '';
  let final = null;
  for await (const chunk of res.body) {
    buffer += decoder.decode(chunk, { stream: true });
    let newline;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      const msg = JSON.parse(line);
      if (msg.error) throw new Error(`Ollama error: ${msg.error}`);
      content += msg.message?.content || '';
      if (msg.done) final = msg;
    }
  }

  if (final) {
    const secs = (final.total_duration / 1e9).toFixed(0);
    const rate = (final.eval_count / (final.eval_duration / 1e9)).toFixed(1);
    console.log(`[ollama] ${label}: ${final.prompt_eval_count} prompt + ${final.eval_count} output tokens in ${secs}s (${rate} tok/s)`);
  }
  if (final?.done_reason === 'length') throw new Error('The AI response was too long and got cut off. Try again.');
  return JSON.parse(content);
}

function yearsFromText(text) {
  const m = text.match(/(\d{1,2})\s*\+?\s*(?:(?:-|–|to)\s*\d{1,2}\s*)?\+?\s*years?\b[^.\n]{0,60}experience/i);
  return m ? Number(m[1]) : null;
}

function parseMonth(s, now) {
  if (/present|current|now/i.test(s)) return now;
  const m = String(s).match(/(\d{4})(?:-(\d{1,2}))?/);
  return m ? Number(m[1]) * 12 + (Number(m[2] || 1) - 1) : null;
}

// Union of relevant role intervals, so overlapping jobs aren't double-counted.
function relevantYears(roles) {
  const d = new Date();
  const now = d.getFullYear() * 12 + d.getMonth();
  const spans = roles
    .filter((r) => r.relevant)
    .map((r) => [parseMonth(r.start, now), parseMonth(r.end, now)])
    .filter(([s, e]) => s != null && e != null && e >= s)
    .sort((a, b) => a[0] - b[0]);

  let months = 0;
  let [curStart, curEnd] = [null, null];
  for (const [s, e] of spans) {
    if (curEnd != null && s <= curEnd) curEnd = Math.max(curEnd, e);
    else {
      if (curEnd != null) months += curEnd - curStart;
      [curStart, curEnd] = [s, e];
    }
  }
  if (curEnd != null) months += curEnd - curStart;
  return Math.round((months / 12) * 10) / 10;
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function mentions(text, term) {
  const t = term.trim();
  return t.length > 1 && new RegExp(`(^|[^\\w])${escapeRe(t)}($|[^\\w])`, 'i').test(text);
}

// Small models sometimes rate a skill "partial" even when the CV names it outright.
function upgradeIfNamed(req, cvText) {
  const short = req.requirement.trim().split(/\s+/).length <= 4;
  if (req.match === 'yes' || !short || !mentions(cvText, req.requirement)) return req;
  return { ...req, match: 'yes', evidence: req.evidence || 'Named in your CV' };
}

export async function extractDetails(jdText) {
  const cleaned = cleanJd(jdText);
  const d = await chat(EXTRACT_PROMPT, `Job posting:\n\n${cleaned.slice(0, 8000)}`, EXTRACT_SCHEMA, { maxTokens: 700, label: 'extract' });
  return {
    ...d,
    yearsRequired: typeof d.yearsRequired === 'number' ? d.yearsRequired : yearsFromText(jdText),
    interviewRounds: describesInterviewProcess(jdText) && Number.isInteger(d.interviewRounds) && d.interviewRounds > 0 && d.interviewRounds <= 10
      ? d.interviewRounds
      : null,
    mustHave: (d.mustHave || []).slice(0, 10),
    niceToHave: (d.niceToHave || []).slice(0, 8),
  };
}

export async function ensureProfile(cv) {
  const key = `${cv.version}:${(cv.text || '').length}`;
  if (cv.profile?.key === key && cv.profile.roles?.length) return cv.profile.roles;
  const { numbered } = numberedCv(cv.text);
  const { roles } = await chat(PROFILE_PROMPT, numbered.slice(0, 6000), PROFILE_SCHEMA, { maxTokens: 500, label: 'profile' });
  cv.profile = { key, roles: roles || [] };
  return cv.profile.roles;
}

function padItems(items, n) {
  const list = Array.isArray(items) ? items.slice(0, n) : [];
  while (n && list.length < n) list.push({ line: 0, match: 'no' });
  return list;
}

function hydrate(items, names, lines, cvText) {
  return items.map((item, i) => {
    const requirement = (names?.[i] ?? item.requirement ?? '').trim();
    const line = Number(item.line) || 0;
    const evidence = line >= 1 && line <= lines.length ? lines[line - 1] : '';
    const match = ['yes', 'partial', 'no'].includes(item.match) ? item.match : 'no';
    return upgradeIfNamed({ requirement, match, evidence }, cvText);
  }).filter((r) => r.requirement);
}

export async function assessFit(details, jdText, cv) {
  const profile = await ensureProfile(cv);
  const { lines, numbered } = numberedCv(cv.text);
  const must = details.mustHave || [];
  const nice = details.niceToHave || [];
  const cleaned = cleanJd(jdText);
  const clues = cleaned.split('\n').filter((l) => CLUE_LINE.test(l)).slice(0, 24).join('\n');
  const list = (items) => (items.length ? items.map((r, i) => `${i + 1}. ${r}`).join('\n') : '(none listed)');

  const system = `${ASSESS_RULES}

CANDIDATE CV (use these line numbers as evidence):
${numbered.slice(0, 7000)}

CANDIDATE NOTES:
${cv.notes || '(none)'}

CANDIDATE ROLES (already dated; years of experience are counted in code):
${profile.map((r, i) => `${i + 1}. ${r.title}${r.company ? ` at ${r.company}` : ''} (${r.start} – ${r.end})`).join('\n') || '(none)'}`;

  const user = `JOB
Role: ${details.role || 'unknown'}
Company: ${details.company || 'unknown'}
Seniority: ${details.seniority}
Years of experience required: ${details.yearsRequired ?? 'not stated'}
Location / work mode: ${details.location || 'unknown'} / ${details.workMode}
Domain: ${details.domain || 'unknown'}

Must-have requirements:
${must.length ? list(must) : '(none listed — infer up to 6 core requirements from the clues below)'}

Nice-to-have:
${list(nice)}

Location, work-authorization, salary and years clues from the posting:
${clues || '(none)'}
${must.length ? '' : `\nJob text:\n${cleaned.slice(0, 2500)}`}`;

  const a = await chat(system, user, assessSchema(must.length, nice.length), { maxTokens: 700, label: 'score' });
  const cvText = `${cv.text}\n${cv.notes || ''}`;
  const mustHave = hydrate(must.length ? padItems(a.mustHave, must.length) : (a.mustHave || []).slice(0, 6), must.length ? must : null, lines, cvText);
  const niceToHave = hydrate(padItems(a.niceToHave, nice.length), nice, lines, cvText);
  const roles = profile.map((r) => ({ ...r, relevant: true }));
  return {
    mustHave,
    niceToHave,
    roles,
    seniorityFit: a.seniorityFit,
    locationFit: a.locationFit,
    domainFit: a.domainFit,
    candidateYears: relevantYears(roles),
    missingKeywords: (a.missingKeywords || [])
      .filter((k) => !/already|present in/i.test(k) && !mentions(cvText, k))
      .slice(0, 8),
    suggestions: (a.suggestions || []).slice(0, 3),
    verdict: a.verdict || '',
  };
}

const strings = { type: 'array', items: { type: 'string' } };

const PROCESS_SCHEMA = {
  type: 'object',
  properties: {
    stages: {
      type: 'array',
      items: {
        type: 'object',
        properties: { name: { type: 'string' }, format: { type: 'string' }, focus: { type: 'string' }, tips: strings },
        required: ['name', 'format', 'focus', 'tips'],
      },
    },
    nextRoundTips: strings,
  },
  required: ['stages', 'nextRoundTips'],
};

const ANSWERS_SCHEMA = {
  type: 'object',
  properties: {
    likelyQuestions: {
      type: 'array',
      items: {
        type: 'object',
        properties: { question: { type: 'string' }, why: { type: 'string' }, answerHint: { type: 'string' } },
        required: ['question', 'why', 'answerHint'],
      },
    },
    talkingPoints: {
      type: 'array',
      items: {
        type: 'object',
        properties: { requirement: { type: 'string' }, story: { type: 'string' } },
        required: ['requirement', 'story'],
      },
    },
    gaps: {
      type: 'array',
      items: {
        type: 'object',
        properties: { gap: { type: 'string' }, howToAnswer: { type: 'string' } },
        required: ['gap', 'howToAnswer'],
      },
    },
    whyThisRole: { type: 'string' },
    questionsToAsk: strings,
    generalTips: strings,
  },
  required: ['likelyQuestions', 'talkingPoints', 'gaps', 'whyThisRole', 'questionsToAsk', 'generalTips'],
};

const COACH = `You are an experienced interview coach preparing a candidate for interviews for one specific job. Base everything on the job description and the candidate's real CV. Be concrete and specific to this job; avoid generic filler.
Keep it tight: every text field is one short sentence (two at most), and tips are short imperative phrases.`;

const PROCESS_FROM_JD = `- stages: list every interview stage the job description describes, in order. name: short label. format: duration, who, and medium exactly as written. focus: what that stage assesses for this job. tips: 2 tips specific to this job.`;

const PROCESS_TYPICAL = `- The job description does NOT describe its interview process. stages: list the 3-4 stages typical for this kind of role and seniority. name: short label. format: the usual format in general terms (e.g. "Usually a 30-45 minute video call"); never state specific durations, interviewers, or tools as if this company confirmed them. focus: what that stage usually assesses for a role like this. tips: 2 tips specific to this job.`;

const processPrompt = (fromJd) => `${COACH}
- stages: only actual interview stages, never sections like tips or questions.
${fromJd ? PROCESS_FROM_JD : PROCESS_TYPICAL}
- nextRoundTips: 3 tips for the candidate's next round (given below), specific to this job. Empty if no next round is given.`;

// Decided in code because the model reads passing mentions (e.g. accommodation notices) as a described process.
const DESCRIBED_PROCESS_RE = [
  /^\W*(the |our )?(interview|hiring|recruiting|recruitment|application) (process|journey|loop|stages)\W*$/im,
  /\b(interview|hiring|recruiting|recruitment) (process|loop)\s*(:|includes|consists of|involves|looks like|will)/i,
  /^\W*(stage|step|round)\s*(1|one)\b/im,
];
export const describesInterviewProcess = (jdText) => DESCRIBED_PROCESS_RE.some((re) => re.test(jdText));

const ANSWERS_PROMPT = `${COACH}
- likelyQuestions: 6 questions this company is likely to ask: 4 technical tied to the job's requirements, 2 behavioural tied to its responsibilities. why: what they want to learn. answerHint: which real CV experience to use and what to emphasise.
- talkingPoints: for the 3 most important requirements, a story outline from the candidate's real CV experience (situation, action, result). Never invent experience.
- gaps: for up to 3 of the listed gaps, an honest way to address it (closest related experience, how they'd ramp up). Never suggest claiming experience they don't have.
- whyThisRole: 2 sentences the candidate could say about why they want this role, using the job's domain and wording.
- questionsToAsk: 4 thoughtful questions to ask the interviewers, specific to this job.
- generalTips: 3 practical tips for this interview process.`;

const NOT_A_STAGE = /^(next round|tips|likely questions|questions|talking points|gaps|why this role|general tips)\b/i;

function prepSystem(cv) {
  const { numbered } = numberedCv(cv.text);
  return `${COACH}

CANDIDATE CV (line numbers):
${numbered.slice(0, 4000)}
${cv.notes ? `NOTES: ${cv.notes}` : ''}`;
}

function prepContext(details, jdText, { gaps, nextRound, passedRounds, matched }) {
  return `JOB
Role: ${details.role || 'unknown'} at ${details.company || 'unknown'}
Seniority: ${details.seniority}
Domain: ${details.domain || 'unknown'}
Must-haves: ${(details.mustHave || []).join('; ') || '(see description)'}
Already shown on the CV: ${matched?.length ? matched.join('; ') : '(none identified)'}

Job description (trimmed):
${cleanJd(jdText).slice(0, 2500)}

GAPS FOR THIS JOB:
${gaps.length ? gaps.map((g) => `- ${g}`).join('\n') : '(none identified)'}

INTERVIEW PROGRESS:
Rounds passed so far: ${passedRounds.length ? passedRounds.join(', ') : 'none'}
Next round: ${nextRound?.type ? `round ${nextRound.number}, ${nextRound.type}` : nextRound ? `round ${nextRound.number}, type not known yet` : 'none'}`;
}

export async function generatePrepProcess(details, jdText, cv, progress) {
  const fromJd = describesInterviewProcess(jdText);
  const p = await chat(`${prepSystem(cv)}\n${processPrompt(fromJd).replace(`${COACH}\n`, '')}`, prepContext(details, jdText, progress), PROCESS_SCHEMA, { maxTokens: 900, label: 'prep-process' });
  return {
    processFromJd: fromJd,
    stages: (p.stages || []).filter((s) => !NOT_A_STAGE.test(s.name.trim())).slice(0, 8),
    nextRoundTips: progress.nextRound ? (p.nextRoundTips || []).slice(0, 4) : [],
  };
}

export async function generatePrepAnswers(details, jdText, cv, progress) {
  const p = await chat(`${prepSystem(cv)}\n${ANSWERS_PROMPT.replace(`${COACH}\n`, '')}`, prepContext(details, jdText, progress), ANSWERS_SCHEMA, { maxTokens: 1400, label: 'prep-answers' });
  return {
    likelyQuestions: (p.likelyQuestions || []).slice(0, 8),
    talkingPoints: (p.talkingPoints || []).slice(0, 4),
    gaps: (p.gaps || []).slice(0, 4),
    whyThisRole: p.whyThisRole || '',
    questionsToAsk: (p.questionsToAsk || []).slice(0, 5),
    generalTips: (p.generalTips || []).slice(0, 4),
  };
}

const ADVICE_SCHEMA = {
  type: 'object',
  properties: {
    honesty: { type: 'string', enum: ['have_it', 'close', 'not_in_experience'] },
    originalLine: { type: 'string' },
    rewrittenLine: { type: 'string' },
    why: { type: 'string' },
  },
  required: ['honesty', 'originalLine', 'rewrittenLine', 'why'],
};

function quoteInCv(cvText, quote) {
  if (!quote || quote.length < 12) return false;
  const n = (s) => s.toLowerCase().replace(/\s+/g, ' ').trim();
  const q = n(quote);
  const cv = n(cvText);
  return cv.includes(q) || cv.includes(q.slice(0, Math.min(40, q.length)));
}

export async function generateGapAdvice(cv, { name, phrases, cvLines, jobPhrases }) {
  const { numbered } = numberedCv(cv.text);
  const system = `You help a candidate name skills they already have. Never invent tools, employers, dates or responsibilities.
- have_it: the CV already describes this work; it just doesn't use this wording.
- close: the CV shows related work, not this skill itself.
- not_in_experience: nothing in the CV supports adding this. rewrittenLine must be "".
originalLine must be copied exactly from a numbered CV line. rewrittenLine may only rephrase that line to name the skill.`;

  const user = `SKILL TO NAME: ${name}
How job descriptions say it:
${(jobPhrases || phrases).slice(0, 6).map((p) => `- ${p}`).join('\n')}

Closest CV lines:
${(cvLines || []).slice(0, 8).map((l, i) => `${i + 1}. ${l}`).join('\n') || numbered.slice(0, 2500)}

CANDIDATE NOTES:
${cv.notes || '(none)'}`;

  const a = await chat(system, user, ADVICE_SCHEMA, { maxTokens: 400, label: 'gap-advice' });
  const honest = ['have_it', 'close', 'not_in_experience'].includes(a.honesty) ? a.honesty : 'not_in_experience';
  const originalOk = quoteInCv(cv.text, a.originalLine);
  if (honest === 'not_in_experience' || !originalOk) {
    return {
      honesty: originalOk ? honest : 'not_in_experience',
      originalLine: originalOk ? a.originalLine : '',
      rewrittenLine: '',
      why: originalOk ? a.why : 'No line in your CV clearly supports this, so it should not be added.',
    };
  }
  return { honesty: honest, originalLine: a.originalLine, rewrittenLine: a.rewrittenLine || '', why: a.why || '' };
}

export async function ollamaStatus() {
  try {
    const res = await fetch(`${OLLAMA_URL}/api/tags`, { signal: AbortSignal.timeout(2000) });
    const { models = [] } = await res.json();
    return { ok: true, hasModel: models.some((m) => m.name === MODEL || m.name === `${MODEL}:latest`) };
  } catch {
    return { ok: false, hasModel: false };
  }
}
