/**
 * Demo seed. Builds realistic state by running the REAL commands through the real event pipeline
 * (no direct inserts into another context's tables), on a manual clock that starts 45 days ago — so
 * the audit trail, due dates and deadlines look like a programme that has been running for weeks.
 *
 *   node src/seed.ts --reset     (npm run seed)   wipes data/quorum.sqlite and reseeds
 */
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { createDeps } from './app.ts';
import { ManualClock, DAY_MS } from './platform/clock.ts';
import { openDb } from './platform/db.ts';
import { AGENT_ACTOR, type Deps } from './platform/deps.ts';
import { provisionAccount, recordOrcidVerification } from './contexts/identity/service.ts';
import { publishCall, closeCall } from './contexts/calls/service.ts';
import { createDraft, submitProposal, confirmEligibility, withdrawProposal } from './contexts/submission/service.ts';
import { TriageRunner } from './contexts/submission/triage.ts';
import { assignReviewer, acceptAssignment, submitReview } from './contexts/peer-review/service.ts';
import { sweepOverdue } from './contexts/peer-review/review-deadline.ts';
import { recordDecision } from './contexts/adjudication/service.ts';
import { sweepEscalations } from './contexts/adjudication/panel-decision.ts';
import { drainOutbound } from './contexts/notification/service.ts';

export const DEMO_PASSWORD = 'quorum-demo-2026';

export const DEMO_ACCOUNTS = {
  officer: { email: 'officer@quorum.test', name: 'Dr. Amara Okafor', institution: 'Northern Research Council' },
  chair: { email: 'chair@quorum.test', name: 'Prof. Henrik Lindqvist', institution: 'Northern Research Council (Panel)' },
  priya: { email: 'priya.raman@quorum.test', name: 'Dr. Priya Raman', institution: 'University of Toronto' },
  mateo: { email: 'mateo.alvarez@quorum.test', name: 'Dr. Mateo Alvarez', institution: 'McGill University' },
  sarah: { email: 'sarah.chen@quorum.test', name: 'Dr. Sarah Chen', institution: 'University of British Columbia' },
  kwame: { email: 'kwame.mensah@quorum.test', name: 'Dr. Kwame Mensah', institution: 'Dalhousie University' },
  elena: { email: 'elena.petrova@quorum.test', name: 'Dr. Elena Petrova', institution: 'University of Waterloo' },
  liam: { email: 'liam.oconnor@quorum.test', name: "Dr. Liam O'Connor", institution: 'University of Calgary' },
  hannah: { email: 'hannah.weiss@quorum.test', name: 'Dr. Hannah Weiss', institution: 'ETH Zürich', orcid: '0000-0002-1825-0097' },
  david: { email: 'david.kim@quorum.test', name: 'Prof. David Kim', institution: 'University of Michigan', orcid: '0000-0001-5109-3700' },
  fatima: { email: 'fatima.alsayed@quorum.test', name: 'Dr. Fatima Al-Sayed', institution: 'Imperial College London', orcid: '0000-0002-1694-233X' },
  jonas: { email: 'jonas.berg@quorum.test', name: 'Dr. Jonas Berg', institution: 'Karolinska Institutet', orcid: '0000-0003-4500-7711' },
  grace: { email: 'grace.liu@quorum.test', name: 'Dr. Grace Liu', institution: 'University of Toronto', orcid: '0000-0001-7542-0286' },
  aisha: { email: 'aisha.bello@quorum.test', name: 'Dr. Aisha Bello', institution: 'University of Cape Town', orcid: '0000-0002-9079-593X' },
  marc: { email: 'marc.dubois@quorum.test', name: 'Prof. Marc Dubois', institution: 'Sorbonne Université', orcid: null },
} as const;

