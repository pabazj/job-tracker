// Writes a database of fictional jobs and a fictional CV, for screenshots and trying the app.
// Usage: node scripts/demo-data.js /tmp/jt-demo/db.json && DB_FILE=/tmp/jt-demo/db.json PORT=3001 npm start
import fs from 'node:fs';
import path from 'node:path';
import { computeScore } from '../scoring.js';

const out = process.argv[2];
if (!out) {
  console.error('Usage: node scripts/demo-data.js <path/to/db.json>');
  process.exit(1);
}

const MODEL = 'qwen2.5:7b';
const day = (offset) => new Date(Date.UTC(2026, 9, 14 + offset, 14)).toISOString();
const date = (offset) => day(offset).slice(0, 10);
let nextId = 1;
const id = () => `demo${nextId++}`;

const CV = `ALEX MORGAN
Software Engineer · alex.morgan@example.com

EXPERIENCE
Northwind Software, Senior Frontend Engineer (Jan 2022 - Present)
Technologies: React, TypeScript, Next.js, GraphQL, Jest, Playwright, AWS
- Led the rebuild of the customer dashboard in React and TypeScript, cutting load time by 40%.
- Introduced a component library used by 6 product teams.
- Mentored 3 junior engineers and ran the frontend guild.

Brightline Apps, Full-stack Developer (Jun 2019 - Dec 2021)
Technologies: Node.js, Express, PostgreSQL, React, Docker
- Built REST and GraphQL APIs serving 2M requests a day.
- Owned the billing integration with Stripe.

SKILLS
React, TypeScript, JavaScript, Next.js, Node.js, GraphQL, PostgreSQL, Docker, AWS, Jest, Playwright`;

const req = (requirement, match, evidence = '') => ({ requirement, match, evidence });

function job({ list, status = 'Applied', company, role, location, workMode, salary, seniority, yearsRequired, domain, summary,
  mustHave, niceToHave, fits, missing = [], suggestions = [], verdict, saved, applied, rounds = [], expectedRounds = '', prep = null,
  priority = 'Medium', deadline = '', notes = '' }) {
  const details = {
    company, role, location, workMode, salary, seniority, yearsRequired, domain, summary,
    mustHave: mustHave.map((r) => r.requirement), niceToHave: niceToHave.map((r) => r.requirement),
  };
  const assessment = { mustHave, niceToHave, candidateYears: 7.3, ...fits };
  const { score, breakdown } = computeScore(details, assessment);
  const isApplied = list === 'applied';
  const slug = `${company}-${role}`.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  return {
    id: id(),
    list,
    status: isApplied ? status : 'Applied',
    url: `https://jobs.example.com/${slug}`,
    source: ['LinkedIn', 'Indeed', 'Company site', 'Greenhouse'][nextId % 4],
    jdText: `${role} at ${company}\n\n${summary}\n\nRequirements:\n${details.mustHave.map((m) => `- ${m}`).join('\n')}`,
    jdOrigin: 'pasted',
    savedAt: day(saved),
    appliedAt: isApplied ? date(applied) : '',
    deadline,
    priority,
    notes,
    details,
    analysis: {
      score, breakdown, mustHave, niceToHave, candidateYears: 7.3, missingKeywords: missing, suggestions, verdict,
      cvVersion: 1, model: MODEL, scoredAt: day(saved),
    },
    appliedScore: isApplied ? score : null,
    appliedCvVersion: isApplied ? 1 : null,
    openCheck: null,
    createdAt: day(saved),
    state: 'ready',
    error: null,
    reason: null,
    rounds: rounds.map((r) => ({ id: id(), notes: '', ...r })),
    expectedRounds,
    reachedInterview: rounds.length > 0,
    prep,
    prepState: prep ? 'ready' : null,
    prepError: null,
  };
}

const goodFit = { seniorityFit: 'match', locationFit: 'ok', domainFit: 'strong' };

