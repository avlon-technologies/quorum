// Applicant workspace: open calls, my proposals, draft editing, submission, progress.
import { get, post, put, session, ApiError } from '../api.js';
import { h, card, empty, load, statusPill, money, date, dateTime, dueLabel, alertBox, bindForm, field, counter, confirmStep, toast, ruleRef, icon, now, relDays } from '../ui.js';

const STEPS = [
  ['submitted', 'Submitted'],
  ['screening', 'Screening'],
  ['eligible', 'Eligible'],
  ['underReview', 'Under review'],
  ['scored', 'Scored'],
  ['decision', 'Decision'],
];
const ORDER = { draft: -1, submitted: 0, screening: 1, eligible: 2, underReview: 3, scored: 4, awarded: 5, declined: 5, ineligible: 2, withdrawn: -2 };

const NEXT = {
  draft: 'Finish and submit before the deadline',
  submitted: 'Nothing to do — eligibility screening starts shortly',
  screening: 'Nothing to do — a program officer is screening it',
  eligible: 'Nothing to do — reviewers are being assigned',
  underReview: 'Nothing to do — three reviewers are assessing it',
  scored: 'Nothing to do — the panel will decide',
  awarded: 'Funded — see the panel’s decision',
  declined: 'See the panel’s decision',
  ineligible: 'See the screening reason',
  withdrawn: 'Withdrawn',
};

export async function home(el) {
  await load(el, async () => {
    const [proposals, calls] = await Promise.all([get('/api/proposals'), get('/api/calls')]);
    const open = calls.filter((c) => c.acceptingSubmissions);
    const drafts = proposals.filter((p) => p.status === 'draft');
    el.replaceChildren(
      h('div', { class: 'page-head' }, h('div', null, h('div', { class: 'eyebrow' }, 'Applicant workspace'), h('h1', null, `Welcome, ${session.me.name}`), h('p', { class: 'lede' }, 'Your proposals and where each one stands.'))),
      drafts.length
        ? alertBox('warn', `${drafts.length === 1 ? 'You have a draft' : `You have ${drafts.length} drafts`} not yet submitted`, h('p', null, 'Drafts are not seen by anyone until you submit them. ', h('a', { href: `#/proposals/${drafts[0].id}` }, 'Continue your draft')))
        : null,
      h('div', { class: 'section-title' }, h('h2', null, 'My proposals'), h('span', { class: 'count' }, proposals.length)),
      proposals.length === 0
        ? card(null, empty('inbox', 'No proposals yet', open.length ? 'Start a proposal from one of the open calls below.' : 'There are no open calls right now. Check back soon.'))
        : card(null, proposalTable(proposals, calls), { flush: true }),
      h('div', { class: 'section-title' }, h('h2', null, 'Open calls'), h('span', { class: 'count' }, open.length)),
      open.length === 0 ? card(null, empty('clock', 'No calls are open', 'New funding calls appear here when published.')) : h('div', { class: 'grid grid-cols' }, open.map(callCard)),
    );
  });
}

function proposalTable(proposals, calls) {
  const callTitle = new Map(calls.map((c) => [c.id, c.title]));
  return h(
    'div',
    { class: 'table-wrap' },
    h(
      'table',
      { class: 'data stack-sm' },
      h('thead', null, h('tr', null, h('th', null, 'Proposal'), h('th', null, 'Status'), h('th', { class: 'num' }, 'Requested'), h('th', null, 'Next'))),
      h(
        'tbody',
        null,
        proposals.map((p) =>
          h(
            'tr',
            null,
            h('td', { class: 'title-cell', 'data-label': 'Proposal' }, h('a', { href: `#/proposals/${p.id}` }, p.title || 'Untitled draft'), h('small', null, `${p.reference} · ${callTitle.get(p.callId) ?? 'Call'}`)),
            h('td', { 'data-label': 'Status' }, statusPill(p.status)),
            h('td', { class: 'num', 'data-label': 'Requested' }, p.requestedMinor ? money(p.requestedMinor) : '—'),
            h('td', { 'data-label': 'Next', class: 'small' }, NEXT[p.status] ?? ''),
          ),
        ),
      ),
    ),
  );
}

