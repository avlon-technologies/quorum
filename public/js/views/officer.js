// Program officer workspace: the work queue, screening with the agent's advice, reviewer assignment,
// calls, delivery health and the audit log.
import { get, post, ApiError } from '../api.js';
import { h, card, empty, load, statusPill, money, date, dateTime, dueLabel, alertBox, bindForm, field, toast, ruleRef, icon, pill, ASSIGNMENT_STATUS, plural, relDays, meter, confirmStep } from '../ui.js';
import { reviewBlock } from './reviewer.js';

const TRIAGE = {
  eligible: ['Agent suggests: eligible', 'ok'],
  ineligible: ['Agent suggests: ineligible', 'bad'],
  unclear: ['Agent suggests: unclear', 'warn'],
};
function triagePill(t) {
  if (!t) return h('span', { class: 'pill plain' }, 'Triage pending');
  if (!t.verdict) return h('span', { class: 'pill plain' }, 'No agent verdict');
  const [label, tone] = TRIAGE[t.verdict] ?? [t.verdict, 'plain'];
  return h('span', { class: `pill ${tone}` }, label);
}

export async function queue(el, { onClock } = {}) {
  await load(el, async () => {
    const [ws, health] = await Promise.all([get('/api/workspace/officer'), get('/api/health')]);
    const failed = ws.delivery.failed ?? [];
    el.replaceChildren(
      h('div', { class: 'page-head' }, h('div', null, h('div', { class: 'eyebrow' }, 'Program officer'), h('h1', null, 'Work queue'), h('p', { class: 'lede' }, 'Everything waiting on you, oldest first. Each item has one next action.'))),
      h(
        'div',
        { class: 'stat-row' },
        statLink('#q-screen', 'To screen', ws.screening.length, ws.screening.length ? 'attention' : 'calm'),
        statLink('#q-assign', 'Need reviewers', ws.needsReviewers.length, ws.needsReviewers.length ? 'attention' : 'calm'),
        statLink('#q-overdue', 'Overdue reviews', ws.overdueReviews.length, ws.overdueReviews.length ? 'danger' : 'calm'),
        statLink('#q-decisions', 'Decisions overdue', ws.decisionsOverdue.length, ws.decisionsOverdue.length ? 'danger' : 'calm'),
      ),
      failed.length
        ? alertBox('bad', `${plural(failed.length, 'background delivery', 'background deliveries')} failed`, h('p', null, 'An internal step could not be completed after repeated attempts, so later steps for the same proposal are paused. See ', h('a', { href: '#q-health' }, 'system health'), '.'))
        : null,
      section('q-screen', 'Screen for eligibility', ws.screening.length, 'The triage agent’s suggestion is advice only — you make the call.',
        ws.screening.length
          ? h('ul', { class: 'queue' }, ws.screening.map((p) => queueItem(p, [triagePill(p.triage), h('span', null, `Submitted ${relDays(p.submittedAt)}`), p.waitingDays >= 7 ? h('span', { class: 'pill warn' }, `Waiting ${p.waitingDays} days`) : null], 'Screen')))
          : empty('check', 'Nothing to screen', 'New submissions appear here after the triage agent has looked at them.'),
      ),
      section('q-assign', 'Assign reviewers', ws.needsReviewers.length, 'Every eligible proposal needs three independent, verified reviewers without conflicts.',
        ws.needsReviewers.length
          ? h('ul', { class: 'queue' }, ws.needsReviewers.map((p) => queueItem(p, [statusPill(p.status), h('span', null, h('strong', null, `${p.activeAssignments} of 3`), ' reviewers assigned')], p.activeAssignments ? 'Add reviewers' : 'Assign reviewers')))
          : empty('check', 'Every eligible proposal has three reviewers', null),
      ),
      section('q-overdue', 'Overdue reviews', ws.overdueReviews.length, 'Chase the reviewer, or revoke and replace them.',
        ws.overdueReviews.length
          ? h('ul', { class: 'queue' }, ws.overdueReviews.map((a) => h('li', null, h('div', null, h('a', { class: 'q-title', href: `#/officer/proposals/${a.proposal_id}` }, a.proposal?.title ?? 'Proposal'), h('div', { class: 'q-meta' }, h('span', { class: 'mono' }, a.proposal?.reference ?? ''), h('span', null, a.reviewer?.name ?? 'Reviewer'), h('span', { class: 'pill bad' }, `${plural(a.daysOverdue, 'day')} overdue`), h('span', null, `Due ${date(a.due_at)}`))), h('a', { class: 'btn btn-sm', href: `#/officer/proposals/${a.proposal_id}` }, 'Manage reviewers'))))
          : empty('check', 'No overdue reviews', null),
      ),
      section('q-decisions', 'Panel decisions past due', ws.decisionsOverdue.length, 'The chair has 14 days after scoring. Quorum escalates, it never decides on its own.',
        ws.decisionsOverdue.length
          ? h('ul', { class: 'queue' }, ws.decisionsOverdue.map((c) => h('li', null, h('div', null, h('span', { class: 'q-title' }, c.title), h('div', { class: 'q-meta' }, h('span', null, `Mean ${c.meanScore.toFixed(2)}`), h('span', { class: 'pill bad' }, `Due ${date(c.decisionDue)}`))), h('a', { class: 'btn btn-sm', href: `#/officer/proposals/${c.proposalId}` }, 'View'))))
          : empty('check', 'No overdue decisions', null),
      ),
      section('q-health', 'System health', null, 'Background processing: events, notifications.', healthPanel(ws)),
      health.demo ? demoClock(el, onClock) : null,
    );
  });
}

