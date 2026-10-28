import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { db, save } from './db.js';
import { MODEL, assessFit, extractDetails, generatePrepAnswers, generatePrepProcess, ollamaStatus } from './llm.js';
import { computeScore } from './scoring.js';
import { adviseGap, dismissGap, rankGaps } from './gaps.js';
import { checkStillOpen, detectSource, fetchJobText, isSameJobUrl, parseInput } from './fetchjob.js';

const PORT = Number(process.env.PORT) || 3000;
const MIN_JD_LENGTH = 200;
const MIN_CV_LENGTH = 200;
const MINUTE = 60_000;
const RETRY_DELAYS_MS = process.env.RETRY_DELAYS_MS?.split(',').map(Number) || [2 * MINUTE, 5 * MINUTE, 15 * MINUTE, 30 * MINUTE];
const MAX_RETRY_AFTER_MS = 60 * MINUTE;
const APPLIED_STATUSES = ['Applied', 'Interview', 'Offer', 'Rejected', 'Ghosted'];
const INTERVIEW_STATUSES = ['Interview', 'Offer'];
const ROUND_RESULTS = ['pending', 'passed', 'failed'];
const ROUND_FIELDS = ['type', 'date', 'result', 'notes'];
const DETAIL_FIELDS = ['company', 'role', 'location', 'workMode', 'salary'];
const JOB_FIELDS = ['source', 'url', 'deadline', 'priority', 'notes', 'appliedAt', 'savedAt', 'rejectedAt', 'expectedRounds'];

const today = () => new Date().toLocaleDateString('en-CA');
const currentCv = () => db.cvVersions.at(-1) || null;
const findJob = (id) => db.jobs.find((j) => j.id === id);

let queue = Promise.resolve();

// All AI work shares one queue so the local model only runs one job at a time.
function schedule(job, stateKey, errorKey, task) {
  job[stateKey] = 'queued';
  job[errorKey] = null;
  save();
  queue = queue.then(async () => {
    if (!findJob(job.id)) return;
    job[stateKey] = 'processing';
    save();
    try {
      await task(job);
    } catch (e) {
      job[stateKey] = 'error';
      job[errorKey] = e.message;
      console.error(`[job ${job.id}]`, e);
    }
    save();
  });
}

const enqueue = (job) => schedule(job, 'state', 'error', analyse);
const enqueuePrep = (job) => schedule(job, 'prepState', 'prepError', buildPrep);

function nextRound(job) {
  const last = job.rounds.at(-1);
  if (last?.result === 'pending') return { type: last.type, number: job.rounds.length };
  if (last?.result === 'failed') return null;
  return { type: job.rounds.length ? null : 'Recruiter call', number: job.rounds.length + 1 };
}

async function buildPrep(job) {
  const cv = currentCv();
  if (!job.details || !job.jdText) throw new Error('This job has no job description to prepare from.');
  if (!cv) throw new Error('Add your CV in the My CV tab first.');

  const a = job.analysis;
  const gaps = a
    ? [...a.mustHave, ...a.niceToHave].filter((r) => r.match !== 'yes').map((r) => r.requirement).concat(a.missingKeywords)
    : [];
  const matched = a
    ? [...a.mustHave, ...a.niceToHave].filter((r) => r.match === 'yes').map((r) => r.requirement)
    : [];
  const round = nextRound(job);
  const progress = {
    gaps: [...new Set(gaps)].slice(0, 8),
    matched: [...new Set(matched)].slice(0, 12),
    nextRound: round,
    passedRounds: job.rounds.filter((r) => r.result === 'passed').map((r) => r.type),
  };

  const processPart = await generatePrepProcess(job.details, job.jdText, cv, progress);
  job.prep = {
    ...processPart,
    partial: true,
    forRound: round?.type || null,
    roundNumber: round?.number || null,
    model: MODEL,
    generatedAt: new Date().toISOString(),
  };
  if (processPart.processFromJd && processPart.stages.length && !job.expectedRounds) {
    job.expectedRounds = String(processPart.stages.length);
  }
  save();

  const answers = await generatePrepAnswers(job.details, job.jdText, cv, progress);
  job.prep = { ...job.prep, ...answers, partial: false };
  job.prepState = 'ready';
}

