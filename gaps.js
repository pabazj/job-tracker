import crypto from 'node:crypto';
import { db, save } from './db.js';
import { computeScore, fitsFromAnalysis } from './scoring.js';
import { generateGapAdvice, numberedCv } from './llm.js';

const OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434';
const EMBED_MODEL = process.env.EMBED_MODEL || 'nomic-embed-text';
const COSINE_MIN = 0.82;
const JACCARD_MIN = 0.5;
const HALF_LIFE_DAYS = 60;
const LONG_SHOT = 45;
const LONG_SHOT_WEIGHT = 0.25;
const NICE_WEIGHT = 0.4;
const HIGH_SCORE = 70;
const TWEAK_LIMIT = 8;
const STOP = new Set('a an and as at by for from in of on or the to with using'.split(' '));

db.skillGroups ??= [];
db.dismissedGaps ??= [];
db.gapAdvice ??= {};

export function normalizeSkill(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[“”"'()]/g, '')
    .replace(/\b(hands-on |working )?experience (with|in|of)\b/g, '')
    .replace(/\b(strong|solid|proven|excellent|proficient in|proficiency in|familiarity with|ability to|knowledge of|understanding of|expertise in|skilled in|demonstrated)\b/g, '')
    .replace(/[^a-z0-9+.#/ ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokens(s) {
  return new Set(normalizeSkill(s).split(' ').filter((w) => w.length > 1 && !STOP.has(w)));
}

function jaccard(a, b) {
  const A = tokens(a);
  const B = tokens(b);
  if (!A.size || !B.size) return 0;
  let n = 0;
  for (const x of A) if (B.has(x)) n++;
  return n / (A.size + B.size - n);
}

function cosine(a, b) {
  if (!a?.length || !b?.length || a.length !== b.length) return 0;
  let d = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    d += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return d / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}

const embedCache = new Map();

async function embed(text) {
  const key = normalizeSkill(text) || text;
  if (embedCache.has(key)) return embedCache.get(key);
  const res = await fetch(`${OLLAMA_URL}/api/embeddings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: EMBED_MODEL, prompt: key, keep_alive: '10m' }),
  });
  if (!res.ok) throw new Error(`Could not embed "${text}" (${res.status}). Is ${EMBED_MODEL} pulled?`);
  const { embedding } = await res.json();
  embedCache.set(key, embedding);
  return embedding;
}

function titleCase(s) {
  const t = s.trim();
  if (t !== t.toLowerCase() && t !== t.toUpperCase()) return t;
  return t.replace(/\b[a-z]/g, (c) => c.toUpperCase());
}

function distinctive(s) {
  return [...tokens(s)].filter((w) => w.length > 3 || /[.#+\d]/.test(w));
}

function overlap(a, b) {
  const A = distinctive(a);
  const B = new Set(distinctive(b));
  if (A.length < 2 || B.size < 2) return 0;
  let n = 0;
  for (const x of A) if (B.has(x)) n++;
  return n / Math.min(A.length, B.size);
}

function findGroup(phrase, embedding) {
  const n = normalizeSkill(phrase);
  const exact = db.skillGroups.find((g) => g.aliases.includes(n) || normalizeSkill(g.name) === n);
  if (exact) return exact;
  let best = null;
  let bestScore = 0;
  for (const g of db.skillGroups) {
    const jac = Math.max(jaccard(n, g.name), ...g.aliases.map((a) => jaccard(n, a)));
    const ov = Math.max(overlap(n, g.name), ...g.aliases.map((a) => overlap(n, a)));
    const cos = embedding && embedCache.get(normalizeSkill(g.name))
      ? cosine(embedding, embedCache.get(normalizeSkill(g.name)))
      : 0;
    if (cos < COSINE_MIN && jac < JACCARD_MIN && ov < 0.6) continue;
    const score = cos + jac + ov;
    if (score > bestScore) {
      bestScore = score;
      best = g;
    }
  }
  return best;
}

function isYearsReq(s) {
  return /\b\d+\+?\s*years?\b/i.test(s) && /experience|professional/i.test(s);
}

function shortName(s) {
  const n = titleCase(normalizeSkill(s) || s);
  return n.length > 72 ? `${n.slice(0, 69)}…` : n;
}

async function groupFor(phrase) {
  let embedding = null;
  try {
    embedding = await embed(phrase);
  } catch {
    embedding = null;
  }
  let group = findGroup(phrase, embedding);
  if (!group) {
    group = {
      id: crypto.randomUUID(),
      name: shortName(phrase),
      aliases: [normalizeSkill(phrase)].filter(Boolean),
    };
    db.skillGroups.push(group);
  } else if (!group.aliases.includes(normalizeSkill(phrase))) {
    group.aliases.push(normalizeSkill(phrase));
  }
  return group;
}

export async function tagJob(job) {
  const a = job.analysis;
  if (!a) return;
  for (const r of [...(a.mustHave || []), ...(a.niceToHave || [])]) {
    if (r.groupId || isYearsReq(r.requirement)) continue;
    r.groupId = (await groupFor(r.requirement)).id;
  }
  a.missingGroups ??= [];
  if (!a.missingGroups.length && a.missingKeywords?.length) {
    for (const k of a.missingKeywords) {
      if (isYearsReq(k)) continue;
      a.missingGroups.push({ keyword: k, groupId: (await groupFor(k)).id });
    }
  }
}

function jobDate(job) {
  return job.appliedAt || job.savedAt || job.createdAt;
}

function daysAgo(s) {
  if (!s) return 0;
  const t = new Date(s.length === 10 ? `${s}T00:00` : s).getTime();
  return Math.max(0, (Date.now() - t) / 86400000);
}

function jobWeight(job, includeLongShots) {
  const recency = 0.5 ** (daysAgo(jobDate(job)) / HALF_LIFE_DAYS);
  const longShot = job.analysis?.score != null && job.analysis.score < LONG_SHOT;
  return recency * (longShot && !includeLongShots ? LONG_SHOT_WEIGHT : 1);
}

function closestCvLines(cvText, phrases, n = 8) {
  const { lines } = numberedCv(cvText);
  const keys = phrases.map(tokens);
  return lines
    .map((line) => {
      const T = tokens(line);
      let score = 0;
      for (const k of keys) {
        let hit = 0;
        for (const w of k) if (T.has(w)) hit++;
        score = Math.max(score, hit);
      }
      return { line, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, n)
    .map((x) => x.line);
}

function impactFor(group, jobs) {
  let before = 0;
  let after = 0;
  let n = 0;
  for (const job of jobs) {
    const a = job.analysis;
    if (!a || !job.details) continue;
    const touches = [...(a.mustHave || []), ...(a.niceToHave || [])].some((r) => r.groupId === group.id && r.match !== 'yes');
    if (!touches) continue;
    n++;
    before += a.score;
    const flip = (items) => (items || []).map((r) => (r.groupId === group.id ? { ...r, match: 'yes' } : r));
    after += computeScore(job.details, {
      ...fitsFromAnalysis(a),
      mustHave: flip(a.mustHave),
      niceToHave: flip(a.niceToHave),
    }).score;
  }
  if (!n) return null;
  return { jobs: n, avgBefore: Math.round(before / n), avgAfter: Math.round(after / n) };
}

function reachedInterview(job) {
  return Boolean(job.reachedInterview)
    || ['Interview', 'Offer'].includes(job.status)
    || (job.rounds || []).length > 0;
}

function isScreeningReject(job) {
  return job.list === 'applied'
    && job.analysis
    && ['Rejected', 'Ghosted'].includes(job.status)
    && !reachedInterview(job);
}

function emptyGapRow(group) {
  return {
    id: group.id,
    name: group.name,
    phrases: new Set(),
    jobs: new Map(),
    mustHaveJobs: 0,
    weight: 0,
    yes: 0,
    partial: 0,
    no: 0,
  };
}

function addGapHit(byId, job, r, kind, kindWeight) {
  if (!r.groupId || r.match === 'yes') return;
  const g = db.skillGroups.find((x) => x.id === r.groupId);
  if (!g) return;
  const row = byId.get(g.id) || emptyGapRow(g);
  row.phrases.add(r.requirement);
  if (!row.jobs.has(job.id)) {
    row.jobs.set(job.id, {
      id: job.id,
      company: job.details?.company,
      role: job.details?.role,
      list: job.list,
      score: job.analysis.score,
      phrase: r.requirement,
      match: r.match,
      kind,
    });
    if (kind === 'must') row.mustHaveJobs++;
  }
  row.weight += kindWeight;
  row[r.match] = (row[r.match] || 0) + 1;
  byId.set(g.id, row);
}

function collectJobGaps(byId, job, mustWeight, keywordWeight = mustWeight * 0.8) {
  for (const r of job.analysis.mustHave || []) addGapHit(byId, job, r, 'must', mustWeight);
  for (const r of job.analysis.niceToHave || []) addGapHit(byId, job, r, 'nice', mustWeight * NICE_WEIGHT);
  for (const m of job.analysis.missingGroups || []) {
    if (byId.get(m.groupId)?.jobs.has(job.id)) continue;
    addGapHit(byId, job, { requirement: m.keyword, match: 'no', groupId: m.groupId }, 'must', keywordWeight);
  }
}

function adviceFor(cv, groupId) {
  if (!cv) return null;
  return db.gapAdvice[`${cv.version}:${groupId}`] || null;
}

async function rejectionInsights(cv) {
  const jobs = db.jobs.filter(isScreeningReject);
  for (const job of jobs) await tagJob(job);
  const byId = new Map();
  for (const job of jobs) {
    const high = (job.analysis.score ?? 0) >= HIGH_SCORE ? 1.5 : 1;
    collectJobGaps(byId, job, high, 0.8);
  }
  const dismissed = new Set(db.dismissedGaps);
  const tweaks = [...byId.values()]
    .filter((row) => !dismissed.has(row.id))
    .sort((a, b) => b.weight - a.weight || b.jobs.size - a.jobs.size || b.mustHaveJobs - a.mustHaveJobs)
    .slice(0, TWEAK_LIMIT)
    .map((row) => ({
      id: row.id,
      name: row.name,
      phrases: [...row.phrases],
      jobCount: row.jobs.size,
      mustHaveJobs: row.mustHaveJobs,
      jobs: [...row.jobs.values()],
      advice: adviceFor(cv, row.id),
    }));
  const scores = jobs.map((j) => j.analysis.score).filter((s) => s != null);
  return {
    jobCount: jobs.length,
    highScoreCount: jobs.filter((j) => (j.analysis.score ?? 0) >= HIGH_SCORE).length,
    avgScore: scores.length ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : null,
    jobs: jobs.map((j) => ({
      id: j.id,
      company: j.details?.company,
      role: j.details?.role,
      score: j.analysis.score,
      status: j.status,
    })),
    tweaks,
  };
}

export async function rankGaps({ list = 'all', q = '', includeLongShots = false, cv } = {}) {
  const jobs = db.jobs.filter((j) => {
    if (!j.analysis) return false;
    if (list === 'wishlist' || list === 'applied') return j.list === list;
    return true;
  });
  for (const g of db.skillGroups) {
    try { await embed(g.name); } catch { /* embeddings optional; Jaccard still groups */ }
  }
  for (const job of jobs) await tagJob(job);
  const rejections = await rejectionInsights(cv);
  save();

  const byId = new Map();
  for (const job of jobs) collectJobGaps(byId, job, jobWeight(job, includeLongShots));

  const query = q.trim().toLowerCase();
  const dismissed = new Set(db.dismissedGaps);
  const rows = [...byId.values()]
    .filter((row) => row.jobs.size >= 1)
    .filter((row) => !query || row.name.toLowerCase().includes(query) || [...row.phrases].some((p) => p.toLowerCase().includes(query)))
    .map((row) => {
      const group = db.skillGroups.find((g) => g.id === row.id);
      const jobsFor = jobs.filter((j) => row.jobs.has(j.id));
      const impact = impactFor(group, jobsFor);
      return {
        id: row.id,
        name: row.name,
        phrases: [...row.phrases],
        jobCount: row.jobs.size,
        mustHaveJobs: row.mustHaveJobs,
        partial: row.partial,
        missing: row.no,
        weight: Math.round(row.weight * 10) / 10,
        impact,
        dismissed: dismissed.has(row.id),
        jobs: [...row.jobs.values()],
        advice: adviceFor(cv, row.id),
      };
    })
    .sort((a, b) => b.weight - a.weight || b.mustHaveJobs - a.mustHaveJobs);

  return { gaps: rows, totalJobs: jobs.length, rejections };
}

export async function adviseGap(groupId, cv) {
  const group = db.skillGroups.find((g) => g.id === groupId);
  if (!group) throw new Error('Unknown skill.');
  if (!cv) throw new Error('Add your CV in the My CV tab first.');
  const key = `${cv.version}:${groupId}`;
  if (db.gapAdvice[key]) return db.gapAdvice[key];

  const { gaps } = await rankGaps({ cv });
  const row = gaps.find((g) => g.id === groupId);
  const phrases = row?.phrases || group.aliases;
  const cvLines = closestCvLines(cv.text, phrases);
  const advice = await generateGapAdvice(cv, {
    name: group.name,
    phrases,
    cvLines,
    jobPhrases: phrases,
  });
  db.gapAdvice[key] = { ...advice, generatedAt: new Date().toISOString() };
  save();
  return db.gapAdvice[key];
}

export function dismissGap(id, dismissed = true) {
  const set = new Set(db.dismissedGaps);
  if (dismissed) set.add(id);
  else set.delete(id);
  db.dismissedGaps = [...set];
  save();
}