const ABSTRACTS = {
  permafrost:
    'Thawing permafrost is destabilising roads, water lines and building foundations across Nunavut and the Northwest Territories, yet communities learn of ground failure only after damage occurs. We propose a community-operated early-warning network that combines low-cost ground temperature sensors, InSAR satellite deformation data and Inuit knowledge of land change. Over three years we will co-design the network with four hamlets, validate a thaw-risk model against field observations, and hand over dashboards and maintenance training so that infrastructure decisions are made months, not days, ahead of failure. The project directly strengthens climate resilience in northern communities.',
  wildfire:
    'Wildfire smoke now reaches northern communities for weeks each summer, but local air quality monitoring is sparse and health advisories arrive late. This project deploys a calibrated network of low-cost particulate sensors in twelve remote communities in northern Quebec, links them to a forecasting model driven by satellite fire detections, and works with community health workers to translate forecasts into practical guidance. We will measure the effect of timely advisories on clinic visits and evaluate how the network can be sustained locally after the grant. Outcomes include open data, a forecasting service and a community resilience playbook for climate-driven smoke events.',
  coastal:
    'Coastal erosion threatens northern communities on the Labrador coast. We will map erosion hotspots using drone surveys and community observations, and share the maps with local planners. Further detail on methods and partners will follow.',
  energy:
    'Diesel generation supplies most electricity in remote northern communities and is exposed to fuel supply shocks that climate change makes more frequent. We will evaluate hybrid microgrids combining wind, solar and battery storage in three Nunavik communities, using two years of measured load data to size systems that maintain reliability through extreme cold and storm events. The project pairs engineering modelling with community workshops on ownership and maintenance, and will produce an open design toolkit that other northern communities can use to plan resilient, lower-emission energy systems with local benefit and local control of critical infrastructure.',
  quantum:
    'We will develop a scalable colloidal synthesis route for cadmium-free quantum dots with narrow emission linewidths, targeting next-generation display panels. The work focuses on shell engineering to suppress blinking, ligand exchange chemistry for device integration, and accelerated lifetime testing under high photon flux. Industrial partners will evaluate prototype films in display stacks, and we will publish an open dataset of synthesis conditions and optical properties to support machine-learning-guided materials discovery in optoelectronic manufacturing.',
  sepsis:
    'Sepsis kills more patients in Canadian hospitals than any single cancer, and earlier recognition saves lives. We will build and prospectively validate a federated early-warning model for sepsis using routinely collected vital signs and laboratory data across five hospitals, without moving patient data off site. The project addresses dataset shift between sites, calibrates alerts to limit alarm fatigue, and evaluates the model silently for six months before any clinical use. Deliverables include an open federated learning pipeline, a validated health data science model and a governance framework for multi-site clinical machine learning.',
  diabetes:
    'Rural patients with type 2 diabetes have worse outcomes than urban patients, partly because care gaps are invisible until complications appear. Using linked administrative health data for 1.2 million residents, we will develop interpretable risk models that identify patients at highest risk of preventable hospitalisation and test whether outreach guided by those models improves follow-up. The project combines health data science, rural health services research and patient partners to ensure the models are fair across communities and usable by primary care teams.',
  wearables:
    'Consumer wearables generate continuous heart rate and activity data that could detect atrial fibrillation early, but most algorithms are validated on young, healthy volunteers. We will assemble a diverse validation cohort of 3,000 older adults, compare commercial and open algorithms against clinical ECG, and publish a reproducible benchmark. The work will inform how health data science can responsibly use wearable signals in screening programmes and identify where algorithmic performance differs by age, sex and skin tone.',
  imaging:
    'Chest imaging reports contain rich information that is rarely reused for research because it is locked in free text. We will develop privacy-preserving natural language processing that extracts structured findings from radiology reports across three health regions, evaluate it against expert annotation, and release a de-identified benchmark corpus. The resulting data science tools will support population health surveillance of respiratory disease.',
  pediatric:
    'Paediatric emergency departments face unpredictable surges driven by respiratory viruses. We will build short-term demand forecasts from syndromic surveillance, school absenteeism and weather data, and evaluate them in partnership with two children’s hospitals. Health data science methods for probabilistic forecasting will be adapted for operational staffing decisions.',
};

type Ids = Record<keyof typeof DEMO_ACCOUNTS, string>;