function needsJd(job, reason) {
  job.state = 'needs_jd';
  job.reason = reason;
  job.fetchAttempts = 0;
  job.retryAt = null;
}

function armRetry(job) {
  const ms = Math.max(0, new Date(job.retryAt) - Date.now());
  setTimeout(() => {
    const current = findJob(job.id);
    if (current?.state === 'retry_wait') enqueue(current);
  }, ms);
}

// Jitter spreads retries so several waiting jobs don't all hit the site in the same rate-limit window.
function scheduleRetry(job, reason, retryAfterMs) {
  const attempt = job.fetchAttempts || 0;
  const jittered = RETRY_DELAYS_MS[attempt] * (0.8 + Math.random() * 0.4);
  const delay = Math.max(jittered, Math.min(retryAfterMs || 0, MAX_RETRY_AFTER_MS));
  job.fetchAttempts = attempt + 1;
  job.state = 'retry_wait';
  job.reason = reason;
  job.retryAt = new Date(Date.now() + delay).toISOString();
  armRetry(job);
}

async function analyse(job) {
  if (!job.jdText) {
    const page = await fetchJobText(job.url);
    if (!page.ok) {
      if (page.temporary && (job.fetchAttempts || 0) < RETRY_DELAYS_MS.length) {
        return scheduleRetry(job, page.reason, page.retryAfterMs);
      }
      return needsJd(job, page.temporary
        ? `${page.reason} Automatic retries didn't help. Use the Save to Job Tracker button on the job page, try the link again later, or paste the description.`
        : page.reason);
    }
    job.jdText = page.text;
    job.jdOrigin = 'fetched';
    job.fetchAttempts = 0;
    job.retryAt = null;
  }

  if (!job.details) {
    const { isJobDescription, ...details } = await extractDetails(job.jdText);
    if (!isJobDescription && job.jdOrigin === 'fetched') {
      job.jdText = '';
      return needsJd(job, "The page loaded but didn't contain a readable job description.");
    }
    job.details = details;
    if (!job.expectedRounds && details.interviewRounds) job.expectedRounds = String(details.interviewRounds);
    save();
  }

  const cv = currentCv();
  if (cv) {
    const assessment = await assessFit(job.details, job.jdText, cv);
    const { score, breakdown } = computeScore(job.details, assessment);
    job.analysis = {
      score,
      breakdown,
      mustHave: assessment.mustHave,
      niceToHave: assessment.niceToHave,
      candidateYears: assessment.candidateYears,
      missingKeywords: assessment.missingKeywords,
      suggestions: assessment.suggestions,
      verdict: assessment.verdict,
      cvVersion: cv.version,
      model: MODEL,
      scoredAt: new Date().toISOString(),
    };
    if (job.list === 'applied' && job.appliedScore == null) {
      job.appliedScore = score;
      job.appliedCvVersion = cv.version;
    }
  }

  job.state = 'ready';
  job.reason = null;
}

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(express.static(fileURLToPath(new URL('./public', import.meta.url))));

