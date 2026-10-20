const URL_RE = /https?:\/\/[^\s<>"')\]]+/i;
const MIN_PAGE_TEXT = 400;
const MAX_JD_TEXT = 15000;
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
const TEMPORARY_STATUSES = new Set([429, 502, 503, 504]);
const LOGIN_STATUSES = new Set([401, 403, 999]);
const LINKEDIN_GAP_MS = 20000;
const DEFAULT_GAP_MS = 3000;
const CLOSED_RE =
  /no longer accepting applications|job is no longer available|this job (?:has )?expired|position has been filled|this job is closed|posting (?:has )?closed|job not found/i;

const SOURCES = [
  ['linkedin.com', 'LinkedIn'],
  ['indeed.', 'Indeed'],
  ['glassdoor.', 'Glassdoor'],
  ['greenhouse.io', 'Greenhouse'],
  ['lever.co', 'Lever'],
  ['ashbyhq.com', 'Ashby'],
  ['myworkdayjobs.com', 'Workday'],
  ['smartrecruiters.com', 'SmartRecruiters'],
  ['wellfound.com', 'Wellfound'],
  ['workable.com', 'Workable'],
];

const ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—',
  lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', hellip: '…', bull: '•',
};

// A URL counts as the job link only on the first or last line; URLs inside a pasted JD are left alone.
export function parseInput(input) {
  const trimmed = input.trim();
  const lines = trimmed.split('\n');
  for (const line of [lines[0], lines.at(-1)]) {
    const m = line?.match(URL_RE);
    if (m) {
      const url = m[0].replace(/[.,;:!?]+$/, '');
      return { url, text: trimmed.replace(m[0], ' ').trim() };
    }
  }
  return { url: '', text: trimmed };
}

export function detectSource(url) {
  if (!url) return 'Other';
  try {
    const host = new URL(url).hostname.replace(/^www\./, '');
    return SOURCES.find(([needle]) => host.includes(needle))?.[1] || host;
  } catch {
    return 'Other';
  }
}

export function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] !== '#') return ENTITIES[e.toLowerCase()] ?? m;
    const code = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    try {
      return String.fromCodePoint(code);
    } catch {
      return m;
    }
  });
}

