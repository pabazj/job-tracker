const SOURCES = ['LinkedIn', 'Indeed', 'Glassdoor', 'Company site', 'Greenhouse', 'Lever', 'Ashby', 'Workday', 'Wellfound', 'Referral', 'Other'];
const STATUSES = ['Applied', 'Interview', 'Offer', 'Rejected', 'Ghosted'];
const WORK_MODES = ['remote', 'hybrid', 'onsite', 'unknown'];
const PRIORITIES = ['', 'High', 'Medium', 'Low'];
const ROUND_TYPES = ['Recruiter call', 'Hiring manager', 'Technical', 'Coding test / take-home', 'System design', 'Behavioural', 'Onsite / panel', 'Final', 'Other'];
const ROUND_RESULTS = { pending: 'Pending', passed: 'Passed', failed: 'Failed' };
const STALE_WISHLIST_DAYS = 10;
const NO_REPLY_DAYS = 14;
const DEADLINE_SOON_DAYS = 3;
const POLL_MS = 3000;
const MAX_FETCH_RETRIES = 4;
const CAPTURE_PREFIX = '#capture=';
const MIN_OUTCOMES_FOR_STATS = 20;
const SCORE_BUCKETS = ['80–100%', '60–79%', '40–59%', '0–39%', 'Unscored'];

let state = { jobs: [], cv: null, ollama: {}, model: '' };
let lastJson = '';
let pendingRender = false;
let tab = ['wishlist', 'applied', 'stats', 'gaps', 'cv'].includes(location.hash.slice(1)) ? location.hash.slice(1) : 'wishlist';
let gapData = { gaps: [], totalJobs: 0 };
let gapOpen = null;
let gapShowAll = false;
let gapBusy = false;
let captured = readCapture();
const expanded = new Set();
const openSections = new Set();
const jdCache = new Map();
const drafts = {};
const filters = { wishlist: { q: '', sort: 'newest' }, applied: { q: '', status: '', sort: 'newest' }, gaps: { q: '', list: 'all', longShots: '' } };
const PRIORITY_RANK = { High: 3, Medium: 2, Low: 1 };
const SORTS = {
  newest: 'Newest first',
  oldest: 'Oldest first',
  scoreHigh: 'Highest score',
  scoreLow: 'Lowest score',
  deadline: 'Deadline soonest',
  priority: 'Priority',
  nextInterview: 'Next interview',
};

const $ = (sel, root = document) => root.querySelector(sel);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const toDate = (s) => new Date(s.length === 10 ? `${s}T00:00` : s);
const fmtDate = (s) => (s ? toDate(s).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : '—');
const daysSince = (s) => Math.floor((Date.now() - toDate(s)) / 86400000);
const isBusy = (j) => ['queued', 'processing', 'retry_wait'].includes(j.state);
const fmtTime = (s) => new Date(s).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
const isPrepBusy = (j) => j.prepState === 'queued' || j.prepState === 'processing';
const scoreAtApply = (j) => j.appliedScore ?? j.analysis?.score ?? null;
const rounds = (j) => j.rounds || [];
const reachedInterview = (j) => j.reachedInterview || rounds(j).length > 0 || ['Interview', 'Offer'].includes(j.status);
// Screening outcome: did the CV get an interview? Later rejections still count as a yes.
const outcome = (j) => (reachedInterview(j) ? 'pos' : ['Rejected', 'Ghosted'].includes(j.status) ? 'neg' : 'pending');
const scoreClass = (s) => (s >= 70 ? 'high' : s >= 45 ? 'mid' : 'low');
const SCORE_LABELS = { high: 'strong match', mid: 'partial match', low: 'long shot' };
const scoreLabel = (s) => SCORE_LABELS[scoreClass(s)];
const options = (values, selected) => values.map((v) => `<option value="${esc(v)}" ${v === selected ? 'selected' : ''}>${esc(v || '—')}</option>`).join('');
const withValue = (values, value) => (values.includes(value) || !value ? values : [value, ...values]);
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const today = () => new Date().toLocaleDateString('en-CA');

// The bookmarklet hands the job over in the URL hash, because job sites' Content-Security-Policy
// blocks fetch() to localhost but not opening a new tab.
function readCapture() {
  if (!location.hash.startsWith(CAPTURE_PREFIX)) return null;
  try {
    const data = JSON.parse(decodeURIComponent(location.hash.slice(CAPTURE_PREFIX.length)));
    history.replaceState(null, '', `#${tab}`);
    return data?.text ? data : null;
  } catch {
    return null;
  }
}