const withJob = (handler) => async (req, res) => {
  const job = findJob(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  try {
    await handler(job, req, res);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
};

app.get('/api/state', async (_req, res) => {
  res.json({
    jobs: db.jobs.map(({ jdText, ...job }) => ({ ...job, hasJd: Boolean(jdText) })),
    cv: currentCv(),
    model: MODEL,
    ollama: await ollamaStatus(),
  });
});

function findDuplicate(url) {
  return url ? db.jobs.find((j) => isSameJobUrl(url, j.url)) : null;
}

function applyJob(job) {
  job.list = 'applied';
  job.status = 'Applied';
  job.appliedAt = today();
  job.appliedScore = job.analysis?.score ?? null;
  job.appliedCvVersion = job.analysis?.cvVersion ?? null;
}

app.post('/api/jobs', (req, res) => {
  const { input = '', list, source } = req.body;
  const { url, text } = parseInput(String(input));
  const hasJd = text.length >= MIN_JD_LENGTH;
  if (!url && !hasJd) {
    return res.status(400).json({ error: 'Paste a job link or the full job description text.' });
  }

  const applied = list === 'applied';
  const existing = findDuplicate(url);
  if (existing) {
    let duplicate = 'exists';
    if (applied && existing.list !== 'applied') {
      applyJob(existing);
      duplicate = 'moved';
    }
    if (hasJd && !existing.jdText) {
      existing.jdText = text;
      existing.jdOrigin = 'pasted';
      enqueue(existing);
    } else {
      save();
    }
    return res.json({ id: existing.id, duplicate, list: existing.list });
  }
  const job = {
    id: crypto.randomUUID(),
    list: applied ? 'applied' : 'wishlist',
    status: applied ? 'Applied' : 'Saved',
    url,
    source: source && source !== 'Auto' ? source : detectSource(url),
    jdText: hasJd ? text : '',
    jdOrigin: hasJd ? 'pasted' : null,
    savedAt: today(),
    appliedAt: applied ? today() : null,
    deadline: '',
    priority: '',
    notes: hasJd ? '' : text,
    details: null,
    analysis: null,
    appliedScore: null,
    appliedCvVersion: null,
    openCheck: null,
    rounds: [],
    expectedRounds: '',
    reachedInterview: false,
    prep: null,
    prepState: null,
    prepError: null,
    createdAt: new Date().toISOString(),
  };
  db.jobs.unshift(job);
  enqueue(job);
  res.json({ id: job.id });
});

app.post('/api/jobs/:id/jd', withJob((job, req, res) => {
  const text = String(req.body.text || '').trim();
  if (text.length < MIN_JD_LENGTH) {
    return res.status(400).json({ error: 'That looks too short. Paste the full job description.' });
  }
  job.jdText = text;
  job.jdOrigin = 'pasted';
  job.details = null;
  enqueue(job);
  res.json({ ok: true });
}));

app.post('/api/jobs/:id/analyse', withJob((job, _req, res) => {
  job.fetchAttempts = 0;
  job.retryAt = null;
  enqueue(job);
  res.json({ ok: true });
}));

app.post('/api/jobs/:id/prep', withJob((job, _req, res) => {
  if (!job.details || !job.jdText) return res.status(400).json({ error: 'This job needs a job description before interview prep can be made.' });
  if (!currentCv()) return res.status(400).json({ error: 'Add your CV in the My CV tab first.' });
  enqueuePrep(job);
  res.json({ ok: true });
}));

app.post('/api/jobs/:id/apply', withJob((job, _req, res) => {
  applyJob(job);
  save();
  res.json({ ok: true });
}));

app.post('/api/jobs/:id/check', withJob(async (job, _req, res) => {
  if (!job.url) return res.status(400).json({ error: 'This job has no link.' });
  job.openCheck = { result: await checkStillOpen(job.url), checkedAt: new Date().toISOString() };
  save();
  res.json(job.openCheck);
}));

app.get('/api/jobs/:id/jd', withJob((job, _req, res) => {
  res.json({ text: job.jdText || '' });
}));

app.patch('/api/jobs/:id', withJob((job, req, res) => {
  for (const [key, value] of Object.entries(req.body)) {
    if (key === 'status' && APPLIED_STATUSES.includes(value)) setStatus(job, value);
    else if (JOB_FIELDS.includes(key)) job[key] = String(value);
    else if (DETAIL_FIELDS.includes(key)) job.details = { ...job.details, [key]: String(value) };
  }
  save();
  res.json({ ok: true });
}));

// reachedInterview stays true after a later rejection, so stats still credit the CV for getting through screening.
function setStatus(job, status, { at } = {}) {
  job.status = status;
  if (status === 'Rejected') job.rejectedAt ||= at || today();
  else job.rejectedAt = '';
  if (INTERVIEW_STATUSES.includes(status) || job.rounds.length) job.reachedInterview = true;
  else if (status === 'Applied') job.reachedInterview = false;
}

app.post('/api/jobs/:id/rounds', withJob((job, req, res) => {
  const round = {
    id: crypto.randomUUID(),
    type: String(req.body.type || 'Recruiter call'),
    date: String(req.body.date || today()),
    result: 'pending',
    notes: '',
  };
  job.rounds.push(round);
  if (job.status === 'Applied' || job.status === 'Ghosted') setStatus(job, 'Interview');
  job.reachedInterview = true;
  save();
  res.json(round);
}));

app.patch('/api/jobs/:id/rounds/:roundId', withJob((job, req, res) => {
  const round = job.rounds.find((r) => r.id === req.params.roundId);
  if (!round) return res.status(404).json({ error: 'Round not found' });
  for (const [key, value] of Object.entries(req.body)) {
    if (key === 'result' && !ROUND_RESULTS.includes(value)) continue;
    if (ROUND_FIELDS.includes(key)) round[key] = String(value);
  }
  if (req.body.result === 'failed' && job.status === 'Interview') {
    setStatus(job, 'Rejected', { at: round.date || today() });
  }
  if (req.body.result && req.body.result !== 'failed' && job.status === 'Rejected' && !job.rounds.some((r) => r.result === 'failed')) {
    setStatus(job, 'Interview');
  }
  save();
  res.json(round);
}));

app.delete('/api/jobs/:id/rounds/:roundId', withJob((job, req, res) => {
  job.rounds = job.rounds.filter((r) => r.id !== req.params.roundId);
  save();
  res.json({ ok: true });
}));

app.delete('/api/jobs/:id', withJob((job, _req, res) => {
  db.jobs.splice(db.jobs.indexOf(job), 1);
  save();
  res.json({ ok: true });
}));

app.put('/api/cv', (req, res) => {
  const text = String(req.body.text || '').trim();
  const notes = String(req.body.notes || '').trim();
  if (text.length < MIN_CV_LENGTH) return res.status(400).json({ error: 'Paste your full CV text.' });

  const current = currentCv();
  if (current && current.text === text && current.notes === notes) return res.json(current);

  const cv = { version: (current?.version || 0) + 1, text, notes, createdAt: new Date().toISOString() };
  db.cvVersions.push(cv);
  save();
  res.json(cv);
});

app.post('/api/rescore-all', (_req, res) => {
  const skip = new Set(['Rejected', 'Offer', 'Ghosted']);
  const jobs = db.jobs.filter((j) => j.details && (j.state === 'ready' || j.state === 'error') && !(j.list === 'applied' && skip.has(j.status)));
  jobs.forEach(enqueue);
  res.json({ queued: jobs.length });
});

app.get('/api/gaps', async (req, res) => {
  try {
    const list = ['wishlist', 'applied'].includes(req.query.list) ? req.query.list : 'all';
    const includeLongShots = req.query.longShots === '1';
    res.json(await rankGaps({ list, q: String(req.query.q || ''), includeLongShots, cv: currentCv() }));
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/gaps/:id/advise', async (req, res) => {
  try {
    res.json(await adviseGap(req.params.id, currentCv()));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post('/api/gaps/:id/dismiss', (req, res) => {
  dismissGap(req.params.id, req.body?.dismissed !== false);
  res.json({ ok: true });
});

db.skillGroups ??= [];
db.dismissedGaps ??= [];
db.gapAdvice ??= {};

for (const job of db.jobs) {
  job.rounds ??= [];
  job.expectedRounds ??= '';
  job.reachedInterview ??= INTERVIEW_STATUSES.includes(job.status);
  job.prep ??= null;
  if (job.state === 'queued' || job.state === 'processing') enqueue(job);
  if (job.state === 'retry_wait') armRetry(job);
  if (job.prepState === 'queued' || job.prepState === 'processing') enqueuePrep(job);
}

app.listen(PORT, () => {
  console.log(`Job tracker running at http://localhost:${PORT} (model: ${MODEL})`);
});