function callCard(c) {
  const due = dueLabel(c.deadline);
  return h(
    'article',
    { class: 'card card-pad' },
    h('div', { class: 'spread' }, h('span', { class: 'tag' }, c.reference), h('span', { class: `pill ${due.tone === 'plain' ? 'plain' : due.tone}` }, `Closes ${relDays(c.deadline)}`)),
    h('h3', { style: 'margin-top:10px' }, h('a', { href: `#/calls/${c.id}` }, c.title)),
    h('p', { class: 'small muted' }, c.summary.length > 180 ? `${c.summary.slice(0, 180)}…` : c.summary),
    h('dl', { class: 'facts small' }, h('dt', null, 'Deadline'), h('dd', null, dateTime(c.deadline)), h('dt', null, 'Up to'), h('dd', null, money(c.maxRequestMinor))),
  );
}

export async function calls(el) {
  await load(el, async () => {
    const list = (await get('/api/calls')).filter((c) => c.acceptingSubmissions);
    el.replaceChildren(
      h('div', { class: 'page-head' }, h('div', null, h('h1', null, 'Open calls'), h('p', { class: 'lede' }, 'Funding calls currently accepting proposals.'))),
      list.length ? h('div', { class: 'grid grid-cols' }, list.map(callCard)) : card(null, empty('clock', 'No calls are open', 'New funding calls appear here when published.')),
    );
  });
}

export async function call(el, id) {
  await load(el, async () => {
    const c = await get(`/api/calls/${id}`);
    const mine = (await get('/api/proposals')).filter((p) => p.callId === id);
    const start = h('button', { class: 'btn btn-primary', type: 'button' }, 'Start a proposal');
    start.addEventListener('click', async () => {
      start.disabled = true;
      try {
        const d = await post('/api/proposals', { callId: id, title: '', abstract: '', requested: 0 });
        location.hash = `#/proposals/${d.id}`;
      } catch (e) {
        start.disabled = false;
        start.after(alertBox('bad', 'Could not start a proposal', h('p', null, e.message, ' ', ruleRef(e.rule))));
      }
    });
    el.replaceChildren(
      h('div', { class: 'crumbs' }, h('a', { href: '#/calls' }, 'Open calls'), ' / ', c.reference),
      h('div', { class: 'page-head' }, h('div', null, h('div', { class: 'eyebrow' }, c.reference), h('h1', null, c.title)), c.acceptingSubmissions ? start : h('span', { class: 'pill bad' }, 'Closed')),
      h(
        'div',
        { class: 'grid grid-2' },
        h(
          'div',
          { class: 'stack' },
          card('About this call', h('p', { class: 'abstract' }, c.summary)),
          card(
            'How proposals are assessed',
            h(
              'div',
              null,
              h('p', { class: 'muted small' }, 'Three independent reviewers score each eligible proposal from 1 to 5 on every criterion below.'),
              h('ol', null, c.criteria.map((cr) => h('li', { style: 'margin-bottom:8px' }, h('strong', null, cr.name), cr.guidance ? h('div', { class: 'small muted' }, cr.guidance) : null))),
            ),
          ),
        ),
        h(
          'div',
          { class: 'stack' },
          card('Key facts', h('dl', { class: 'facts' }, h('dt', null, 'Deadline'), h('dd', null, dateTime(c.deadline), h('div', { class: 'small muted' }, relDays(c.deadline))), h('dt', null, 'Maximum request'), h('dd', null, money(c.maxRequestMinor)), h('dt', null, 'Total budget'), h('dd', null, money(c.envelopeMinor)))),
          mine.length ? card('Your proposals to this call', h('ul', null, mine.map((p) => h('li', null, h('a', { href: `#/proposals/${p.id}` }, p.title || 'Untitled draft'), ' ', statusPill(p.status))))) : null,
        ),
      ),
    );
  });
}

export async function proposal(el, id) {
  await load(el, async () => {
    const p = await get(`/api/proposals/${id}`);
    if (p.status === 'draft') return renderDraft(el, p);
    renderSubmitted(el, p);
  });
}