export async function seed(deps: Deps, clock: ManualClock): Promise<void> {
  const tx = <T>(fn: () => T): T => deps.db.transaction(fn).immediate();
  const runner = new TriageRunner(deps);
  const settle = async () => {
    for (let i = 0; i < 20; i++) {
      let n = deps.bus.drain();
      n += await runner.runOnce();
      n += deps.bus.drain();
      if (n === 0) break;
    }
  };
  const realNow = Date.now();
  const at = (daysFromNow: number) => clock.set(new Date(realNow + daysFromNow * DAY_MS));

  // ---------------------------------------------------------------- accounts (administrative provisioning)
  at(-60);
  const ids = {} as Ids;
  tx(() => {
    for (const [key, a] of Object.entries(DEMO_ACCOUNTS) as Array<[keyof typeof DEMO_ACCOUNTS, (typeof DEMO_ACCOUNTS)[keyof typeof DEMO_ACCOUNTS]]>) {
      const roles =
        key === 'officer' ? (['programOfficer'] as const) : key === 'chair' ? (['panelChair'] as const) : 'orcid' in a ? (['reviewer'] as const) : key === 'sarah' ? (['applicant', 'reviewer'] as const) : (['applicant'] as const);
      ids[key] = provisionAccount(deps, { email: a.email, name: a.name, institution: a.institution, password: DEMO_PASSWORD, roles: [...roles] });
    }
    provisionAccount(deps, { id: AGENT_ACTOR, kind: 'agent', email: 'eligibility-triage@agents.quorum.local', name: 'Eligibility triage agent', institution: 'Quorum', roles: [] });
  });
  // ORCID verification through the real command path (the stub registry answers "exists").
  for (const k of ['hannah', 'david', 'fatima', 'jonas', 'grace', 'aisha'] as const) {
    const orcid = (DEMO_ACCOUNTS[k] as { orcid: string }).orcid;
    tx(() => recordOrcidVerification(deps, ids[k], orcid, true));
  }
  // Sarah is an applicant AND a reviewer — the INV-4 case; verified so only self-review stops her.
  tx(() => recordOrcidVerification(deps, ids.sarah, '0000-0003-1415-9265', true));

  // ---------------------------------------------------------------- calls
  at(-50);
  const health = tx(() =>
    publishCall(deps, ids.officer, {
      title: 'Health Data Science Seed Grants 2026',
      summary: 'Seed funding for health data science projects that turn routinely collected clinical and population data into better, fairer care. Projects must involve data from Canadian health systems and a plan for responsible, privacy-preserving use.',
      deadline: new Date(realNow - 30 * DAY_MS).toISOString(),
      envelope: 300_000,
      maxRequest: 150_000,
      criteria: [
        { name: 'Scientific merit', guidance: 'Is the question important and the method rigorous?' },
        { name: 'Data access and governance', guidance: 'Is access to the data realistic, lawful and privacy-preserving?' },
        { name: 'Team and feasibility', guidance: 'Can this team deliver the plan within the budget and time?' },
        { name: 'Health impact', guidance: 'How plausibly will results change care or policy?' },
      ],
    }),
  );
  at(-45);
  const climate = tx(() =>
    publishCall(deps, ids.officer, {
      title: 'Climate Resilience in Northern Communities 2027',
      summary: 'Research that helps northern and remote communities anticipate, withstand and recover from climate-driven hazards — permafrost thaw, wildfire smoke, coastal erosion and energy insecurity — co-designed with the communities affected.',
      deadline: new Date(realNow + 18 * DAY_MS + 17 * 3600_000).toISOString(),
      envelope: 1_200_000,
      maxRequest: 400_000,
      criteria: [
        { name: 'Scientific excellence', guidance: 'Originality, rigour and clarity of the research design.' },
        { name: 'Community partnership', guidance: 'Are communities co-designers with real decision-making power?' },
        { name: 'Feasibility and team', guidance: 'Is the plan realistic for this team, timeline and budget?' },
        { name: 'Resilience impact', guidance: 'Will results measurably improve resilience, and be sustained after the grant?' },
        { name: 'Value for money', guidance: 'Is the requested amount justified by the planned work?' },
      ],
    }),
  );
  await settle();

  // ---------------------------------------------------------------- health call: full cycle through to decisions
  const healthProposals: Array<{ who: keyof Ids; title: string; abstract: string; amount: number }> = [
    { who: 'kwame', title: 'Federated early warning for sepsis across five hospitals', abstract: ABSTRACTS.sepsis, amount: 150_000 },
    { who: 'elena', title: 'Fair risk models for rural type 2 diabetes care', abstract: ABSTRACTS.diabetes, amount: 120_000 },
    { who: 'mateo', title: 'A diverse benchmark for wearable atrial fibrillation detection', abstract: ABSTRACTS.wearables, amount: 140_000 },
    { who: 'liam', title: 'Structured findings from chest imaging reports at scale', abstract: ABSTRACTS.imaging, amount: 95_000 },
    { who: 'sarah', title: 'Forecasting paediatric emergency demand from surveillance data', abstract: ABSTRACTS.pediatric, amount: 80_000 },
  ];
  at(-44);
  const hp: string[] = [];
  for (const p of healthProposals) {
    clock.advance(6 * 3600_000);
    const d = tx(() => createDraft(deps, ids[p.who], { callId: health.id, title: p.title, abstract: p.abstract, requested: p.amount }));
    clock.advance(2 * DAY_MS);
    tx(() => submitProposal(deps, { accountId: ids[p.who], name: DEMO_ACCOUNTS[p.who].name }, d.id));
    hp.push(d.id);
  }
  await settle();
  at(-28);
  for (const id of hp.slice(0, 4)) tx(() => confirmEligibility(deps, ids.officer, id, 'eligible', 'Within scope; data access letters are in place.'));
  tx(() => withdrawProposal(deps, ids.sarah, hp[4]!, 'Our hospital partner withdrew access to the surveillance feed.'));
  await settle();

  const panels: Record<number, Array<keyof Ids>> = {
    0: ['hannah', 'david', 'fatima'],
    1: ['jonas', 'aisha', 'hannah'],
    2: ['david', 'fatima', 'jonas'],
    3: ['aisha', 'jonas', 'david'],
  };
  const scoreSets: Record<number, number[][]> = {
    0: [[5, 4, 5, 5], [4, 4, 5, 4], [5, 5, 4, 5]], // ~4.6
    1: [[4, 5, 4, 4], [5, 4, 4, 4], [4, 4, 4, 5]], // 4.25
    2: [[4, 4, 4, 4], [4, 3, 4, 4], [4, 4, 4, 4]], // ~3.9
    3: [[3, 2, 3, 3], [2, 3, 3, 2], [3, 3, 2, 2]], // ~2.6
  };
  const comments = [
    'A clear, important question with a credible method. The data governance plan is unusually thorough and the team has delivered similar work before.',
    'Strong proposal overall. The evaluation design is sound, though the dissemination plan could be more concrete about how results reach clinicians.',
    'Well argued and feasible. I would like to see more detail on how model performance will be monitored across sites, but this is a minor concern.',
  ];
  at(-27);
  for (const [i, panel] of Object.entries(panels)) {
    for (const r of panel) tx(() => assignReviewer(deps, ids.officer, hp[Number(i)]!, ids[r]));
  }
  await settle();
  // Seed time only ever moves forward: the dispatcher (correctly) withholds deliveries stamped in its future.
  const healthAssignment = (i: number, r: keyof Ids) =>
    (deps.db.prepare(`SELECT id FROM rev_assignment WHERE proposal_id = ? AND reviewer_id = ? AND status <> 'revoked'`).get(hp[i], ids[r]) as { id: string }).id;
  at(-25);
  for (const [i, panel] of Object.entries(panels)) {
    for (const r of panel) {
      clock.advance(3600_000);
      tx(() => acceptAssignment(deps, ids[r], healthAssignment(Number(i), r)));
    }
  }
  at(-22);
  for (const [i, panel] of Object.entries(panels)) {
    panel.forEach((r, j) => {
      clock.advance(3 * 3600_000);
      const s = scoreSets[Number(i)]![j]!;
      tx(() => submitReview(deps, ids[r], healthAssignment(Number(i), r), { scores: { c1: s[0]!, c2: s[1]!, c3: s[2]!, c4: s[3]! }, comment: comments[j]!, attestsNoConflict: true }));
    });
  }
  await settle();
  at(-6);
  tx(() => recordDecision(deps, ids.chair, hp[0]!, { outcome: 'award', rationale: 'Highest-scoring proposal; the panel was unanimous on its merit and the governance plan.' }));
  tx(() => recordDecision(deps, ids.chair, hp[3]!, { outcome: 'decline', rationale: 'Reviewers found the evaluation plan underdeveloped relative to the other proposals in this round.' }));
  at(-5);
  tx(() => closeCall(deps, ids.officer, health.id, 'Submission window ended; all submissions are in review or decided.'));
  await settle();

  // ---------------------------------------------------------------- climate call: work in progress
  at(-40);
  const cl: Record<string, string> = {};
  const climateProposals: Array<[string, keyof Ids, string, string, number]> = [
    ['permafrost', 'priya', 'Community-operated early warning for permafrost thaw', ABSTRACTS.permafrost, 380_000],
    ['energy', 'elena', 'Resilient hybrid microgrids for Nunavik communities', ABSTRACTS.energy, 340_000],
    ['wildfire', 'mateo', 'Wildfire smoke forecasting with community health workers', ABSTRACTS.wildfire, 295_000],
    ['coastal', 'kwame', 'Mapping coastal erosion hotspots on the Labrador coast', ABSTRACTS.coastal, 120_000],
    ['quantum', 'liam', 'Cadmium-free quantum dots for next-generation displays', ABSTRACTS.quantum, 250_000],
  ];
  for (const [k, who, title, abstract, amount] of climateProposals) {
    clock.advance(DAY_MS);
    const d = tx(() => createDraft(deps, ids[who], { callId: climate.id, title, abstract, requested: amount }));
    cl[k] = d.id;
    if (k === 'permafrost' || k === 'energy') tx(() => submitProposal(deps, { accountId: ids[who], name: DEMO_ACCOUNTS[who].name }, d.id));
  }
  await settle();
  at(-36);
  tx(() => confirmEligibility(deps, ids.officer, cl.permafrost!, 'eligible', 'Squarely in scope; strong community partnership letters.'));
  tx(() => confirmEligibility(deps, ids.officer, cl.energy!, 'eligible', 'In scope.'));
  await settle();
  at(-35);
  tx(() => assignReviewer(deps, ids.officer, cl.permafrost!, ids.hannah));
  tx(() => assignReviewer(deps, ids.officer, cl.permafrost!, ids.david));
  tx(() => assignReviewer(deps, ids.officer, cl.permafrost!, ids.fatima));
  tx(() => assignReviewer(deps, ids.officer, cl.energy!, ids.aisha));
  await settle();
  // Officer records Grace Liu's institutional conflict on the permafrost proposal (INV-3 demo).
  const { declareConflict } = await import('./contexts/peer-review/service.ts');
  tx(() => declareConflict(deps, { accountId: ids.officer, isOfficer: true }, { reviewerId: ids.grace, proposalId: cl.permafrost!, reason: 'Same institution as the applicant (University of Toronto).' }));
  at(-34);
  for (const r of ['hannah', 'david', 'fatima'] as const) {
    const a = deps.db.prepare(`SELECT id FROM rev_assignment WHERE proposal_id = ? AND reviewer_id = ?`).get(cl.permafrost, ids[r]) as { id: string };
    tx(() => acceptAssignment(deps, ids[r], a.id));
  }
  at(-20);
  const permScores: Record<string, number[]> = { hannah: [5, 5, 4, 5, 4], david: [4, 5, 4, 4, 4] };
  for (const r of ['hannah', 'david'] as const) {
    const a = deps.db.prepare(`SELECT id FROM rev_assignment WHERE proposal_id = ? AND reviewer_id = ?`).get(cl.permafrost, ids[r]) as { id: string };
    const s = permScores[r]!;
    tx(() =>
      submitReview(deps, ids[r], a.id, {
        scores: { c1: s[0]!, c2: s[1]!, c3: s[2]!, c4: s[3]!, c5: s[4]! },
        comment: r === 'hannah' ? 'An exemplary co-designed project. The sensor network is affordable and the handover plan is credible.' : 'Strong science and genuine partnership. The InSAR validation plan is ambitious for the timeline but achievable.',
        attestsNoConflict: true,
      }),
    );
    clock.advance(DAY_MS);
  }
  // Fatima's review is outstanding; it falls overdue at day -14 (assigned -35 + 21).
  await settle();

  at(-8);
  for (const [k, who] of [['wildfire', 'mateo'], ['coastal', 'kwame'], ['quantum', 'liam']] as const) {
    tx(() => submitProposal(deps, { accountId: ids[who], name: DEMO_ACCOUNTS[who].name }, cl[k]!));
    clock.advance(3 * 3600_000);
  }
  await settle();

  // Drafts still in progress
  at(-2);
  tx(() => createDraft(deps, ids.sarah, { callId: climate.id, title: 'Sea-ice travel safety from community observations', abstract: 'Draft — methods section in progress.', requested: 150_000 }));
  tx(() => createDraft(deps, ids.priya, { callId: climate.id, title: '', abstract: '', requested: 0 }));

  // ---------------------------------------------------------------- arrive at "now"
  clock.set(new Date(realNow));
  sweepOverdue(deps);
  sweepEscalations(deps);
  await settle();
  await drainOutbound(deps, () => 'seed@quorum.local');
}

export async function seedFile(dbFile: string, opts: { reset: boolean }): Promise<void> {
  if (opts.reset) for (const f of [dbFile, `${dbFile}-wal`, `${dbFile}-shm`]) if (existsSync(f)) rmSync(f);
  const clock = new ManualClock();
  const deps = createDeps({ db: openDb(dbFile), clock, dataDir: join(dbFile, '..') });
  try {
    await seed(deps, clock);
  } finally {
    deps.db.close();
  }
}

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, '/').replace(/^\/?/, '/')}` || process.argv[1]?.endsWith('seed.ts')) {
  const dataDir = process.env.QUORUM_DATA_DIR ?? 'data';
  const file = process.env.QUORUM_DB ?? join(dataDir, 'quorum.sqlite');
  seedFile(file, { reset: process.argv.includes('--reset') })
    .then(() => console.log(`Seeded ${file}. Sign in with any demo account; password: ${DEMO_PASSWORD}`))
    .catch((e) => {
      console.error('Seeding failed:', e instanceof Error ? e.message : e);
      process.exit(1);
    });
}