const statLink = (href, label, value, tone) => h('a', { class: `stat ${tone}`, href }, h('div', { class: 'label' }, label), h('div', { class: 'value' }, value));
const section = (id, title, count, sub, body) =>
  h('section', { id, 'aria-labelledby': `${id}-h`, style: 'scroll-margin-top:80px' }, h('div', { class: 'section-title' }, h('h2', { id: `${id}-h` }, title), count === null ? null : h('span', { class: 'count' }, count)), sub ? h('p', { class: 'muted small', style: 'margin:-6px 0 10px' }, sub) : null, card(null, body, { flush: true }));
const queueItem = (p, meta, action) =>
  h('li', null, h('div', null, h('a', { class: 'q-title', href: `#/officer/proposals/${p.id}` }, p.title), h('div', { class: 'q-meta' }, h('span', { class: 'mono' }, p.reference), ...meta)), h('a', { class: 'btn btn-primary btn-sm', href: `#/officer/proposals/${p.id}` }, action));

function healthPanel(ws) {
  const failed = ws.delivery.failed ?? [];
  const out = Object.fromEntries((ws.outbound ?? []).map((r) => [r.status, r.n]));
  return h(
    'div',
    { class: 'card-body' },
    h('dl', { class: 'facts' }, h('dt', null, 'Events waiting'), h('dd', null, String(ws.delivery.pending)), h('dt', null, 'Failed deliveries'), h('dd', null, String(failed.length)), h('dt', null, 'Emails'), h('dd', null, `${out.delivered ?? 0} sent · ${out.queued ?? 0} queued · ${out.failed ?? 0} failed`)),
    failed.length ? alertBox('warn', `${failed.length === 1 ? 'A delivery is' : `${failed.length} deliveries are`} parked`, h('p', null, 'The platform operator has been alerted and will retry it once the cause is fixed. Work on the affected proposal may lag until then.')) : null,
  );
}

function demoClock(el, onClock) {
  const days = h('input', { type: 'number', name: 'days', min: 1, max: 60, value: 7, style: 'max-width:110px' });
  const form = h('form', { novalidate: true, class: 'row' }, h('label', { for: 'f-days', class: 'sr-only' }, 'Days'), Object.assign(days, { id: 'f-days' }), h('button', { class: 'btn', type: 'submit' }, 'Advance the clock'));
  bindForm(form, async (fd, { key }) => {
    const r = await post('/api/demo/advance-clock', { days: Number(fd.get('days')) }, { key });
    toast(`Clock advanced. It is now ${date(r.now)}.`);
    await onClock?.();
    queue(el, { onClock });
  }, { busy: 'Advancing…' });
  return h('section', { style: 'margin-top:30px' }, card('Demo controls', h('div', null, h('p', { class: 'small muted' }, 'Move Quorum’s clock forward to see deadlines, overdue reviews and decision escalations happen. Only available in the demo environment.'), form)));
}