const linkedInId = (url) => String(url || '').match(/linkedin\.com\/.*?(?:jobs\/view\/(?:[^/?#]*?-)?|currentJobId=)(\d{6,})/)?.[1];
function canonicalJobUrl(url) {
  try {
    const u = new URL(url);
    u.hash = '';
    u.hostname = u.hostname.replace(/^www\./, '');
    return `${u.protocol}//${u.hostname}${u.pathname.replace(/\/+$/, '') || '/'}`;
  } catch {
    return String(url || '').trim();
  }
}
const findSameJob = (url) => url && state.jobs.find((j) => j.url && (
  canonicalJobUrl(url) === canonicalJobUrl(j.url) || (linkedInId(url) && linkedInId(url) === linkedInId(j.url))
));

function bookmarkletHref() {
  const code = `(function(){
var q=function(s){var e=document.querySelector(s);return e?e.innerText.trim():''};
var sel=String(window.getSelection()).trim();
var desc=sel.length>200?sel:(q('.jobs-description__content')||q('#job-details')||q('.jobs-box__html-content')||q('.show-more-less-html__markup')||q('#jobDescriptionText')||q('[data-testid="jobsearch-JobComponent-description"]')||q('[class*="jobDescription"]')||q('main')||document.body.innerText);
var head=[q('.job-details-jobs-unified-top-card__job-title')||q('.top-card-layout__title')||q('h1'),q('.job-details-jobs-unified-top-card__company-name')||q('.topcard__org-name-link')||q('[data-testid="inlineHeader-companyName"]'),q('.job-details-jobs-unified-top-card__primary-description-container')||q('.topcard__flavor--bullet')||q('[data-testid="inlineHeader-companyLocation"]')].filter(Boolean).join('\\n');
var u=location.href,m=u.match(/currentJobId=(\\d+)/);if(m)u='https://www.linkedin.com/jobs/view/'+m[1]+'/';
var data={url:u,title:document.title,text:(head+'\\n\\n'+desc).slice(0,15000)};
window.open('${location.origin}/${CAPTURE_PREFIX}'+encodeURIComponent(JSON.stringify(data)),'_blank');
})();`;
  return `javascript:${encodeURIComponent(code.replace(/\n/g, ''))}`;
}

function captureView() {
  if (!captured) return '';
  const existing = findSameJob(captured.url);
  const preview = captured.text.split('\n').filter(Boolean).slice(0, 3).join(' · ');
  return `<section class="card capture">
    <h2>Add this job from your browser?</h2>
    <p><b>${esc(preview.slice(0, 160))}</b></p>
    <p class="muted small">${esc(shortUrl(captured.url))} · ${captured.text.length.toLocaleString()} characters captured</p>
    ${existing ? `<p class="banner warn small">This job is already in your ${existing.list === 'applied' ? 'Applied' : 'Wishlist'} list${existing.details?.role ? ` (${esc(existing.details.role)})` : ''}.</p>` : ''}
    ${captured.text.length < 400 ? '<p class="banner warn small">Very little text was captured. Open the full job description on the page, or select the description text before clicking the bookmark.</p>' : ''}
    <div class="row">
      <button data-action="addCaptured" data-list="wishlist">Add to wishlist</button>
      <button data-action="addCaptured" data-list="applied">Add as applied today</button>
      <button class="secondary" data-action="dismissCapture">Cancel</button>
    </div>
  </section>`;
}

function shortUrl(url) {
  try {
    const u = new URL(url);
    return u.hostname.replace(/^www\./, '') + (u.pathname.length > 30 ? `${u.pathname.slice(0, 30)}…` : u.pathname);
  } catch {
    return url;
  }
}

async function api(path, opts = {}) {
  const res = await fetch(path, {
    method: opts.method || 'GET',
    headers: { 'Content-Type': 'application/json' },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => el.classList.remove('show'), 3500);
}

function isEditing() {
  const el = document.activeElement;
  return el && $('#main').contains(el) && el.matches('input, textarea, select');
}

async function refresh(force = false) {
  const data = await api('/api/state');
  const json = JSON.stringify(data);
  if (!force && json === lastJson) return;
  lastJson = json;
  state = data;
  if (!force && isEditing()) {
    pendingRender = true;
    return;
  }
  render();
}

// ---------- rendering ----------

function render() {
  pendingRender = false;
  document.querySelectorAll('nav [data-tab]').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  $('#count-wishlist').textContent = state.jobs.filter((j) => j.list === 'wishlist').length || '';
  $('#count-applied').textContent = state.jobs.filter((j) => j.list === 'applied').length || '';
  renderAiStatus();

  const main = $('#main');
  main.innerHTML = tab === 'stats' ? statsView() : tab === 'cv' ? cvView() : tab === 'gaps' ? gapsView() : listView(tab);
  main.querySelectorAll('[data-draft]').forEach((el) => {
    if (drafts[el.dataset.draft] != null) el.value = drafts[el.dataset.draft];
  });
}

function renderAiStatus() {
  const { ok, hasModel } = state.ollama;
  const busy = state.jobs.filter((j) => isBusy(j) || isPrepBusy(j)).length;
  $('#aiStatus').innerHTML = !ok
    ? '<span class="dot"></span>Ollama is not running. Open the Ollama app.'
    : !hasModel
      ? `<span class="dot"></span>Model missing. Run: ollama pull ${esc(state.model)}`
      : `<span class="dot ok"></span>${esc(state.model)}${busy ? ` · analysing ${busy}` : ''}`;
}

function listView(list) {
  const f = filters[list];
  const isApplied = list === 'applied';
  return `
    ${captureView()}
    <section class="card paste">
      <h2>${isApplied ? 'Add a job you applied to today' : 'Save a job for later'}</h2>
      <textarea data-draft="paste_${list}" placeholder="Paste the job link, the job description text, or both (link on the first or last line).&#10;&#10;LinkedIn and Indeed links often can't be read automatically, so pasting the description text is the most reliable."></textarea>
      <div class="row">
        <select id="pasteSource" title="Where did you find this job?">${options(['Auto', ...SOURCES], 'Auto')}</select>
        <button data-action="add" data-list="${list}">${isApplied ? 'Add as applied today' : 'Add to wishlist'}</button>
        ${state.cv ? '' : '<span class="hint">Add your CV in the <b>My CV</b> tab to get interview-chance scores.</span>'}
      </div>
      <p class="hint bookmarklet-tip">
        Faster, and never blocked: drag
        <a class="bookmarklet" href="${esc(bookmarkletHref())}" title="Drag me to your bookmarks bar" data-action="bookmarkletHelp">★ Save to Job Tracker</a>
        to your bookmarks bar. Then click it while viewing a job on LinkedIn, Indeed or any job site.
      </p>
    </section>
    <div class="toolbar">
      <input data-filter="q" data-list="${list}" placeholder="Search company, role, site…" value="${esc(f.q)}">
      ${isApplied ? `<select data-filter="status" data-list="${list}">${options(['', ...STATUSES], f.status).replace('>—<', '>All statuses<')}</select>` : ''}
      <select data-filter="sort" data-list="${list}" title="Sort">
        ${sortOptions(list, f.sort)}
      </select>
    </div>
    <div id="jobs">${jobsHtml(list)}</div>`;
}

function sortOptions(list, selected) {
  const keys = list === 'applied'
    ? ['newest', 'oldest', 'scoreHigh', 'scoreLow', 'nextInterview']
    : ['newest', 'oldest', 'scoreHigh', 'scoreLow', 'deadline', 'priority'];
  return keys.map((k) => `<option value="${k}" ${k === selected ? 'selected' : ''}>${SORTS[k]}</option>`).join('');
}

function listDate(j) {
  return (j.list === 'applied' ? j.appliedAt : j.savedAt) || j.createdAt || '';
}

function nextInterviewDate(j) {
  const pending = rounds(j).filter((r) => r.result === 'pending' && r.date).map((r) => r.date).sort();
  return pending[0] || '';
}

function cmp(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

function sortJobs(jobs, list, sort) {
  const byDate = (a, b) => cmp(listDate(a), listDate(b)) || cmp(a.createdAt, b.createdAt);
  const score = (j) => j.analysis?.score;
  switch (sort) {
    case 'oldest':
      return jobs.sort(byDate);
    case 'scoreHigh':
      return jobs.sort((a, b) => (score(b) ?? -1) - (score(a) ?? -1) || byDate(b, a));
    case 'scoreLow':
      return jobs.sort((a, b) => (score(a) ?? 101) - (score(b) ?? 101) || byDate(b, a));
    case 'deadline':
      return jobs.sort((a, b) => cmp(a.deadline || '9999', b.deadline || '9999') || byDate(b, a));
    case 'priority':
      return jobs.sort((a, b) => (PRIORITY_RANK[b.priority] || 0) - (PRIORITY_RANK[a.priority] || 0) || byDate(b, a));
    case 'nextInterview':
      return jobs.sort((a, b) => cmp(nextInterviewDate(a) || '9999', nextInterviewDate(b) || '9999') || byDate(b, a));
    default:
      return jobs.sort((a, b) => byDate(b, a));
  }
}

function jobsHtml(list) {
  const f = filters[list];
  const q = f.q.toLowerCase();
  const jobs = sortJobs(
    state.jobs
      .filter((j) => j.list === list)
      .filter((j) => !f.status || j.status === f.status)
      .filter((j) => !q || [j.details?.company, j.details?.role, j.source, j.url, j.notes].join(' ').toLowerCase().includes(q)),
    list,
    f.sort,
  );

  if (!jobs.length) {
    return `<div class="empty">${state.jobs.some((j) => j.list === list) ? 'No jobs match your filters.' : 'Nothing here yet. Paste a job above.'}</div>`;
  }
  return jobs.map(jobCard).join('');
}

function scoreBadge(j) {
  if (isBusy(j)) return '<div class="score busy" title="Analysing">…</div>';
  const s = j.analysis?.score;
  if (s == null) return '<div class="score" title="Not scored yet">—</div>';
  return `<div class="score ${scoreClass(s)}" title="CV fit: ${s}%, ${scoreLabel(s)}. How much of this job's requirements your CV covers.">${s}%</div>`;
}

function flags(j) {
  const out = [];
  if (j.list === 'wishlist') {
    if (j.priority === 'High') out.push({ text: 'High priority', cls: 'green' });
    if (j.deadline) {
      const left = -daysSince(j.deadline);
      if (left < 0) out.push({ text: 'Deadline passed', cls: 'red' });
      else if (left <= DEADLINE_SOON_DAYS) out.push({ text: left === 0 ? 'Deadline today' : `Deadline in ${left}d`, cls: 'amber' });
    }
    const age = daysSince(j.savedAt);
    if (age > STALE_WISHLIST_DAYS) out.push({ text: `Saved ${age}d ago`, cls: 'amber' });
    if (j.openCheck?.result === 'closed') out.push({ text: 'Posting closed', cls: 'red' });
    if (j.analysis && state.cv && j.analysis.cvVersion < state.cv.version) out.push({ text: 'Scored with older CV', cls: '' });
  } else {
    for (const r of rounds(j).filter((x) => x.result === 'pending' && x.date)) {
      if (r.date === today()) out.push({ text: `${r.type} today`, cls: 'green' });
      else if (r.date > today()) out.push({ text: `${r.type} ${fmtDate(r.date).replace(/, \d{4}$/, '')}`, cls: 'green' });
      else out.push({ text: `Update result: ${r.type}`, cls: 'amber' });
    }
    if (j.status === 'Applied') {
      const age = daysSince(j.appliedAt);
      if (age > NO_REPLY_DAYS) out.push({ text: `No reply for ${age}d`, cls: 'amber' });
    }
  }
  return out;
}

function progressLabel(j) {
  const r = rounds(j);
  const failedAt = r.findIndex((x) => x.result === 'failed');
  if (j.status === 'Offer') return r.length ? `Offer after ${plural(r.length, 'round')}` : 'Offer';
  if (j.status === 'Rejected') {
    if (failedAt >= 0) return `Rejected after round ${failedAt + 1} · ${r[failedAt].type}`;
    return reachedInterview(j) ? 'Rejected after interview' : 'Rejected, no interview';
  }
  if (j.status === 'Ghosted' && reachedInterview(j)) return 'Ghosted after interview';
  if (!r.length) return '';
  return `Round ${r.length}${j.expectedRounds ? ` of ${j.expectedRounds}` : ''} · ${r.at(-1).type}`;
}

function roundsHtml(j) {
  const r = rounds(j);
  const rows = r.map((x, i) => `<tr data-round-id="${esc(x.id)}">
      <td class="muted">${i + 1}</td>
      <td><select data-round-field="type">${options(withValue(ROUND_TYPES, x.type), x.type)}</select></td>
      <td><input type="date" data-round-field="date" value="${esc(x.date)}"></td>
      <td><select data-round-field="result" class="result r-${esc(x.result)}">
        ${Object.entries(ROUND_RESULTS).map(([v, label]) => `<option value="${v}" ${v === x.result ? 'selected' : ''}>${label}</option>`).join('')}
      </select></td>
      <td class="grow"><input data-round-field="notes" value="${esc(x.notes)}" placeholder="Who, topics, how it went…"></td>
      <td><button class="small danger" data-action="deleteRound" title="Remove round">✕</button></td>
    </tr>`).join('');

  return `<div class="rounds">
    <h4>Interview rounds${j.expectedRounds ? ` · ${r.length} of ${esc(j.expectedRounds)}` : ''}</h4>
    ${r.length ? `<table><tbody>${rows}</tbody></table>` : '<p class="muted small">No rounds yet. Add one when the company contacts you. You don\'t need to know how many there will be.</p>'}
    <div class="row">
      <button class="small" data-action="addRound">+ Add round</button>
      <label class="inline muted small">Expected rounds (optional)
        <input type="number" min="1" max="10" data-field="expectedRounds" value="${esc(j.expectedRounds)}" placeholder="?">
      </label>
    </div>
  </div>`;
}

function pasteJdBox(j, lead) {
  return `<div class="small">${lead}${j.url ? `<a href="${esc(j.url)}" target="_blank" rel="noopener">open the posting</a>, copy the description, and paste it here:` : 'paste the job description here:'}</div>
    <textarea data-draft="jd_${j.id}" placeholder="Paste the full job description text…"></textarea>
    <div class="row"><button data-action="submitJd">Analyse</button></div>`;
}

function stateBanner(j) {
  switch (j.state) {
    case 'queued':
      return '<div class="banner">Waiting in the queue…</div>';
    case 'processing':
      return '<div class="banner">Reading the job and comparing it with your CV. This takes about a minute.</div>';
    case 'retry_wait':
      return `<div class="banner warn">
        <b>Waiting to retry.</b> <span class="muted">${esc(j.reason)}</span>
        Trying again automatically at ${fmtTime(j.retryAt)} (retry ${j.fetchAttempts} of ${MAX_FETCH_RETRIES}).
        <button class="small secondary" data-action="analyse">Try now</button>
        ${pasteJdBox(j, 'Or skip the wait: ')}
      </div>`;
    case 'needs_jd':
      return `<div class="banner warn">
        <b>I couldn't read this job automatically.</b> <span class="muted">${esc(j.reason)}</span>
        ${j.url ? '<button class="small secondary" data-action="analyse">Try the link again</button>' : ''}
        ${pasteJdBox(j, '')}
      </div>`;
    case 'error':
      return `<div class="banner error"><b>Analysis failed:</b> ${esc(j.error)} <button class="small" data-action="analyse">Retry</button></div>`;
    default:
      return j.analysis || !j.details ? '' : `<div class="banner muted">Not scored yet. ${state.cv ? '<button class="small secondary" data-action="analyse">Score now</button>' : 'Add your CV in the My CV tab.'}</div>`;
  }
}

function jobCard(j) {
  const d = j.details || {};
  const title = d.role
    ? `<b>${esc(d.role)}</b>${d.company ? ` · ${esc(d.company)}` : ''}`
    : `<b>${esc(j.url ? shortUrl(j.url) : 'New job')}</b>`;
  const meta = [d.location, d.workMode !== 'unknown' && d.workMode, d.salary, j.source].filter(Boolean).map(esc).join(' · ');
  const progress = j.list === 'applied' ? progressLabel(j) : '';
  const date = (j.list === 'applied' ? `Applied ${fmtDate(j.appliedAt)}` : `Saved ${fmtDate(j.savedAt)}`) + (progress ? ` · ${esc(progress)}` : '');
  const control = j.list === 'applied'
    ? `<select data-field="status" class="status st-${esc(j.status)}">${options(STATUSES, j.status)}</select>`
    : '<button class="small" data-action="apply">Mark applied</button>';

  return `<article class="job${expanded.has(j.id) ? ' open' : ''}" data-id="${esc(j.id)}">
    <div class="job-head" data-action="toggle">
      ${scoreBadge(j)}
      <div class="job-title">${title}<div class="meta">${meta}</div></div>
      <div class="job-side">
        <div class="flags">${flags(j).map((f) => `<span class="flag ${f.cls}">${esc(f.text)}</span>`).join('')}</div>
        <span class="meta">${date}</span>
        <div class="job-actions">
          ${control}
          <button class="small danger" data-action="delete">Delete</button>
        </div>
      </div>
    </div>
    ${stateBanner(j)}
    ${expanded.has(j.id) ? jobBody(j) : ''}
  </article>`;
}

// Index of the stage the candidate is on (pending round) or heading into next.
function currentStage(j) {
  const r = rounds(j);
  if (r.some((x) => x.result === 'failed') || ['Offer', 'Rejected'].includes(j.status)) return { index: -1 };
  if (r.at(-1)?.result === 'pending') return { index: r.length - 1, label: 'Current round' };
  return { index: r.length, label: 'Up next' };
}

const EMPTY_PREP = { stages: [], nextRoundTips: [], likelyQuestions: [], talkingPoints: [], gaps: [], whyThisRole: '', questionsToAsk: [], generalTips: [] };

function fold(j, key, title, summary, body, controls = '') {
  const open = openSections.has(`${j.id}:${key}`);
  return `<section class="fold${open ? ' open' : ''}">
    <div class="fold-head" data-action="toggleSection" data-section="${key}">
      <span class="caret">${open ? '▾' : '▸'}</span>
      <h4>${title}</h4>
      <span class="muted small fold-summary">${summary}</span>
      <span style="flex:1"></span>
      ${controls}
    </div>
    ${open ? `<div class="fold-body">${body}</div>` : ''}
  </section>`;
}

function prepFold(j) {
  const p = j.prep && { ...EMPTY_PREP, ...j.prep };
  const busy = isPrepBusy(j);
  const writingRest = busy && p?.partial;

  let controls = '';
  let summary = '';
  if (busy) {
    summary = j.prepState === 'queued' ? 'Waiting in the queue…'
      : writingRest ? 'Step 2 of 2: writing questions and talking points…'
        : 'Step 1 of 2: working out the interview stages…';
  } else if (j.prepState === 'error') {
    summary = `Couldn't prepare: ${esc(j.prepError)}`;
  } else if (p) {
    summary = `Prepared ${p.forRound ? `for round ${p.roundNumber} · ${esc(p.forRound)} · ` : ''}${fmtDate(p.generatedAt)}`;
  } else {
    summary = j.hasJd && state.cv ? 'Stages, likely questions, talking points and questions to ask' : 'Needs a job description and your CV';
  }
  if (!busy && j.hasJd && state.cv) {
    controls = `<button class="small${p ? ' secondary' : ''}" data-action="prep">${p ? 'Regenerate' : 'Prepare for interview'}</button>`;
  }

  const body = p
    ? prepBody(j, p, writingRest)
    : '<p class="muted small">Click <b>Prepare for interview</b> to get interview stages with tips, likely questions, talking points from your CV, how to handle your gaps, and questions to ask them, all based on this job description.</p>';
  return fold(j, 'prep', 'Interview prep', summary, body, controls);
}

function prepBody(j, p, writingRest) {
  const li = (s) => `<li>${esc(s)}</li>`;
  const list = (items) => `<ul>${items.map(li).join('')}</ul>`;
  const cur = p.processFromJd ? currentStage(j) : { index: -1 };
  const stages = p.stages.map((s, i) => `<li class="${i === cur.index ? 'current' : ''}">
      <b>${esc(s.name)}</b>${i === cur.index ? ` <span class="flag green">${cur.label}</span>` : ''}
      ${s.format ? `<div class="muted small">${esc(s.format)}</div>` : ''}
      ${s.focus ? `<div class="small"><b>What they assess:</b> ${esc(s.focus)}</div>` : ''}
      ${s.tips.length ? list(s.tips) : ''}
    </li>`).join('');

  const sections = [
    [p.processFromJd ? 'Interview process (from the job description)' : 'Typical interview process for this kind of role',
      `${p.processFromJd ? '' : '<p class="muted small">This job description doesn’t describe its interview process, so these are the usual stages. Ask the recruiter what the process looks like on your first call.</p>'}
      <ol class="stages">${stages}</ol>`],
    p.forRound && p.nextRoundTips.length && [`Tips for your next round: ${esc(p.forRound)}`, list(p.nextRoundTips)],
    p.likelyQuestions.length && ['Likely questions', `<ol class="questions">${p.likelyQuestions.map((q) => `<li>
        <b>${esc(q.question)}</b>
        <div class="muted small">Why they ask: ${esc(q.why)}</div>
        <div class="hint">${esc(q.answerHint)}</div>
      </li>`).join('')}</ol>`],
    p.talkingPoints.length && ['Your talking points', `<ul class="points">${p.talkingPoints.map((t) => `<li><b>${esc(t.requirement)}:</b> ${esc(t.story)}</li>`).join('')}</ul>`],
    p.gaps.length && ['Handling your gaps', `<ul class="points">${p.gaps.map((g) => `<li><b>${esc(g.gap)}:</b> ${esc(g.howToAnswer)}</li>`).join('')}</ul>`],
    p.whyThisRole && ['Why this role', `<p>${esc(p.whyThisRole)}</p>`],
    p.questionsToAsk.length && ['Questions to ask them', list(p.questionsToAsk)],
    p.generalTips.length && ['General tips', list(p.generalTips)],
  ].filter(Boolean);

  return `${sections.map(([title, body]) => `<section class="prep-section"><h5>${title}</h5>${body}</section>`).join('')}
    ${writingRest ? '<p class="muted small">Likely questions, talking points and questions to ask will appear here when step 2 finishes.</p>' : ''}
    <p class="muted small">Generated by ${esc(p.model)} from the job description and your CV. It can’t look up the company online, so double-check anything company-specific.</p>`;
}

function requirementItem(r, nice) {
  const icon = { yes: '✓', partial: '~', no: '✗' }[r.match] || '?';
  return `<li class="m-${esc(r.match)}"><span class="icon">${icon}</span>${esc(r.requirement)}${nice ? ' <span class="muted small">(nice to have)</span>' : ''}
    ${r.evidence ? `<div class="evidence">${esc(r.evidence)}</div>` : ''}</li>`;
}

function analysisHtml(j) {
  const a = j.analysis;
  const changed = j.appliedScore != null && j.appliedScore !== a.score;
  return `
    <div class="verdict">${esc(a.verdict)}</div>
    <p class="hint score-meaning">
      <b>${a.score}% fit, ${scoreLabel(a.score)}</b> (70%+ strong, 45–69% partial, under 45% long shot).
      This is how much of the job's requirements your CV covers, weighted as below. It isn't a probability:
      if strong matches keep getting no interview, look at how your CV reads. The Stats tab tracks this.
    </p>
    ${a.breakdown.map((b) => `<div class="bar-row">
      <span>${esc(b.label)} <span class="muted small">(${b.weight})</span></span>
      <div class="bar"><i style="width:${Math.round(b.value * 100)}%"></i></div>
      <span class="muted small">${esc(b.detail)}</span>
    </div>`).join('')}
    <div class="cols">
      <div>
        <h4>Requirements</h4>
        <ul class="reqs">${a.mustHave.map((r) => requirementItem(r, false)).join('')}${a.niceToHave.map((r) => requirementItem(r, true)).join('')}</ul>
      </div>
      <div>
        <h4>Missing from your CV</h4>
        <div class="chips">${a.missingKeywords.map((k) => `<span class="chip">${esc(k)}</span>`).join('') || '<span class="muted">Nothing obvious.</span>'}</div>
        <h4>CV suggestions for this job</h4>
        <ul>${a.suggestions.map((s) => `<li>${esc(s)}</li>`).join('')}</ul>
      </div>
    </div>
    <p class="muted small">Scored with CV v${a.cvVersion} · ${esc(a.model)} · ${fmtDate(a.scoredAt)}${changed ? ` · score when you applied: ${j.appliedScore}%` : ''}</p>`;
}

function field(label, name, value, type = 'text', cls = '') {
  return `<label class="${cls}">${label}<input type="${type}" data-field="${name}" value="${esc(value)}"></label>`;
}

function selectField(label, name, values, value) {
  return `<label>${label}<select data-field="${name}">${options(withValue(values, value), value)}</select></label>`;
}

function jobBody(j) {
  if (j.list !== 'applied') return `<div class="job-body">${detailsHtml(j)}</div>`;

  const a = j.analysis;
  const mustHave = a?.mustHave || [];
  const matched = mustHave.filter((r) => r.match === 'yes').length;
  const summary = [
    a && `${scoreAtApply(j) ?? a.score}% fit when applied`,
    mustHave.length && `${matched}/${mustHave.length} must-haves`,
    'requirements, CV suggestions, job info and notes',
  ].filter(Boolean).join(' · ');

  return `<div class="job-body">
    ${roundsHtml(j)}
    ${prepFold(j)}
    ${fold(j, 'details', 'Job details & CV fit', summary, detailsHtml(j))}
  </div>`;
}

function detailsHtml(j) {
  const d = j.details || {};
  const jd = jdCache.get(j.id);
  const check = j.openCheck ? `<span class="muted small">Last check: ${esc(j.openCheck.result)} (${fmtDate(j.openCheck.checkedAt)})</span>` : '';
  return `
    ${j.analysis ? analysisHtml(j) : ''}
    ${d.summary ? `<p class="summary">${esc(d.summary)}</p>` : ''}
    <div class="fields">
      ${field('Company', 'company', d.company)}
      ${field('Role', 'role', d.role)}
      ${field('Location', 'location', d.location)}
      ${selectField('Work mode', 'workMode', WORK_MODES, d.workMode || 'unknown')}
      ${field('Salary', 'salary', d.salary)}
      ${selectField('Found on', 'source', SOURCES, j.source)}
      ${j.list === 'applied'
        ? field('Applied on', 'appliedAt', j.appliedAt, 'date')
        : `${field('Deadline', 'deadline', j.deadline, 'date')}${selectField('Priority', 'priority', PRIORITIES, j.priority)}`}
      ${field('Job link', 'url', j.url, 'url', 'wide')}
      <label class="wide">Notes<textarea data-field="notes" rows="2">${esc(j.notes)}</textarea></label>
    </div>
    <div class="actions">
      ${j.url ? `<a href="${esc(j.url)}" target="_blank" rel="noopener">Open posting ↗</a>` : ''}
      ${j.hasJd ? `<button class="small secondary" data-action="toggleJd">${jd ? 'Hide' : 'View'} job description</button>` : ''}
      ${j.hasJd && state.cv ? '<button class="small secondary" data-action="analyse">Re-score with current CV</button>' : ''}
      ${j.url && j.list === 'wishlist' ? '<button class="small secondary" data-action="check">Check if still open</button>' : ''}
      ${check}
    </div>
    ${jd ? `<pre class="jd">${esc(jd)}</pre>` : ''}`;
}

function groupTable(title, jobs, keyFn, order) {
  const groups = new Map();
  for (const j of jobs) {
    const key = keyFn(j);
    const g = groups.get(key) || { total: 0, pos: 0, neg: 0, pending: 0, scores: [] };
    g.total++;
    g[outcome(j)]++;
    if (scoreAtApply(j) != null) g.scores.push(scoreAtApply(j));
    groups.set(key, g);
  }
  const keys = order ? order.filter((k) => groups.has(k)) : [...groups.keys()].sort((a, b) => groups.get(b).total - groups.get(a).total);
  const rows = keys.map((k) => {
    const g = groups.get(k);
    const decided = g.pos + g.neg;
    const rate = decided ? Math.round((g.pos / decided) * 100) : null;
    const avg = g.scores.length ? Math.round(g.scores.reduce((s, x) => s + x, 0) / g.scores.length) : null;
    return `<tr>
      <td>${esc(k)}</td><td>${g.total}</td>
      <td>${avg == null ? '—' : `${avg}%`}</td>
      <td>${rate == null ? '<span class="muted">—</span>' : `<span class="bar"><i style="width:${rate}%"></i></span>${rate}%`}</td>
      <td>${g.pos}</td><td>${g.neg}</td><td>${g.pending}</td>
    </tr>`;
  }).join('');
  return `<section class="card"><h2>${title}</h2>
    <table><thead><tr><th></th><th>Applied</th><th>Avg predicted</th><th>Actual interview rate</th><th>Got interview</th><th>No interview</th><th>Waiting</th></tr></thead>
    <tbody>${rows}</tbody></table></section>`;
}

function statsView() {
  const applied = state.jobs.filter((j) => j.list === 'applied');
  if (!applied.length) return '<div class="card empty">No applications yet. Stats appear once you add jobs to the Applied list.</div>';

  const count = (fn) => applied.filter(fn).length;
  const pos = count((j) => outcome(j) === 'pos');
  const neg = count((j) => outcome(j) === 'neg');
  const decided = pos + neg;
  const avgOf = (list) => (list.length ? `${Math.round(list.reduce((s, j) => s + scoreAtApply(j), 0) / list.length)}%` : '—');
  const scored = applied.filter((j) => scoreAtApply(j) != null);
  const bucket = (j) => {
    const s = scoreAtApply(j);
    return s == null ? 'Unscored' : s >= 80 ? '80–100%' : s >= 60 ? '60–79%' : s >= 40 ? '40–59%' : '0–39%';
  };
  const pct = (n, d) => (d ? `${Math.round((n / d) * 100)}%` : '—');
  const jobRow = (j, extra) => `<tr><td><b>${esc(j.details?.role || shortUrl(j.url))}</b> · ${esc(j.details?.company)}</td><td>${scoreAtApply(j) ?? '—'}%</td><td>${esc(extra)}</td><td>${esc(j.source)}</td><td>${fmtDate(j.appliedAt)}</td></tr>`;
  const screenedOut = applied.filter((j) => outcome(j) === 'neg' && scoreAtApply(j) >= 70);

  return `
    <section class="card">
      <h2>Summary</h2>
      <div class="stats-grid">
        <div class="stat"><b>${applied.length}</b>Total applications</div>
        ${STATUSES.map((s) => `<div class="stat status st-${s}"><b>${count((j) => j.status === s)}</b>${s}</div>`).join('')}
        <div class="stat"><b>${pct(pos, decided)}</b>Got an interview</div>
        <div class="stat"><b>${avgOf(scored.filter((j) => outcome(j) === 'pos'))}</b>Avg score: got interview</div>
        <div class="stat"><b>${avgOf(scored.filter((j) => outcome(j) === 'neg'))}</b>Avg score: no interview</div>
      </div>
      <p class="muted small">"Got an interview" = jobs where you reached at least one round ÷ jobs with an answer. A rejection after interviewing still counts as getting an interview, because your CV did its job. Ghosted without an interview counts as no. Jobs still on "Applied" are left out.
      ${decided < MIN_OUTCOMES_FOR_STATS ? `<br>Only ${plural(decided, 'outcome')} so far. These numbers become meaningful at around ${MIN_OUTCOMES_FOR_STATS}–30.` : ''}</p>
    </section>
    <h2 class="section-title">CV screening: does your CV get you interviews?</h2>
    ${groupTable('Predicted score vs. what actually happened', applied, bucket, SCORE_BUCKETS)}
    ${groupTable('By job site', applied, (j) => j.source || 'Other')}
    ${groupTable('By CV version', applied, (j) => (j.appliedCvVersion ? `CV v${j.appliedCvVersion}` : 'Unscored'))}
    <section class="card">
      <h2>High score, no interview (70%+)</h2>
      <p class="muted small">Strong matches on paper that never got an interview. That usually points to how the CV reads (ATS formatting, keywords, the first few lines) rather than your skills, or to applying late or at the wrong level.</p>
      ${screenedOut.length ? `<table><tbody>${screenedOut.map((j) => jobRow(j, j.status)).join('')}</tbody></table>` : '<p class="muted">None so far.</p>'}
    </section>
    <h2 class="section-title">Interview performance: what happens after you get in?</h2>
    ${interviewStats(applied.filter((j) => outcome(j) === 'pos'), jobRow)}`;
}

function interviewStats(interviewed, jobRow) {
  if (!interviewed.length) return '<div class="card empty">No interviews yet. Add rounds to an application in the Applied tab when a company contacts you.</div>';

  const pct = (n, d) => (d ? `${Math.round((n / d) * 100)}%` : '—');
  const offers = interviewed.filter((j) => j.status === 'Offer');
  const rejected = interviewed.filter((j) => j.status === 'Rejected');
  const finished = offers.length + rejected.length;
  const allRounds = interviewed.flatMap(rounds);
  const passedPerFinished = [...offers, ...rejected].map((j) => rounds(j).filter((r) => r.result === 'passed').length);
  const avgPassed = passedPerFinished.length ? (passedPerFinished.reduce((s, n) => s + n, 0) / passedPerFinished.length).toFixed(1) : '—';
  const unlogged = interviewed.filter((j) => !rounds(j).length).length;

  const byType = new Map();
  for (const r of allRounds) {
    const g = byType.get(r.type) || { total: 0, passed: 0, failed: 0, pending: 0 };
    g.total++;
    g[r.result]++;
    byType.set(r.type, g);
  }
  const typeRows = [...byType.entries()].sort((a, b) => b[1].total - a[1].total).map(([type, g]) => {
    const decided = g.passed + g.failed;
    const rate = decided ? Math.round((g.passed / decided) * 100) : null;
    return `<tr><td>${esc(type)}</td><td>${g.total}</td>
      <td>${rate == null ? '<span class="muted">—</span>' : `<span class="bar"><i style="width:${rate}%"></i></span>${rate}%`}</td>
      <td>${g.passed}</td><td>${g.failed}</td><td>${g.pending}</td></tr>`;
  }).join('');

  const lostAt = rejected.map((j) => {
    const r = rounds(j);
    const i = r.findIndex((x) => x.result === 'failed');
    return [j, i >= 0 ? `Round ${i + 1} · ${r[i].type}` : 'Round not logged'];
  });

  return `
    <section class="card">
      <div class="stats-grid">
        <div class="stat"><b>${interviewed.length}</b>Interview processes</div>
        <div class="stat"><b>${offers.length}</b>Offers</div>
        <div class="stat"><b>${rejected.length}</b>Rejected after interview</div>
        <div class="stat"><b>${interviewed.length - finished}</b>Still in progress</div>
        <div class="stat"><b>${pct(offers.length, finished)}</b>Offer rate</div>
        <div class="stat"><b>${avgPassed}</b>Avg rounds passed</div>
      </div>
      <p class="muted small">Offer rate = offers ÷ interview processes that have finished.
      ${unlogged ? `<br>${unlogged} interview ${unlogged === 1 ? 'process has' : 'processes have'} no rounds logged. Add rounds to see where you pass and where you drop out.` : ''}</p>
    </section>
    <section class="card">
      <h2>By round type</h2>
      <p class="muted small">Where you pass and where you drop out. A low pass rate on one type shows you what to practise.</p>
      ${typeRows
        ? `<table><thead><tr><th></th><th>Rounds</th><th>Pass rate</th><th>Passed</th><th>Failed</th><th>Pending</th></tr></thead><tbody>${typeRows}</tbody></table>`
        : '<p class="muted">No rounds logged yet.</p>'}
    </section>
    <section class="card">
      <h2>Rejected after interviewing</h2>
      ${lostAt.length ? `<table><tbody>${lostAt.map(([j, where]) => jobRow(j, where)).join('')}</tbody></table>` : '<p class="muted">None so far.</p>'}
    </section>`;
}

function cvView() {
  const cv = state.cv;
  return `<section class="card cv">
    <h2>My CV</h2>
    <p class="muted">${cv ? `Current version: <b>v${cv.version}</b>, saved ${fmtDate(cv.createdAt)}. Saving changes creates a new version, so the Stats tab can compare how each version performs.` : 'No CV saved yet. Paste the plain text of your CV below. Copying it out of the PDF or Word file is fine.'}</p>
    <label>CV text<textarea data-draft="cv_text" rows="18">${esc(cv?.text)}</textarea></label>
    <label>About you <span class="muted">(used for location and work-authorization checks)</span>
      <textarea data-draft="cv_notes" rows="4" placeholder="e.g. Based in Berlin. EU citizen, no visa sponsorship needed. Open to remote or hybrid. Targeting frontend roles.">${esc(cv?.notes)}</textarea></label>
    <div class="row">
      <button data-action="saveCv">Save CV</button>
      ${cv ? '<button class="secondary" data-action="rescoreAll">Re-score all jobs with this CV</button>' : ''}
    </div>
  </section>`;
}

const HONESTY = {
  have_it: 'You have it — it just isn’t named',
  close: 'Close, but not the same. Reword carefully',
  not_in_experience: 'Not in your experience — don’t add it',
};

let gapsLoading = null;
async function loadGaps() {
  if (gapsLoading) return gapsLoading;
  gapBusy = true;
  gapsLoading = (async () => {
    try {
      const f = filters.gaps;
      gapData = await api(`/api/gaps?list=${encodeURIComponent(f.list)}&q=${encodeURIComponent(f.q)}&longShots=${f.longShots ? 1 : 0}`);
    } finally {
      gapBusy = false;
      gapsLoading = null;
    }
  })();
  return gapsLoading;
}

function gapsView() {
  const f = filters.gaps;
  const all = gapData.gaps || [];
  const query = f.q.trim().toLowerCase();
  const visible = all.filter((g) => !g.dismissed && (!query || g.name.toLowerCase().includes(query) || g.phrases.some((p) => p.toLowerCase().includes(query))));
  const hidden = all.filter((g) => g.dismissed);
  const shown = gapShowAll ? visible : visible.slice(0, 15);
  if (!state.cv) {
    return `<section class="card empty">Add your CV in the <b>My CV</b> tab first. This tab ranks skills jobs ask for that your CV doesn’t clearly show.</section>`;
  }
  if (gapBusy && !gapData.totalJobs) {
    return '<section class="card empty">Grouping skills across your jobs. First time takes about half a minute…</section>';
  }
  if (!gapData.totalJobs) {
    return '<section class="card empty">Score a few jobs first. Gaps are built from the must-haves and nice-to-haves on each card.</section>';
  }
  return `
    <section class="card">
      <h2>CV gaps</h2>
      <p class="muted">Skills that show up across the jobs you’ve saved, ranked by how often they’re a must-have. Suggestions only rephrase work already on your CV — nothing is invented.
      ${gapData.totalJobs < 20 ? ` Based on ${plural(gapData.totalJobs, 'scored job')} so far; the ranking gets more reliable around 20–30.` : ''}</p>
      <div class="toolbar">
        <input data-filter="q" data-list="gaps" placeholder="Search a skill…" value="${esc(f.q)}">
        <select data-filter="list" data-list="gaps">
          <option value="all" ${f.list === 'all' ? 'selected' : ''}>All jobs</option>
          <option value="wishlist" ${f.list === 'wishlist' ? 'selected' : ''}>Wishlist only</option>
          <option value="applied" ${f.list === 'applied' ? 'selected' : ''}>Applied only</option>
        </select>
      </div>
      <p class="muted small"><label class="inline"><input type="checkbox" data-filter="longShots" data-list="gaps" ${f.longShots ? 'checked' : ''}> Count long-shot jobs (under 45% fit) at full weight</label></p>
    </section>
    ${shown.map(gapCard).join('') || '<section class="card empty">No gaps for this filter. Either your CV covers these jobs, or try a broader filter.</section>'}
    ${visible.length > 15 && !gapShowAll ? `<p><button class="secondary" data-action="showMoreGaps">Show ${visible.length - 15} more</button></p>` : ''}
    ${hidden.length ? `<section class="card"><h2>Hidden (${hidden.length})</h2><p class="muted small">Marked as not true for you.</p>${hidden.map((g) => `<div class="gap-mini">${esc(g.name)} <button class="small secondary" data-action="restoreGap" data-gap="${esc(g.id)}">Restore</button></div>`).join('')}</section>` : ''}
  `;
}

function gapCard(g) {
  const open = gapOpen === g.id;
  const impact = g.impact
    ? `If you showed this: ${g.impact.avgBefore}% → ${g.impact.avgAfter}% on ${plural(g.impact.jobs, 'job')}`
    : '';
  const a = g.advice;
  return `<article class="card gap ${open ? 'open' : ''}" data-id="${esc(g.id)}">
    <div class="job-head" data-action="toggleGap">
      <div class="job-title">
        <b>${esc(g.name)}</b>
        <div class="meta">${g.jobCount} of ${gapData.totalJobs} jobs · must-have in ${g.mustHaveJobs} · ${g.missing} missing, ${g.partial} partial${impact ? ` · ${impact}` : ''}</div>
      </div>
    </div>
    ${open ? `<div class="job-body">
      <p class="muted small">How postings phrase it: ${g.phrases.map((p) => `<span class="chip">${esc(p)}</span>`).join(' ')}</p>
      <h4>Jobs that ask for this</h4>
      <ul class="gap-jobs">${g.jobs.map((j) => `<li><b>${esc(j.role || 'Job')}</b> · ${esc(j.company || '')} · ${j.score}% · ${j.kind === 'must' ? 'must-have' : 'nice-to-have'} · ${j.match}</li>`).join('')}</ul>
      ${a ? adviceHtml(a) : `<button class="small" data-action="adviseGap">Suggest a CV line from my experience</button>`}
      <div class="actions"><button class="small secondary" data-action="dismissGap">Not true for me</button></div>
    </div>` : ''}
  </article>`;
}

function adviceHtml(a) {
  const label = HONESTY[a.honesty] || a.honesty;
  return `<div class="advice ${esc(a.honesty)}">
    <p><b>${esc(label)}</b></p>
    ${a.why ? `<p>${esc(a.why)}</p>` : ''}
    ${a.originalLine ? `<p class="muted small">From your CV: “${esc(a.originalLine)}”</p>` : ''}
    ${a.rewrittenLine ? `<pre class="jd">${esc(a.rewrittenLine)}</pre><button class="small" data-action="copyAdvice">Copy rewrite</button>` : ''}
  </div>`;
}

// ---------- actions ----------

const draftValue = (key) => (drafts[key] ?? $(`[data-draft="${key}"]`)?.value ?? '').trim();

async function showAddedJob(result, requestedList) {
  const list = result.list || requestedList;
  tab = list;
  history.replaceState(null, '', `#${tab}`);
  if (result.id) expanded.add(result.id);
  if (result.duplicate === 'moved') toast('Already on your wishlist. Moved to Applied with today’s date.');
  else if (result.duplicate) toast(list === 'applied' ? 'Already in Applied. Opened that card.' : 'Already in Wishlist. Opened that card.');
  else toast(requestedList === 'applied' ? 'Added. Applied date set to today.' : 'Saved to wishlist.');
  await refresh(true);
}

const actions = {
  toggle(id) {
    expanded.has(id) ? expanded.delete(id) : expanded.add(id);
    render();
  },

  async add(_id, el) {
    const list = el.dataset.list;
    const key = `paste_${list}`;
    const input = draftValue(key);
    if (!input) return toast('Paste a job link or description first.');
    el.disabled = true;
    let result;
    try {
      result = await api('/api/jobs', { method: 'POST', body: { input, list, source: $('#pasteSource').value } });
    } finally {
      el.disabled = false;
    }
    delete drafts[key];
    await showAddedJob(result, list);
  },

  async addCaptured(_id, el) {
    const list = el.dataset.list;
    el.disabled = true;
    let result;
    try {
      result = await api('/api/jobs', { method: 'POST', body: { input: `${captured.url}\n${captured.text}`, list, source: 'Auto' } });
    } finally {
      el.disabled = false;
    }
    captured = null;
    await showAddedJob(result, list);
  },

  dismissCapture() {
    captured = null;
    render();
  },

  bookmarkletHelp() {
    toast('Drag this button to your bookmarks bar instead of clicking it here.');
  },

  async submitJd(id) {
    const key = `jd_${id}`;
    await api(`/api/jobs/${id}/jd`, { method: 'POST', body: { text: draftValue(key) } });
    delete drafts[key];
    await refresh(true);
  },

  async analyse(id) {
    await api(`/api/jobs/${id}/analyse`, { method: 'POST' });
    await refresh(true);
  },

  async apply(id) {
    await api(`/api/jobs/${id}/apply`, { method: 'POST' });
    toast('Moved to Applied with today’s date.');
    await refresh(true);
  },

  async prep(id) {
    await api(`/api/jobs/${id}/prep`, { method: 'POST' });
    openSections.add(`${id}:prep`);
    toast('Preparing interview tips. Stages appear first, then questions and talking points.');
    await refresh(true);
  },

  toggleSection(id, el) {
    const key = `${id}:${el.dataset.section}`;
    openSections.has(key) ? openSections.delete(key) : openSections.add(key);
    render();
  },

  async addRound(id) {
    const job = state.jobs.find((j) => j.id === id);
    const type = rounds(job).length ? 'Technical' : 'Recruiter call';
    await api(`/api/jobs/${id}/rounds`, { method: 'POST', body: { type, date: today() } });
    await refresh(true);
  },

  async deleteRound(id, el) {
    if (!confirm('Remove this round?')) return;
    await api(`/api/jobs/${id}/rounds/${el.closest('[data-round-id]').dataset.roundId}`, { method: 'DELETE' });
    await refresh(true);
  },

  async check(id, el) {
    el.disabled = true;
    el.textContent = 'Checking…';
    const { result } = await api(`/api/jobs/${id}/check`, { method: 'POST' });
    toast(result === 'open' ? 'Looks like it’s still open.' : result === 'closed' ? 'This posting appears to be closed.' : 'Couldn’t tell. The site may block automated checks.');
    await refresh(true);
  },

  async toggleJd(id) {
    if (jdCache.has(id)) jdCache.delete(id);
    else jdCache.set(id, (await api(`/api/jobs/${id}/jd`)).text);
    render();
  },

  async delete(id) {
    if (!confirm('Delete this job?')) return;
    await api(`/api/jobs/${id}`, { method: 'DELETE' });
    expanded.delete(id);
    await refresh(true);
  },

  async saveCv() {
    const prev = state.cv?.version;
    const cv = await api('/api/cv', { method: 'PUT', body: { text: draftValue('cv_text'), notes: draftValue('cv_notes') } });
    delete drafts.cv_text;
    delete drafts.cv_notes;
    await refresh(true);
    if (cv.version === prev) return toast('No changes to save.');
    toast(`Saved CV v${cv.version}.`);
    if (state.jobs.some((j) => j.details) && confirm('Re-score all your jobs with the new CV? Scores recorded when you applied are kept for the stats.')) {
      await actions.rescoreAll();
    }
  },

  toggleGap(id) {
    gapOpen = gapOpen === id ? null : id;
    render();
  },

  showMoreGaps() {
    gapShowAll = true;
    render();
  },

  async adviseGap(id) {
    toast('Writing a CV line from your experience…');
    const advice = await api(`/api/gaps/${id}/advise`, { method: 'POST' });
    const g = gapData.gaps.find((x) => x.id === id);
    if (g) g.advice = advice;
    gapOpen = id;
    render();
  },

  async dismissGap(id) {
    await api(`/api/gaps/${id}/dismiss`, { method: 'POST', body: { dismissed: true } });
    const g = gapData.gaps.find((x) => x.id === id);
    if (g) g.dismissed = true;
    if (gapOpen === id) gapOpen = null;
    render();
  },

  async restoreGap(_id, el) {
    const id = el.dataset.gap;
    await api(`/api/gaps/${id}/dismiss`, { method: 'POST', body: { dismissed: false } });
    const g = gapData.gaps.find((x) => x.id === id);
    if (g) g.dismissed = false;
    render();
  },

  async copyAdvice(id) {
    const g = gapData.gaps.find((x) => x.id === id);
    if (!g?.advice?.rewrittenLine) return;
    await navigator.clipboard.writeText(g.advice.rewrittenLine);
    toast('Copied. Paste it into My CV, then save and re-score.');
  },

  async rescoreAll() {
    const { queued } = await api('/api/rescore-all', { method: 'POST' });
    toast(queued ? `Re-scoring ${queued} job${queued === 1 ? '' : 's'}…` : 'No jobs to re-score.');
    await refresh(true);
  },

  exportCsv() {
    const cols = ['list', 'status', 'progress', 'company', 'role', 'location', 'workMode', 'salary', 'source', 'savedAt', 'appliedAt', 'deadline', 'priority', 'score', 'scoreWhenApplied', 'cvVersion', 'gotInterview', 'expectedRounds', 'rounds', 'url', 'notes'];
    const row = (j) => ({
      ...j.details,
      ...j,
      progress: progressLabel(j),
      score: j.analysis?.score,
      scoreWhenApplied: j.appliedScore,
      cvVersion: j.appliedCvVersion ?? j.analysis?.cvVersion,
      gotInterview: j.list === 'applied' ? (reachedInterview(j) ? 'yes' : 'no') : '',
      rounds: rounds(j).map((r, i) => `${i + 1}. ${r.type} ${r.date} (${r.result})`).join('; '),
    });
    const cell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const csv = [cols.join(','), ...state.jobs.map((j) => cols.map((c) => cell(row(j)[c])).join(','))].join('\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    a.download = `job-applications-${new Date().toLocaleDateString('en-CA')}.csv`;
    a.click();
  },
};

document.addEventListener('click', async (e) => {
  const tabBtn = e.target.closest('[data-tab]');
  if (tabBtn) {
    tab = tabBtn.dataset.tab;
    location.hash = tab;
    if (tab === 'gaps') {
      const p = loadGaps();
      render();
      return p.then(render).catch((err) => toast(err.message));
    }
    return render();
  }
  const el = e.target.closest('[data-action]');
  if (!el) return;
  if (el.matches('a.bookmarklet')) e.preventDefault();
  if (el.dataset.action === 'toggle' && e.target.closest('button, select, input, textarea, a')) return;
  try {
    await actions[el.dataset.action]?.(el.closest('[data-id]')?.dataset.id, el);
  } catch (err) {
    toast(err.message);
  }
});

document.addEventListener('input', (e) => {
  const el = e.target;
  if (el.dataset.draft) drafts[el.dataset.draft] = el.value;
  if (el.dataset.filter) {
    filters[el.dataset.list][el.dataset.filter] = el.type === 'checkbox' ? (el.checked ? '1' : '') : el.value;
    if (el.dataset.list === 'gaps') {
      if (el.dataset.filter === 'q') return render();
      loadGaps().then(render).catch((err) => toast(err.message));
      return;
    }
    $('#jobs').innerHTML = jobsHtml(el.dataset.list);
  }
});

document.addEventListener('change', async (e) => {
  const el = e.target;
  const id = el.closest('[data-id]')?.dataset.id;
  const roundId = el.closest('[data-round-id]')?.dataset.roundId;
  const { field, roundField } = el.dataset;
  if (!id || !(field || roundField)) return;
  try {
    if (roundField) {
      const wasInterviewing = state.jobs.find((j) => j.id === id)?.status === 'Interview';
      await api(`/api/jobs/${id}/rounds/${roundId}`, { method: 'PATCH', body: { [roundField]: el.value } });
      if (roundField === 'result' && el.value === 'failed' && wasInterviewing) {
        toast('Status set to Rejected. Change it back if they’re still considering you.');
      }
    } else {
      await api(`/api/jobs/${id}`, { method: 'PATCH', body: { [field]: el.value } });
    }
    await refresh(true);
  } catch (err) {
    toast(err.message);
  }
});

document.addEventListener('focusout', () => {
  setTimeout(() => {
    if (pendingRender && !isEditing()) render();
  }, 0);
});

refresh(true).then(() => (tab === 'gaps' ? loadGaps().then(render) : null)).catch((e) => toast(e.message));
setInterval(() => refresh().catch(() => {}), POLL_MS);