function renderDraft(el, p) {
  const c = p.call;
  const closed = c.status !== 'open' || new Date(c.deadline).getTime() <= now().getTime();
  const title = h('input', { type: 'text', name: 'title', value: p.title, maxlength: 200 });
  const abstract = h('textarea', { name: 'abstract', rows: 12, maxlength: 6000 }, p.abstract);
  const requested = h('input', { type: 'number', name: 'requested', min: 0, step: 1000, value: p.requestedMinor ? p.requestedMinor / 100 : '', inputmode: 'numeric' });
  const status = h('span', { class: 'small muted', 'aria-live': 'polite' }, `Last saved ${dateTime(p.updatedAt)}`);
  const due = dueLabel(c.deadline);
  const values = () => ({ title: title.value, abstract: abstract.value, requested: Number(requested.value || 0) });

  const form = h(
    'form',
    { novalidate: true },
    field('Title', title, 'At least 10 characters.'),
    h('div', { class: 'field' }, h('label', { for: 'f-abstract' }, 'Abstract'), h('div', { class: 'hint' }, 'What you will do, why it matters, and how. At least 200 characters.'), Object.assign(abstract, { id: 'f-abstract' }), counter(abstract, 200)),
    field('Amount requested (CAD)', requested, `Up to ${money(c.maxRequestMinor)} for this call.`),
    h('div', { class: 'form-actions' }, h('button', { class: 'btn', type: 'submit', name: 'intent', value: 'save' }, 'Save draft'), h('button', { class: 'btn btn-primary', type: 'submit', name: 'intent', value: 'submit', disabled: closed }, 'Review and submit…'), status),
  );
  const confirmHolder = h('div');
  bindForm(form, async (_fd, { submitter }) => {
    const saved = await put(`/api/proposals/${p.id}`, values());
    status.textContent = `Saved ${dateTime(saved.updatedAt)}`;
    if (submitter?.value !== 'submit') { toast('Draft saved.'); return; }
    const fresh = await get(`/api/proposals/${p.id}`);
    if (fresh.readiness?.length) {
      throw new ApiError(422, { error: { code: 'incomplete', message: 'Your draft is saved, but it is not ready to submit yet.', fields: fresh.readiness } });
    }
    const submitKey = crypto.randomUUID();
    confirmHolder.replaceChildren(
      confirmStep({
        title: 'Submit this proposal?',
        body: h('div', null, h('p', null, `“${saved.title}” requesting ${money(saved.requestedMinor)} to ${c.title}.`), h('p', null, 'After submitting you cannot edit it. You can still withdraw it until the panel decides.')),
        ack: 'I confirm the proposal is complete and ready for screening.',
        confirmLabel: 'Submit proposal',
        onCancel: () => confirmHolder.replaceChildren(),
        onConfirm: async (btn) => {
          btn.disabled = true;
          try {
            await post(`/api/proposals/${p.id}/submit`, undefined, { key: submitKey });
            toast('Proposal submitted. It is now in eligibility screening.');
            proposal(el, p.id);
          } catch (e) {
            btn.disabled = false;
            confirmHolder.prepend(alertBox('bad', 'Not submitted', h('p', null, e.message, ' ', ruleRef(e.rule))));
          }
        },
      }),
    );
  }, { busy: 'Saving…' });

  el.replaceChildren(
    h('div', { class: 'crumbs' }, h('a', { href: '#/applicant' }, 'My proposals'), ' / ', p.reference),
    h('div', { class: 'page-head' }, h('div', null, h('div', { class: 'eyebrow' }, `${p.reference} · Draft`), h('h1', null, p.title || 'Untitled draft'), h('p', { class: 'lede' }, `For ${c.title}`)), statusPill('draft')),
    closed ? alertBox('bad', 'This call is no longer accepting submissions', h('p', null, `The deadline was ${dateTime(c.deadline)}. Drafts cannot be submitted after it. `, ruleRef('INV-1'))) : null,
    h(
      'div',
      { class: 'grid grid-2', style: 'margin-top:16px' },
      card('Your proposal', h('div', null, form, confirmHolder)),
      h(
        'div',
        { class: 'stack' },
        card('Deadline', h('div', null, h('div', { class: 'money-big' }, dateTime(c.deadline)), h('span', { class: `pill ${due.tone}` }, due.text), h('p', { class: 'small muted', style: 'margin-top:10px' }, 'Submissions are accepted up to the deadline, not at or after it.'))),
        card('Before you submit', checklist(p, c)),
        card('Withdraw', h('div', null, h('p', { class: 'small muted' }, 'Discard this draft. Nobody else has seen it.'), withdrawButton(el, p))),
      ),
    ),
  );
}

function checklist(p, c) {
  const items = [
    [p.title.trim().length >= 10, 'Title of at least 10 characters'],
    [p.abstract.trim().length >= 200, `Abstract of at least 200 characters (${p.abstract.trim().length} now)`],
    [p.requestedMinor > 0 && p.requestedMinor <= c.maxRequestMinor, `Amount between $1 and ${money(c.maxRequestMinor)}`],
  ];
  return h('ul', { class: 'small', style: 'list-style:none;padding:0;margin:0' }, items.map(([ok, label]) => h('li', { style: 'display:flex;gap:8px;margin-bottom:6px;align-items:center' }, h('span', { class: `pill ${ok ? 'ok' : 'plain'}` }, ok ? 'Done' : 'To do'), label)), h('li', { class: 'muted', style: 'margin-top:8px' }, 'Saved state shown; save to refresh.'));
}