// ------------------------------------------------------------ proposal workspace
export async function proposal(el, id) {
  await load(el, async () => {
    const [p, timeline] = await Promise.all([get(`/api/proposals/${id}`), get(`/api/proposals/${id}/timeline`).catch(() => [])]);
    const blocks = [];
    if (['submitted', 'screening'].includes(p.status)) blocks.push(screeningPanel(el, p));
    let assignments = null;
    if (['eligible', 'underReview', 'scored', 'awarded', 'declined', 'withdrawn'].includes(p.status)) {
      assignments = await get(`/api/proposals/${id}/assignments`);
      blocks.push(await assignmentPanel(el, p, assignments));
    }
    if (['underReview', 'scored', 'awarded', 'declined'].includes(p.status)) {
      const reviews = await get(`/api/proposals/${id}/reviews`);
      const crit = new Map(reviews.criteria.map((c) => [c.id, c.name]));
      blocks.push(card(`Reviews (${reviews.reviews.length} of 3)`, reviews.reviews.length ? h('div', null, reviews.reviews.map((r) => reviewBlock(r, crit))) : empty('clock', 'No reviews submitted yet', 'Reviews appear here as reviewers submit them.')));
    }
    el.replaceChildren(
      h('div', { class: 'crumbs' }, h('a', { href: '#/officer' }, 'Work queue'), ' / ', p.reference),
      h('div', { class: 'page-head' }, h('div', null, h('div', { class: 'eyebrow' }, `${p.reference} · ${p.call?.title ?? ''}`), h('h1', null, p.title), h('p', { class: 'lede' }, `${p.applicant?.name ?? ''} · ${p.applicant?.institution ?? ''}`)), statusPill(p.status)),
      h(
        'div',
        { class: 'grid grid-2' },
        h('div', { class: 'stack' }, ...blocks, card('Abstract', h('p', { class: 'abstract' }, p.abstract))),
        h(
          'div',
          { class: 'stack' },
          card('Details', h('dl', { class: 'facts' }, h('dt', null, 'Requested'), h('dd', null, money(p.requestedMinor)), h('dt', null, 'Call maximum'), h('dd', null, money(p.call?.maxRequestMinor)), h('dt', null, 'Submitted'), h('dd', null, dateTime(p.submittedAt)), p.screening ? [h('dt', null, 'Screening'), h('dd', null, `${p.screening.outcome}${p.screening.agreedWithAgent === false ? ' (overrode the agent)' : ''}`)] : null)),
          card('History', timelineList(timeline), { actions: h('span', { class: 'small muted' }, 'From the audit trail') }),
        ),
      ),
    );
  });
}

export function timelineList(items) {
  if (!items.length) return empty('clock', 'No history yet', null);
  return h(
    'ol',
    { class: 'timeline' },
    items.map((t) => h('li', null, h('div', { class: 't-what' }, t.summary), h('div', { class: 't-meta' }, `${dateTime(t.at)} · ${t.actor}`), t.reason ? h('div', { class: 't-why' }, `“${t.reason}”`) : null, h('div', { class: 't-event' }, t.event))),
  );
}

