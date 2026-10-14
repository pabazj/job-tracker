const OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434';
export const MODEL = process.env.MODEL || 'qwen2.5:7b';

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

const REQUIREMENT = {
  type: 'object',
  properties: {
    requirement: { type: 'string' },
    evidence: { type: 'string' },
    match: { type: 'string', enum: ['yes', 'partial', 'no'] },
  },
  required: ['requirement', 'evidence', 'match'],
};

const ROLE = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    start: { type: 'string' },
    end: { type: 'string' },
    relevant: { type: 'boolean' },
  },
  required: ['title', 'start', 'end', 'relevant'],
};

const ASSESS_SCHEMA = {
  type: 'object',
  properties: {
    mustHave: { type: 'array', items: REQUIREMENT },
    niceToHave: { type: 'array', items: REQUIREMENT },
    roles: { type: 'array', items: ROLE },
    seniorityFit: { type: 'string', enum: ['under', 'match', 'over', 'unclear'] },
    locationFit: { type: 'string', enum: ['ok', 'unclear', 'blocked'] },
    domainFit: { type: 'string', enum: ['strong', 'some', 'none'] },
    missingKeywords: { type: 'array', items: { type: 'string' } },
    suggestions: { type: 'array', items: { type: 'string' } },
    verdict: { type: 'string' },
  },
  required: [
    'mustHave', 'niceToHave', 'roles', 'seniorityFit', 'locationFit',
    'domainFit', 'missingKeywords', 'suggestions', 'verdict',
  ],
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

const ASSESS_PROMPT = `You are a strict recruiter screening a candidate's CV against one job. Judge only from evidence in the CV and candidate notes; never assume skills that are not shown.
- For every listed requirement, in the same order, write evidence first (a short quote from the CV, or "" if none), then match:
  "yes" = the CV names this skill/tool/qualification (or an obvious equivalent, e.g. "Postgres" for PostgreSQL) in a job, project, or skills list.
  "partial" = the CV only shows something adjacent (e.g. ECS for Kubernetes, RabbitMQ for Kafka).
  "no" = nothing related in the CV.
- roles: every job in the CV with start and end as "YYYY-MM" (use "present" for current roles; use "-01" if only the year is given). relevant = true if it is a professional role in the same field as this job.
- seniorityFit: candidate level versus the role's level.
- locationFit: "blocked" only if the job clearly requires a location or work authorization that the candidate notes say they lack; "unclear" if it can't be determined; otherwise "ok".
- domainFit: experience in the same industry or product area.
- missingKeywords: important skills, tools, or qualifications from the job description absent from the CV, at most 8.
- suggestions: 1-3 specific, truthful CV edits that would improve fit for this job. Never suggest inventing experience.
- verdict: one sentence on how likely this CV is to get an interview and why.`;

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
  const d = await chat(EXTRACT_PROMPT, `Job posting:\n\n${jdText.slice(0, 12000)}`, EXTRACT_SCHEMA, { label: 'extract' });
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

export async function assessFit(details, jdText, cv) {
  const list = (items) => (items.length ? items.map((r, i) => `${i + 1}. ${r}`).join('\n') : '(none listed)');
  const user = `JOB
Role: ${details.role || 'unknown'}
Company: ${details.company || 'unknown'}
Seniority: ${details.seniority}
Years of experience required: ${details.yearsRequired ?? 'not stated'}
Location / work mode: ${details.location || 'unknown'} / ${details.workMode}

Must-have requirements:
${details.mustHave.length ? list(details.mustHave) : '(none listed - infer up to 6 core requirements from the description)'}

Nice-to-have:
${list(details.niceToHave)}

Full job description:
${jdText.slice(0, 6000)}

CANDIDATE CV:
${cv.text.slice(0, 8000)}

CANDIDATE NOTES:
${cv.notes || '(none)'}`;

  const a = await chat(ASSESS_PROMPT, user, ASSESS_SCHEMA, { label: 'score' });
  const cvText = `${cv.text}\n${cv.notes || ''}`;
  return {
    ...a,
    mustHave: (a.mustHave || []).map((r) => upgradeIfNamed(r, cvText)),
    niceToHave: (a.niceToHave || []).map((r) => upgradeIfNamed(r, cvText)),
    roles: a.roles || [],
    candidateYears: relevantYears(a.roles || []),
    missingKeywords: (a.missingKeywords || [])
      .filter((k) => !/already|present in/i.test(k) && !mentions(cvText, k))
      .slice(0, 8),
    suggestions: (a.suggestions || []).slice(0, 3),
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

function prepContext(details, jdText, cv, { gaps, nextRound, passedRounds }) {
  return `JOB
Role: ${details.role || 'unknown'} at ${details.company || 'unknown'}
Seniority: ${details.seniority}
Domain: ${details.domain || 'unknown'}
Key requirements: ${[...details.mustHave, ...details.niceToHave].join('; ') || '(see description)'}

Full job description:
${jdText.slice(0, 6000)}

CANDIDATE CV:
${cv.text.slice(0, 6000)}

CANDIDATE GAPS FOR THIS JOB:
${gaps.length ? gaps.map((g) => `- ${g}`).join('\n') : '(none identified)'}

INTERVIEW PROGRESS:
Rounds passed so far: ${passedRounds.length ? passedRounds.join(', ') : 'none'}
Next round: ${nextRound?.type ? `round ${nextRound.number}, ${nextRound.type}` : nextRound ? `round ${nextRound.number}, type not known yet` : 'none'}`;
}

export async function generatePrepProcess(details, jdText, cv, progress) {
  const fromJd = describesInterviewProcess(jdText);
  const p = await chat(processPrompt(fromJd), prepContext(details, jdText, cv, progress), PROCESS_SCHEMA, { maxTokens: 1200, label: 'prep-process' });
  return {
    processFromJd: fromJd,
    stages: (p.stages || []).filter((s) => !NOT_A_STAGE.test(s.name.trim())).slice(0, 8),
    nextRoundTips: progress.nextRound ? (p.nextRoundTips || []).slice(0, 4) : [],
  };
}

export async function generatePrepAnswers(details, jdText, cv, progress) {
  const p = await chat(ANSWERS_PROMPT, prepContext(details, jdText, cv, progress), ANSWERS_SCHEMA, { maxTokens: 1800, label: 'prep-answers' });
  return {
    likelyQuestions: (p.likelyQuestions || []).slice(0, 8),
    talkingPoints: (p.talkingPoints || []).slice(0, 4),
    gaps: (p.gaps || []).slice(0, 4),
    whyThisRole: p.whyThisRole || '',
    questionsToAsk: (p.questionsToAsk || []).slice(0, 5),
    generalTips: (p.generalTips || []).slice(0, 4),
  };
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