export function htmlToText(html) {
  return decodeEntities(
    html
      .replace(/<(script|style|noscript|svg|head)[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<li[^>]*>/gi, '\n- ')
      .replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr|\/ul|\/ol|\/section)[^>]*>/gi, '\n')
      .replace(/<[^>]+>/g, ' '),
  )
    .replace(/[ \t\f\v\u00a0]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function formatSalary(s) {
  const v = s.value || {};
  const range = v.minValue && v.maxValue ? `${v.minValue}–${v.maxValue}` : v.value ?? v.minValue ?? '';
  return [s.currency, range, v.unitText && `per ${String(v.unitText).toLowerCase()}`].filter(Boolean).join(' ');
}

function jobPostingFromJsonLd(html) {
  for (const [, raw] of html.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    let data;
    try {
      data = JSON.parse(raw.trim());
    } catch {
      continue;
    }
    const items = [data].flat().flatMap((d) => d?.['@graph'] ?? [d]);
    const p = items.find((d) => [d?.['@type']].flat().includes('JobPosting'));
    if (!p) continue;

    const location = [p.jobLocation].flat().filter(Boolean)
      .map((l) => {
        const a = l.address || {};
        return [a.addressLocality, a.addressRegion, a.addressCountry?.name ?? a.addressCountry].filter(Boolean).join(', ');
      })
      .filter(Boolean)
      .join(' / ');

    return [
      p.title && `Title: ${p.title}`,
      p.hiringOrganization?.name && `Company: ${p.hiringOrganization.name}`,
      location && `Location: ${location}`,
      p.jobLocationType && `Location type: ${p.jobLocationType}`,
      p.employmentType && `Employment type: ${[p.employmentType].flat().join(', ')}`,
      p.baseSalary && `Salary: ${formatSalary(p.baseSalary)}`,
      '',
      htmlToText(decodeEntities(p.description || '')),
    ].filter((line) => line || line === '').join('\n');
  }
  return null;
}

export function linkedInJobId(url) {
  return String(url || '').match(/linkedin\.com\/.*?(?:jobs\/view\/(?:[^/?#]*?-)?|currentJobId=)(\d{6,})/)?.[1] || null;
}

export function canonicalJobUrl(url) {
  if (!url) return '';
  try {
    const u = new URL(url);
    u.hash = '';
    u.hostname = u.hostname.replace(/^www\./, '');
    for (const key of [...u.searchParams.keys()]) {
      if (/^(utm_|trk|refId|trackingId|lipi|licu|eBP|originalSubdomain|original_referer)/i.test(key) || key === 'ref') {
        u.searchParams.delete(key);
      }
    }
    const path = u.pathname.replace(/\/+$/, '') || '/';
    const query = u.searchParams.toString();
    return `${u.protocol}//${u.hostname}${path}${query ? `?${query}` : ''}`;
  } catch {
    return String(url).trim();
  }
}

export function isSameJobUrl(a, b) {
  if (!a || !b) return false;
  if (canonicalJobUrl(a) === canonicalJobUrl(b)) return true;
  const idA = linkedInJobId(a);
  const idB = linkedInJobId(b);
  return Boolean(idA && idB && idA === idB);
}

// The guest endpoint and the public job page are rate-limited separately, so one can work while the other returns 429.
function linkedInUrls(id) {
  return [
    `https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/${id}`,
    `https://www.linkedin.com/jobs/view/${id}/`,
  ];
}

function firstMatch(html, re) {
  const m = html.match(re);
  return m ? htmlToText(m[1]).replace(/\s+/g, ' ').trim() : '';
}

// Both LinkedIn pages share the same top-card and description markup.
function linkedInText(html) {
  const start = html.indexOf('show-more-less-html__markup');
  if (start < 0) return null;
  const open = html.indexOf('>', start) + 1;
  const end = html.indexOf('show-more-less-html__button', open);
  const description = htmlToText(html.slice(open, end > 0 ? end : undefined).replace(/<\/div>\s*<button[^>]*$/i, ''));
  const criteria = html.match(/<ul class="description__job-criteria-list[\s\S]*?<\/ul>/)?.[0];

  return [
    `Title: ${firstMatch(html, /<h[12][^>]*top-card-layout__title[^>]*>([\s\S]*?)<\/h[12]>/)}`,
    `Company: ${firstMatch(html, /<a[^>]*topcard__org-name-link[^>]*>([\s\S]*?)<\/a>/)}`,
    `Location: ${firstMatch(html, /<span class="topcard__flavor topcard__flavor--bullet"[^>]*>([\s\S]*?)<\/span>/)}`,
    criteria ? htmlToText(criteria) : '',
    '',
    description,
  ].join('\n').trim();
}

function retryAfterMs(header) {
  if (!header) return null;
  const secs = Number(header);
  if (Number.isFinite(secs)) return secs * 1000;
  const at = Date.parse(header);
  return Number.isNaN(at) ? null : Math.max(0, at - Date.now());
}

const lastRequestAt = new Map();

// LinkedIn rate-limits quickly (HTTP 429), so requests to the same site are spaced out.
async function waitForTurn(url) {
  const host = new URL(url).hostname.replace(/^www\./, '');
  const key = host.endsWith('linkedin.com') ? 'linkedin.com' : host;
  const gap = key === 'linkedin.com' ? LINKEDIN_GAP_MS : DEFAULT_GAP_MS;
  const wait = (lastRequestAt.get(key) || 0) + gap - Date.now();
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
  lastRequestAt.set(key, Date.now());
}

async function getPage(url) {
  await waitForTurn(url);
  const res = await fetch(url, {
    headers: {
      'User-Agent': USER_AGENT,
      Accept: 'text/html,application/xhtml+xml',
      'Accept-Language': 'en-US,en;q=0.9',
    },
    redirect: 'follow',
    signal: AbortSignal.timeout(15000),
  });
  return {
    status: res.status,
    finalUrl: res.url,
    retryAfterMs: retryAfterMs(res.headers.get('retry-after')),
    html: await res.text(),
  };
}

async function fetchLinkedIn(id) {
  let last = null;
  for (const pageUrl of linkedInUrls(id)) {
    let page;
    try {
      page = await getPage(pageUrl);
    } catch (e) {
      last = { ok: false, temporary: true, reason: `Couldn't load the page from LinkedIn (${e.name === 'TimeoutError' ? 'timed out' : e.message}).` };
      continue;
    }
    if (page.status === 404 || page.status === 410) {
      return { ok: false, reason: 'LinkedIn says this job no longer exists. The posting may have been removed.' };
    }
    if (page.status === 429 || TEMPORARY_STATUSES.has(page.status)) {
      last = {
        ok: false,
        temporary: true,
        retryAfterMs: page.retryAfterMs,
        reason: `LinkedIn is limiting requests from your connection right now (HTTP ${page.status}). This usually clears within 5–30 minutes.`,
      };
      continue;
    }
    const text = page.status < 400 ? linkedInText(page.html) : null;
    if (text && text.length >= MIN_PAGE_TEXT) return { ok: true, text: text.slice(0, MAX_JD_TEXT) };
    last = { ok: false, reason: `LinkedIn returned a page without the job description (HTTP ${page.status}).` };
  }
  return last;
}

export async function fetchJobText(url) {
  if (!url) return { ok: false, reason: 'No job link or job description was given.' };

  const linkedInId = linkedInJobId(url);
  if (linkedInId) return fetchLinkedIn(linkedInId);

  const site = detectSource(url);
  let page;
  try {
    page = await getPage(url);
  } catch (e) {
    return { ok: false, temporary: true, reason: `Couldn't load the page from ${site} (${e.name === 'TimeoutError' ? 'timed out' : e.message}).` };
  }

  if (page.status === 429) {
    return { ok: false, temporary: true, retryAfterMs: page.retryAfterMs, reason: `${site} is limiting requests right now (HTTP 429). This is usually temporary.` };
  }
  if (TEMPORARY_STATUSES.has(page.status)) {
    return { ok: false, temporary: true, reason: `${site} had a temporary error (HTTP ${page.status}).` };
  }
  if (LOGIN_STATUSES.has(page.status)) {
    return { ok: false, reason: `${site} requires a login or blocks automated access (HTTP ${page.status}).` };
  }
  if (page.status >= 400) {
    return { ok: false, reason: `${site} returned HTTP ${page.status}. The posting may have been removed.` };
  }
  if (/\/(authwall|login|signin|uas\/login)/i.test(new URL(page.finalUrl).pathname)) {
    return { ok: false, reason: 'The site redirected to a login page.' };
  }

  const fromJsonLd = jobPostingFromJsonLd(page.html);
  const text = fromJsonLd && fromJsonLd.length >= MIN_PAGE_TEXT ? fromJsonLd : htmlToText(page.html);
  if (text.length < MIN_PAGE_TEXT) {
    return { ok: false, reason: 'The page had almost no text. It probably needs a login or loads the job with JavaScript.' };
  }
  return { ok: true, text: text.slice(0, MAX_JD_TEXT) };
}

export async function checkStillOpen(url) {
  const linkedInId = linkedInJobId(url);
  try {
    const page = await getPage(linkedInId ? linkedInUrls(linkedInId)[0] : url);
    if (page.status === 404 || page.status === 410) return 'closed';
    if (page.status >= 400) return 'unknown';
    const text = htmlToText(page.html);
    if (CLOSED_RE.test(text)) return 'closed';
    return text.length >= MIN_PAGE_TEXT ? 'open' : 'unknown';
  } catch {
    return 'unknown';
  }
}