function screeningPanel(el, p) {
  const t = p.triage;
  const advice = !t
    ? alertBox('info', 'The triage agent has not reported yet', h('p', null, 'You can screen now; the suggestion is optional.'))
    : !t.verdict
      ? alertBox('warn', 'The triage agent could not assess this proposal', h('p', null, t.rationale))
      : h(
          'div',
          { class: `alert ${TRIAGE[t.verdict]?.[1] === 'ok' ? 'ok' : TRIAGE[t.verdict]?.[1] === 'bad' ? 'bad' : 'warn'}` },
          icon('shield'),
          h('div', null, h('strong', null, `${TRIAGE[t.verdict]?.[0] ?? t.verdict}`), h('p', null, t.rationale), h('p', { class: 'small' }, `Advisory only — the agent cannot change a proposal’s status. `, ruleRef('INV-10'))),
        );
  const outcome = (v, label, desc) => h('label', { class: 'choice' }, h('input', { type: 'radio', name: 'outcome', value: v }), h('span', null, h('strong', null, label), h('span', { class: 'small muted' }, desc)));
  const reason = h('textarea', { name: 'reason', rows: 3 });
  const form = h(
    'form',
    { novalidate: true },
    h('fieldset', { class: 'field' }, h('legend', null, 'Your decision'), h('div', { class: 'choice-list' }, outcome('eligible', 'Eligible', 'Send it to peer review.'), outcome('ineligible', 'Ineligible', 'Screen it out. The applicant sees your reason.'))),
    field('Reason', reason, 'Required when screening out, or when your decision differs from the agent’s suggestion.'),
    h('div', { class: 'form-actions' }, h('button', { class: 'btn btn-primary', type: 'submit' }, 'Record screening decision')),
  );
  bindForm(form, async (fd, { key }) => {
    const o = fd.get('outcome');
    if (!o) throw new ApiError(422, { error: { message: 'Choose eligible or ineligible.', fields: [{ field: 'outcome', message: 'Choose an outcome.' }] } });
    await post(`/api/proposals/${p.id}/screening`, { outcome: o, reason: String(fd.get('reason') ?? '').trim() }, { key });
    toast(o === 'eligible' ? 'Marked eligible. It is ready for reviewers.' : 'Screened out. The applicant has been told why.');
    proposal(el, p.id);
  }, { busy: 'Recording…' });
  return card('Eligibility screening', h('div', null, advice, h('div', { style: 'margin-top:16px' }, form)));
}

async function assignmentPanel(el, p, data) {
  const active = data.assignments.filter((a) => a.status !== 'revoked');
  const revoked = data.assignments.filter((a) => a.status === 'revoked');
  const open = ['eligible', 'underReview'].includes(p.status);
  const list = h(
    'ul',
    { class: 'queue' },
    active.map((a) => {
      const due = dueLabel(a.due_at);
      const actions = [];
      if (open && a.status !== 'completed') {
        const btn = h('button', { class: 'btn btn-sm', type: 'button' }, 'Revoke…');
        btn.addEventListener('click', () => btn.closest('li').after(revokeForm(el, p, a)));
        actions.push(btn);
      }
      return h('li', null, h('div', null, h('span', { class: 'q-title' }, a.reviewer?.name ?? 'Reviewer'), h('div', { class: 'q-meta' }, h('span', null, a.reviewer?.institution ?? ''), pill(ASSIGNMENT_STATUS, a.status), a.status !== 'completed' ? h('span', { class: `pill ${due.tone}` }, due.text) : h('span', null, `Submitted ${date(a.completed_at)}`))), h('div', { class: 'row' }, actions));
    }),
  );
  let candidates = null;
  if (open && active.length < 3) {
    const cands = await get(`/api/proposals/${p.id}/reviewer-candidates`);
    const ok = cands.filter((c) => c.eligibility.ok);
    const blocked = cands.filter((c) => !c.eligibility.ok && !c.eligibility.reasons.some((r) => r.code === 'already_assigned'));
    candidates = h(
      'div',
      { style: 'margin-top:18px' },
      h('h3', null, `Choose ${plural(3 - active.length, 'more reviewer')}`),
      ok.length
        ? h(
            'ul',
            { class: 'queue', style: 'border:1px solid var(--border);border-radius:var(--radius)' },
            ok.map((c) => {
              const btn = h('button', { class: 'btn btn-primary btn-sm', type: 'button' }, 'Assign');
              btn.addEventListener('click', async () => {
                btn.disabled = true;
                try {
                  await post(`/api/proposals/${p.id}/assignments`, { reviewerId: c.id });
                  toast(`${c.name} assigned.`);
                  proposal(el, p.id);
                } catch (e) {
                  btn.disabled = false;
                  btn.closest('li').append(h('div', { style: 'grid-column:1/-1' }, alertBox('bad', 'Not assigned', h('p', null, e.message, ' ', ruleRef(e.rule)))));
                }
              });
              return h('li', null, h('div', null, h('span', { class: 'q-title' }, c.name), h('div', { class: 'q-meta' }, h('span', null, c.institution), h('span', { class: 'pill ok' }, 'ORCID verified'))), btn);
            }),
          )
        : empty('info', 'No eligible reviewers available', 'Every reviewer is either conflicted, unverified, or already assigned.'),
      blocked.length
        ? h(
            'details',
            { style: 'margin-top:12px' },
            h('summary', { class: 'small' }, `${plural(blocked.length, 'reviewer')} cannot be assigned — why?`),
            h('ul', { class: 'small', style: 'margin-top:8px' }, blocked.map((c) => h('li', { style: 'margin-bottom:6px' }, h('strong', null, c.name), ' — ', c.eligibility.reasons.map((r) => h('span', null, r.message, ' ', ruleRef(r.rule), ' '))))),
          )
        : null,
    );
  }
  return card(
    `Reviewers (${active.length} of 3)`,
    h(
      'div',
      null,
      active.length ? list : empty('info', 'No reviewers yet', 'Assign three verified reviewers without a conflict of interest.'),
      candidates,
      data.conflicts.length ? h('div', { style: 'margin-top:16px' }, h('h3', null, 'Declared conflicts'), h('ul', { class: 'small' }, data.conflicts.map((c) => h('li', null, h('strong', null, c.reviewer?.name ?? 'Reviewer'), ` — ${c.reason} (${date(c.declaredAt)})`)))) : null,
      revoked.length ? h('details', { style: 'margin-top:12px' }, h('summary', { class: 'small' }, `${plural(revoked.length, 'withdrawn assignment')}`), h('ul', { class: 'small' }, revoked.map((a) => h('li', null, `${a.reviewer?.name ?? 'Reviewer'} — ${a.revoke_reason}`)))) : null,
      open ? conflictRecorder(el, p) : null,
    ),
  );
}