const jobs = [
  job({
    list: 'applied', status: 'Interview', company: 'Lumen Labs', role: 'Senior Frontend Engineer',
    location: 'Remote (EU)', workMode: 'remote', salary: '€85,000 – €100,000', seniority: 'Senior', yearsRequired: 5, domain: 'Developer tools',
    summary: 'Build the web IDE used by 200k developers. You will own performance and the design system.',
    mustHave: [req('React', 'yes', 'Led the rebuild of the customer dashboard in React'), req('TypeScript', 'yes', 'React and TypeScript'),
      req('Web performance', 'yes', 'cutting load time by 40%'), req('Design systems', 'yes', 'component library used by 6 product teams'),
      req('Testing (Jest or Playwright)', 'yes', 'Jest, Playwright')],
    niceToHave: [req('Monaco or CodeMirror', 'no'), req('WebAssembly', 'no'), req('Mentoring', 'yes', 'Mentored 3 junior engineers')],
    fits: goodFit, missing: ['Monaco', 'WebAssembly'],
    suggestions: ['Mention any editor or IDE-like UI work, even side projects.', 'Quantify the design system adoption beyond team count.'],
    verdict: 'Strong match on every must-have. The gaps are only in nice-to-haves, so the CV is not the issue if this one is rejected.',
    saved: -12, applied: -11, expectedRounds: '4',
    rounds: [
      { type: 'Recruiter call', date: date(-8), result: 'passed', notes: 'Friendly, asked about notice period.' },
      { type: 'Technical', date: date(-3), result: 'passed', notes: 'Built a debounced search in React.' },
      { type: 'System design', date: date(2), result: 'pending', notes: '' },
    ],
    prep: {
      processFromJd: true, partial: false, forRound: 'System design', roundNumber: 3, model: MODEL, generatedAt: day(-2),
      stages: [
        { name: 'Recruiter call', format: '30 min video', focus: 'Motivation, logistics', tips: ['Have your salary range ready.'] },
        { name: 'Technical', format: '60 min live coding', focus: 'React and TypeScript fundamentals', tips: ['Talk through trade-offs as you code.'] },
        { name: 'System design', format: '60 min whiteboard', focus: 'Frontend architecture at scale', tips: ['Cover state management, caching and performance budgets.', 'Draw the data flow before the components.'] },
        { name: 'Team fit', format: '45 min with the team', focus: 'Collaboration and ownership', tips: ['Prepare a story about disagreeing with a design decision.'] },
      ],
      nextRoundTips: ['Design a collaborative editor: think about real-time sync and conflict handling.', 'Bring numbers from the dashboard rebuild.'],
      likelyQuestions: [
        { question: 'How would you keep a large editor UI fast?', why: 'Performance ownership is in the JD.', answerHint: 'Virtualisation, memoisation, measuring with performance budgets; cite the 40% load-time win.' },
        { question: 'How do you roll out a design system across teams?', why: 'They mention owning the design system.', answerHint: 'Talk about the library used by 6 teams: versioning, docs, migration support.' },
      ],
      talkingPoints: [{ requirement: 'Web performance', story: 'Dashboard rebuild: profiling, code-splitting, 40% faster load.' }],
      gaps: [{ gap: 'No Monaco or CodeMirror experience', howToAnswer: 'Explain how you would ramp up, and relate it to complex form and table UIs you built.' }],
      whyThisRole: 'You enjoy building tools for developers and have led the kind of performance and design-system work this role owns.',
      questionsToAsk: ['How do you measure editor performance today?', 'Who owns the design system now?'],
      generalTips: ['Keep answers to about two minutes.', 'Ask clarifying questions before designing.'],
    },
  }),
  job({
    list: 'applied', status: 'Offer', company: 'Orbit Pay', role: 'Full Stack Engineer',
    location: 'Amsterdam, Netherlands', workMode: 'hybrid', salary: '€75,000 – €90,000', seniority: 'Mid-Senior', yearsRequired: 4, domain: 'Fintech',
    summary: 'Work across the payments dashboard and the Node.js services behind it.',
    mustHave: [req('Node.js', 'yes', 'Built REST and GraphQL APIs'), req('React', 'yes', 'React'), req('PostgreSQL', 'yes', 'PostgreSQL'), req('Payments experience', 'yes', 'billing integration with Stripe')],
    niceToHave: [req('Kafka', 'no'), req('Kubernetes', 'partial', 'Docker')],
    fits: goodFit, missing: ['Kafka'], verdict: 'Very strong fit, including payments experience.',
    saved: -30, applied: -29, expectedRounds: '3',
    rounds: [
      { type: 'Recruiter call', date: date(-25), result: 'passed' },
      { type: 'Coding test / take-home', date: date(-20), result: 'passed' },
      { type: 'Final', date: date(-12), result: 'passed' },
    ],
  }),
  job({
    list: 'applied', status: 'Rejected', company: 'Harbor Health', role: 'Senior Software Engineer',
    location: 'London, UK', workMode: 'hybrid', salary: '£80,000 – £95,000', seniority: 'Senior', yearsRequired: 6, domain: 'Healthcare',
    summary: 'Build clinician-facing web apps with strict accessibility and compliance needs.',
    mustHave: [req('React', 'yes', 'React'), req('TypeScript', 'yes', 'TypeScript'), req('Accessibility (WCAG)', 'no'), req('HIPAA or healthcare compliance', 'no')],
    niceToHave: [req('FHIR', 'no')],
    fits: { seniorityFit: 'match', locationFit: 'ok', domainFit: 'none' }, missing: ['WCAG', 'HIPAA', 'FHIR'],
    suggestions: ['Add any accessibility work you have done, with the standard you met.'],
    verdict: 'Good technical match, but missing the healthcare and accessibility requirements.',
    saved: -26, applied: -25, expectedRounds: '4',
    rounds: [{ type: 'Recruiter call', date: date(-20), result: 'passed' }, { type: 'Technical', date: date(-14), result: 'failed', notes: 'Accessibility deep-dive questions.' }],
  }),
  job({
    list: 'applied', status: 'Rejected', company: 'Quill Analytics', role: 'Frontend Engineer',
    location: 'Berlin, Germany', workMode: 'onsite', salary: '', seniority: 'Mid', yearsRequired: 3, domain: 'Data visualisation',
    summary: 'Build charting and dashboard features for analytics customers.',
    mustHave: [req('React', 'yes', 'React'), req('D3.js', 'no'), req('Data visualisation', 'partial', 'customer dashboard')],
    niceToHave: [req('WebGL', 'no')],
    fits: { seniorityFit: 'over', locationFit: 'ok', domainFit: 'some' }, missing: ['D3.js', 'WebGL'],
    verdict: 'Partial match: strong React, but no D3 or charting experience on the CV.',
    saved: -20, applied: -19,
  }),
  job({
    list: 'applied', status: 'Ghosted', company: 'Fernway Travel', role: 'Senior React Developer',
    location: 'Remote', workMode: 'remote', salary: '$120,000 – $140,000', seniority: 'Senior', yearsRequired: 5, domain: 'Travel',
    summary: 'Own the booking flow front end.',
    mustHave: [req('React', 'yes', 'React'), req('TypeScript', 'yes', 'TypeScript'), req('A/B testing', 'partial', 'dashboard rebuild')],
    niceToHave: [], fits: { seniorityFit: 'match', locationFit: 'unclear', domainFit: 'some' },
    verdict: 'Good match; location eligibility is unclear.', saved: -40, applied: -38,
  }),
  job({
    list: 'applied', status: 'Applied', company: 'Cobalt Cloud', role: 'Platform Engineer',
    location: 'Dublin, Ireland', workMode: 'hybrid', salary: '€70,000 – €85,000', seniority: 'Mid-Senior', yearsRequired: 4, domain: 'Cloud infrastructure',
    summary: 'Build internal developer platform tooling on AWS.',
    mustHave: [req('AWS', 'yes', 'AWS'), req('Terraform', 'no'), req('Node.js or Go', 'yes', 'Node.js'), req('CI/CD', 'partial', 'Docker')],
    niceToHave: [req('Kubernetes', 'no')], fits: { seniorityFit: 'match', locationFit: 'ok', domainFit: 'some' },
    missing: ['Terraform', 'Kubernetes'], verdict: 'Moderate fit; infrastructure-as-code is the main gap.', saved: -2, applied: -2,
  }),
  job({
    list: 'wishlist', company: 'Pinecrest Studio', role: 'Senior Frontend Engineer, Design Systems',
    location: 'Remote (Europe)', workMode: 'remote', salary: '€90,000 – €105,000', seniority: 'Senior', yearsRequired: 5, domain: 'Design tools',
    summary: 'Lead the design system powering a collaborative design tool.',
    mustHave: [req('React', 'yes', 'React'), req('TypeScript', 'yes', 'TypeScript'), req('Design systems', 'yes', 'component library used by 6 product teams'), req('Storybook', 'no')],
    niceToHave: [req('Figma plugins', 'no')], fits: goodFit, missing: ['Storybook', 'Figma'],
    suggestions: ['Name the tool you used to document the component library (Storybook or similar).'],
    verdict: 'Excellent match; worth applying soon.', saved: -1, priority: 'High', deadline: date(5),
  }),
  job({
    list: 'wishlist', company: 'Atlas Mobility', role: 'Software Engineer, Web',
    location: 'Munich, Germany', workMode: 'hybrid', salary: '€70,000 – €80,000', seniority: 'Mid', yearsRequired: 3, domain: 'Mobility',
    summary: 'Build the fleet operations web app.',
    mustHave: [req('React', 'yes', 'React'), req('GraphQL', 'yes', 'GraphQL'), req('Maps (Mapbox or Leaflet)', 'no')],
    niceToHave: [req('German (B1)', 'no')], fits: { seniorityFit: 'over', locationFit: 'ok', domainFit: 'none' },
    missing: ['Mapbox', 'German'], verdict: 'Good technical match; slightly junior for your level.', saved: -4,
  }),
  job({
    list: 'wishlist', company: 'Nimbus Health', role: 'Staff Engineer',
    location: 'New York, USA', workMode: 'onsite', salary: '$200,000 – $230,000', seniority: 'Staff', yearsRequired: 10, domain: 'Healthcare',
    summary: 'Set technical direction for the patient platform.',
    mustHave: [req('10+ years of experience', 'no'), req('Distributed systems', 'partial', 'APIs serving 2M requests a day'), req('Technical leadership', 'partial', 'ran the frontend guild')],
    niceToHave: [], fits: { seniorityFit: 'under', locationFit: 'blocked', domainFit: 'none' },
    verdict: 'Requires US work authorisation and more seniority. Low chance.', saved: -6, priority: 'Low',
  }),
];

const db = { jobs, cvVersions: [{ version: 1, text: CV, notes: 'Based in Berlin. EU citizen. Open to remote or hybrid frontend and full-stack roles.', createdAt: day(-45) }] };

fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify(db, null, 2));
console.log(`Wrote ${jobs.length} demo jobs to ${out}`);