function withdrawButton(el, p) {
  const holder = h('div');
  const btn = h('button', { class: 'btn btn-sm', type: 'button' }, p.status === 'draft' ? 'Withdraw draft…' : 'Withdraw proposal…');
  btn.addEventListener('click', () => {
    const reason = h('textarea', { name: 'reason', rows: 3, id: 'withdraw-reason' });
    const key = crypto.randomUUID();
    holder.replaceChildren(
      confirmStep({
        tone: 'danger',
        title: 'Withdraw this proposal?',
        body: h('div', null, h('p', null, 'Withdrawal is final: the proposal leaves the competition, and any reviewer assignments are cancelled.'), field('Reason', reason)),
        ack: 'I understand this cannot be undone.',
        confirmLabel: 'Withdraw',
        onCancel: () => holder.replaceChildren(),
        onConfirm: async (b) => {
          b.disabled = true;
          try {
            await post(`/api/proposals/${p.id}/withdraw`, { reason: reason.value.trim() || 'Withdrawn by the applicant.' }, { key });
            toast('Proposal withdrawn.');
            proposal(el, p.id);
          } catch (e) {
            b.disabled = false;
            holder.prepend(alertBox('bad', 'Not withdrawn', h('p', null, e.message)));
          }
        },
      }),
    );
  });
  return h('div', null, btn, holder);
}

function stepper(status) {
  const idx = ORDER[status] ?? 0;
  return h(
    'ol',
    { class: 'stepper', 'aria-label': 'Progress' },
    STEPS.map(([key, label], i) => {
      let cls = i < idx ? 'done' : i === idx ? 'current' : '';
      let text = label;
      if (status === 'ineligible' && key === 'eligible') { cls = 'stopped'; text = 'Ineligible'; }
      if (key === 'decision' && (status === 'awarded' || status === 'declined')) { cls = status === 'awarded' ? 'done' : 'stopped'; text = status === 'awarded' ? 'Awarded' : 'Declined'; }
      return h('li', { class: cls, 'aria-current': i === idx ? 'step' : null }, text);
    }),
  );
}

function renderSubmitted(el, p) {
  const c = p.call;
  const outcome =
    p.status === 'awarded'
      ? alertBox('ok', 'Funded', h('p', null, `The panel awarded ${money(p.requestedMinor)}. ${p.statusReason ?? ''}`))
      : p.status === 'declined'
        ? alertBox('warn', 'Not funded this round', h('p', null, p.statusReason ?? 'The panel declined this proposal.'))
        : p.status === 'ineligible'
          ? alertBox('bad', 'Screened out as ineligible', h('p', null, p.screening?.reason ?? p.statusReason ?? ''))
          : p.status === 'withdrawn'
            ? alertBox('info', 'Withdrawn', h('p', null, p.statusReason ?? 'You withdrew this proposal.'))
            : alertBox('info', 'In progress', h('p', null, NEXT[p.status]));
  el.replaceChildren(
    h('div', { class: 'crumbs' }, h('a', { href: '#/applicant' }, 'My proposals'), ' / ', p.reference),
    h('div', { class: 'page-head' }, h('div', null, h('div', { class: 'eyebrow' }, p.reference), h('h1', null, p.title), h('p', { class: 'lede' }, `For ${c.title}`)), statusPill(p.status)),
    p.status !== 'withdrawn' ? card(null, stepper(p.status)) : null,
    h(
      'div',
      { class: 'grid grid-2', style: 'margin-top:18px' },
      h('div', { class: 'stack' }, outcome, card('Abstract', h('p', { class: 'abstract' }, p.abstract))),
      h(
        'div',
        { class: 'stack' },
        card('Details', h('dl', { class: 'facts' }, h('dt', null, 'Requested'), h('dd', null, money(p.requestedMinor)), h('dt', null, 'Submitted'), h('dd', null, dateTime(p.submittedAt)), h('dt', null, 'Call'), h('dd', null, c.reference))),
        card('What reviewers see', h('p', { class: 'small muted' }, 'Reviewers see your title, abstract and request. Scores and comments go to the panel; you receive the panel’s decision and rationale.')),
        ['submitted', 'screening', 'eligible', 'underReview'].includes(p.status) ? card('Withdraw', withdrawButton(el, p)) : null,
      ),
    ),
  );
}