function revokeForm(el, p, a) {
  const reason = h('textarea', { name: 'reason', rows: 2 });
  const form = h('form', { novalidate: true, class: 'confirm-box', style: 'margin:0 22px 14px' }, h('h3', null, `Revoke ${a.reviewer?.name ?? 'this reviewer'}?`), h('p', { class: 'small' }, 'Their assignment ends and any unsubmitted work is discarded. You can then assign a replacement.'), field('Reason (shared with the reviewer)', reason), h('div', { class: 'form-actions' }, h('button', { class: 'btn btn-danger', type: 'submit' }, 'Revoke assignment'), h('button', { class: 'btn btn-ghost', type: 'button', onclick: () => form.remove() }, 'Cancel')));
  bindForm(form, async (fd, { key }) => {
    await post(`/api/assignments/${a.id}/revoke`, { reason: String(fd.get('reason') ?? '').trim() }, { key });
    toast('Assignment revoked.');
    proposal(el, p.id);
  });
  return form;
}

function conflictRecorder(el, p) {
  const holder = h('div', { style: 'margin-top:14px' });
  const btn = h('button', { class: 'btn btn-ghost btn-sm', type: 'button' }, 'Record a conflict for a reviewer…');
  btn.addEventListener('click', async () => {
    const reviewers = await get('/api/reviewers');
    const sel = h('select', { name: 'reviewerId' }, h('option', { value: '' }, 'Choose a reviewer'), reviewers.map((r) => h('option', { value: r.id }, `${r.name} — ${r.institution}`)));
    const reason = h('textarea', { name: 'reason', rows: 2 });
    const form = h('form', { novalidate: true, class: 'card card-pad' }, h('h3', null, 'Record a conflict of interest'), h('p', { class: 'small muted' }, 'A conflicted reviewer can never be assigned to this proposal. If they are already assigned, the assignment is withdrawn. ', ruleRef('INV-3')), field('Reviewer', sel), field('Conflict', reason), h('div', { class: 'form-actions' }, h('button', { class: 'btn btn-primary', type: 'submit' }, 'Record conflict')));
    bindForm(form, async (fd, { key }) => {
      if (!fd.get('reviewerId')) throw new ApiError(422, { error: { message: 'Choose the reviewer.', fields: [{ field: 'reviewerId', message: 'Choose a reviewer.' }] } });
      await post('/api/conflicts', { proposalId: p.id, reviewerId: fd.get('reviewerId'), reason: String(fd.get('reason') ?? '').trim() }, { key });
      toast('Conflict recorded.');
      proposal(el, p.id);
    });
    holder.replaceChildren(form);
  });
  return h('div', null, btn, holder);
}

// ------------------------------------------------------------ calls
export async function calls(el) {
  await load(el, async () => {
    const list = await get('/api/calls');
    const withBudget = await Promise.all(list.map((c) => get(`/api/calls/${c.id}`)));
    const formHolder = h('div');
    const newBtn = h('button', { class: 'btn btn-primary', type: 'button', onclick: () => { formHolder.replaceChildren(publishForm(el)); formHolder.querySelector('input')?.focus(); } }, 'Publish a new call');
    el.replaceChildren(
      h('div', { class: 'page-head' }, h('div', null, h('div', { class: 'eyebrow' }, 'Program officer'), h('h1', null, 'Funding calls'), h('p', { class: 'lede' }, 'Budget envelopes are fixed once a call is published.')), newBtn),
      formHolder,
      withBudget.length
        ? h(
            'div',
            { class: 'grid grid-cols', style: 'margin-top:12px' },
            withBudget.map((c) =>
              h(
                'article',
                { class: 'card card-pad' },
                h('div', { class: 'spread' }, h('span', { class: 'tag' }, c.reference), c.status === 'open' ? h('span', { class: 'pill ok' }, c.acceptingSubmissions ? 'Open' : 'Deadline passed') : h('span', { class: 'pill plain' }, 'Closed')),
                h('h3', { style: 'margin-top:10px' }, c.title),
                h('dl', { class: 'facts small' }, h('dt', null, 'Deadline'), h('dd', null, dateTime(c.deadline)), h('dt', null, 'Max request'), h('dd', null, money(c.maxRequestMinor)), h('dt', null, 'Criteria'), h('dd', null, String(c.criteria.length))),
                c.budget ? h('div', { style: 'margin-top:12px' }, meter(c.budget.envelopeMinor, c.budget.committedMinor), h('div', { class: 'meter-legend' }, h('span', null, `${money(c.budget.committedMinor)} awarded`), h('span', null, `${money(c.budget.remainingMinor)} of ${money(c.budget.envelopeMinor)} left`))) : null,
                h('div', { class: 'form-actions', style: 'margin-top:12px' }, h('a', { class: 'btn btn-sm', href: '#/portfolio' }, 'Portfolio'), c.status === 'open' ? closeCallButton(el, c) : null),
              ),
            ),
          )
        : card(null, empty('inbox', 'No calls yet', 'Publish your first funding call to start accepting proposals.')),
    );
  });
}

function closeCallButton(el, c) {
  const holder = h('div', { style: 'flex-basis:100%' });
  const btn = h('button', { class: 'btn btn-sm', type: 'button' }, 'Close call…');
  btn.addEventListener('click', () => {
    const reason = h('textarea', { rows: 2, id: `close-${c.id}` });
    const key = crypto.randomUUID();
    holder.replaceChildren(
      confirmStep({
        tone: 'danger',
        title: 'Close this call?',
        body: h('div', null, h('p', { class: 'small' }, 'No further proposals can be submitted. Proposals already submitted continue through review.'), field('Reason', reason)),
        ack: 'I understand a closed call cannot be reopened.',
        confirmLabel: 'Close call',
        onCancel: () => holder.replaceChildren(),
        onConfirm: async (b) => {
          b.disabled = true;
          try {
            await post(`/api/calls/${c.id}/close`, { reason: reason.value.trim() || 'Closed by the program officer.' }, { key });
            toast('Call closed.');
            calls(el);
          } catch (e) {
            b.disabled = false;
            holder.prepend(alertBox('bad', 'Not closed', h('p', null, e.message)));
          }
        },
      }),
    );
  });
  return h('span', { style: 'display:contents' }, btn, holder);
}

function publishForm(el) {
  const crits = h('div');
  const addCrit = (name = '', guidance = '') => {
    const i = crits.children.length;
    crits.append(h('div', { class: 'card card-pad', style: 'margin-bottom:8px;padding:12px 14px' }, field(`Criterion ${i + 1}`, h('input', { type: 'text', name: `criteria.${i}.name`, value: name })), field('Guidance for reviewers', h('input', { type: 'text', name: `criteria.${i}.guidance`, value: guidance }))));
  };
  addCrit('Scientific merit', 'Originality and rigour of the research design.');
  addCrit('Feasibility', 'Is the plan realistic for this team and budget?');
  addCrit('Impact', 'How plausibly will results make a difference?');
  const form = h(
    'form',
    { novalidate: true },
    field('Title', h('input', { type: 'text', name: 'title' })),
    field('Summary', h('textarea', { name: 'summary', rows: 4 }), 'What the call funds and who should apply. At least 20 characters.'),
    h('div', { class: 'grid grid-cols' }, field('Deadline', h('input', { type: 'datetime-local', name: 'deadline' })), field('Budget envelope (CAD)', h('input', { type: 'number', name: 'envelope', min: 1, step: 1000 }), 'Fixed once published.'), field('Maximum per proposal (CAD)', h('input', { type: 'number', name: 'maxRequest', min: 1, step: 1000 }))),
    h('h3', null, 'Review criteria'),
    crits,
    h('button', { class: 'btn btn-ghost btn-sm', type: 'button', onclick: () => addCrit() }, '+ Add criterion'),
    h('div', { class: 'form-actions', style: 'margin-top:16px' }, h('button', { class: 'btn btn-primary', type: 'submit' }, 'Publish call')),
  );
  bindForm(form, async (fd, { key }) => {
    const criteria = [];
    for (let i = 0; fd.has(`criteria.${i}.name`); i++) {
      const name = String(fd.get(`criteria.${i}.name`)).trim();
      if (name) criteria.push({ name, guidance: String(fd.get(`criteria.${i}.guidance`) ?? '').trim() });
    }
    const dl = String(fd.get('deadline') ?? '');
    await post('/api/calls', { title: String(fd.get('title')).trim(), summary: String(fd.get('summary')).trim(), deadline: dl ? new Date(dl).toISOString() : '', envelope: Number(fd.get('envelope') || 0), maxRequest: Number(fd.get('maxRequest') || 0), criteria }, { key });
    toast('Call published. It is now open for submissions.');
    calls(el);
  }, { busy: 'Publishing…' });
  return card('Publish a new call', form, { foot: h('span', { class: 'small muted' }, 'Publishing is final: the deadline, envelope and criteria cannot be changed afterwards.') });
}

export async function activity(el) {
  await load(el, async () => {
    const items = await get('/api/activity');
    el.replaceChildren(
      h('div', { class: 'page-head' }, h('div', null, h('div', { class: 'eyebrow' }, 'Oversight'), h('h1', null, 'Audit log'), h('p', { class: 'lede' }, 'Every state change in Quorum, newest first, with who did it and why. Built from the event log.'))),
      card(
        null,
        items.length
          ? h('div', { class: 'table-wrap' }, h('table', { class: 'data stack-sm' }, h('thead', null, h('tr', null, h('th', null, 'When'), h('th', null, 'What'), h('th', null, 'Event'))), h('tbody', null, items.map((t) => h('tr', null, h('td', { 'data-label': 'When', class: 'nowrap small' }, dateTime(t.at)), h('td', { 'data-label': 'What' }, t.proposalId ? h('a', { href: `#/officer/proposals/${t.proposalId}` }, t.summary) : t.summary, t.reason ? h('div', { class: 'small muted' }, `“${t.reason}”`) : null), h('td', { 'data-label': 'Event', class: 'mono small' }, t.event))))))
          : empty('clock', 'Nothing recorded yet', null),
        { flush: true },
      ),
    );
  });
}
