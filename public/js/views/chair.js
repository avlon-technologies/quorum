// Panel chair workspace: ranked decision queue with the budget in view; the decision screen with
// budget impact, all reviews, and an explicit, final award/decline.
import { get, post } from '../api.js';
import { h, card, empty, load, statusPill, money, date, dateTime, alertBox, field, toast, ruleRef, icon, meter, confirmStep, counter, plural } from '../ui.js';
import { reviewBlock } from './reviewer.js';
import { timelineList } from './officer.js';

export async function home(el) {
  await load(el, async () => {
    const cases = await get('/api/adjudications');
    const open = cases.filter((c) => c.status !== 'decided');
    const decided = cases.filter((c) => c.status === 'decided');
    const budgets = new Map();
    for (const c of cases) if (c.budget) budgets.set(c.callId, { ...c.budget, pending: 0, title: null });
    const portfolio = await get('/api/portfolio');
    for (const call of portfolio) if (budgets.has(call.callId)) budgets.get(call.callId).title = call.title;
    for (const c of open) if (budgets.has(c.callId)) budgets.get(c.callId).pending += c.requestedMinor;
    el.replaceChildren(
      h('div', { class: 'page-head' }, h('div', null, h('div', { class: 'eyebrow' }, 'Panel chair'), h('h1', null, 'Decisions'), h('p', { class: 'lede' }, 'Scored proposals awaiting the panel’s decision, highest mean score first.'))),
      [...budgets.values()].length
        ? h(
            'div',
            { class: 'grid grid-cols' },
            [...budgets.values()].map((b) =>
              card(
                b.title ?? 'Call budget',
                h(
                  'div',
                  null,
                  h('div', { class: 'spread' }, h('div', null, h('div', { class: 'small muted' }, 'Remaining'), h('div', { class: 'money-big' }, money(b.remainingMinor))), h('div', { style: 'text-align:right' }, h('div', { class: 'small muted' }, 'Envelope'), h('div', null, money(b.envelopeMinor)))),
                  h('div', { style: 'margin-top:10px' }, meter(b.envelopeMinor, b.committedMinor, b.pending)),
                  h('div', { class: 'meter-legend' }, h('span', null, h('i', { style: 'background:var(--accent)' }), `${money(b.committedMinor)} awarded`), b.pending ? h('span', null, h('i', { style: 'background:#8ea2cd' }), `${money(b.pending)} requested by open cases`) : null),
                  b.pending > b.remainingMinor ? h('p', { class: 'small', style: 'margin:10px 0 0;color:var(--warn);font-weight:600' }, `Open requests exceed what remains by ${money(b.pending - b.remainingMinor)}: not every case can be funded.`) : null,
                ),
                { level: 'h3' },
              ),
            ),
          )
        : null,
      h('div', { class: 'section-title' }, h('h2', null, 'Awaiting decision'), h('span', { class: 'count' }, open.length)),
      open.length
        ? card(
            null,
            h(
              'ul',
              { class: 'queue' },
              open.map((c, i) =>
                h(
                  'li',
                  null,
                  h(
                    'div',
                    { style: 'display:flex;gap:16px;align-items:center' },
                    h('div', { style: 'text-align:center;min-width:56px' }, h('div', { class: 'mean' }, c.meanScore.toFixed(2)), h('div', { class: 'small muted' }, `rank ${i + 1}`)),
                    h(
                      'div',
                      null,
                      h('a', { class: 'q-title', href: `#/chair/decisions/${c.proposalId}` }, c.title),
                      h(
                        'div',
                        { class: 'q-meta' },
                        budgets.get(c.callId)?.title ? h('span', null, budgets.get(c.callId).title) : null,
                        h('span', null, `Requests ${money(c.requestedMinor)}`),
                        c.overdue ? h('span', { class: 'pill bad' }, `Decision overdue since ${date(c.decisionDue)}`) : h('span', null, `Decide by ${date(c.decisionDue)}`),
                        c.status === 'reconsider' ? h('span', { class: 'pill warn' }, 'Award refused — decline needed') : null,
                        c.integrityHold ? h('span', { class: 'pill bad' }, 'Integrity hold') : null,
                        c.budget && c.requestedMinor > c.budget.remainingMinor ? h('span', { class: 'pill warn' }, 'Exceeds remaining budget') : null,
                      ),
                    ),
                  ),
                  h('a', { class: 'btn btn-primary btn-sm', href: `#/chair/decisions/${c.proposalId}` }, 'Decide'),
                ),
              ),
            ),
            { flush: true },
          )
        : card(null, empty('check', 'No decisions waiting', 'Proposals appear here once all three reviews are in.')),
      decided.length ? h('div', { class: 'section-title' }, h('h2', null, 'Decided'), h('span', { class: 'count' }, decided.length)) : null,
      decided.length
        ? card(
            null,
            h('div', { class: 'table-wrap' }, h('table', { class: 'data stack-sm' }, h('thead', null, h('tr', null, h('th', null, 'Proposal'), h('th', { class: 'num' }, 'Mean'), h('th', null, 'Outcome'), h('th', { class: 'num' }, 'Amount'), h('th', null, 'Decided'))), h('tbody', null, decided.map((c) => h('tr', null, h('td', { class: 'title-cell', 'data-label': 'Proposal' }, h('a', { href: `#/chair/decisions/${c.proposalId}` }, c.title)), h('td', { class: 'num', 'data-label': 'Mean' }, c.meanScore.toFixed(2)), h('td', { 'data-label': 'Outcome' }, statusPill(c.decision.outcome === 'award' ? 'awarded' : 'declined')), h('td', { class: 'num', 'data-label': 'Amount' }, c.decision.amountMinor ? money(c.decision.amountMinor) : '—'), h('td', { 'data-label': 'Decided', class: 'small' }, date(c.decision.decidedAt))))))),
            { flush: true },
          )
        : null,
    );
  });
}

export async function decision(el, id) {
  await load(el, async () => {
    const [c, reviews, timeline] = await Promise.all([get(`/api/adjudications/${id}`), get(`/api/proposals/${id}/reviews`), get(`/api/proposals/${id}/timeline`).catch(() => [])]);
    const crit = new Map(reviews.criteria.map((x) => [x.id, x.name]));
    const b = c.budget;
    const fits = b ? c.requestedMinor <= b.remainingMinor : true;
    const perCriterion = reviews.criteria.map((cr) => {
      const v = reviews.reviews.map((r) => r.scores[cr.id]).filter((x) => x !== undefined);
      return [cr.name, v.length ? v.reduce((s, x) => s + x, 0) / v.length : 0];
    });
    el.replaceChildren(
      h('div', { class: 'crumbs' }, h('a', { href: '#/chair' }, 'Decisions'), ' / ', c.proposal?.reference ?? ''),
      h('div', { class: 'page-head' }, h('div', null, h('div', { class: 'eyebrow' }, c.proposal?.reference ?? ''), h('h1', null, c.title)), statusPill(c.status === 'decided' ? (c.decision.outcome === 'award' ? 'awarded' : 'declined') : 'scored')),
      c.integrityHold ? alertBox('bad', 'Integrity hold — this award cannot be made', h('p', null, `${c.integrityHold}. You may decline; an award needs the program officer to resolve the hold first. `, ruleRef('INV-3'))) : null,
      c.overdue ? alertBox('warn', 'This decision is past its due date', h('p', null, `It was due ${dateTime(c.decisionDue)}. The program officers have been notified and see it on their work queue. Quorum never decides on the panel’s behalf.`)) : null,
      h(
        'div',
        { class: 'grid grid-2', style: 'margin-top:14px' },
        h(
          'div',
          { class: 'stack' },
          c.status === 'decided' ? decidedPanel(c) : decisionPanel(el, c, fits),
          card(`Reviews (${reviews.reviews.length})`, h('div', null, reviews.reviews.map((r) => reviewBlock(r, crit)))),
          card('Abstract', h('p', { class: 'abstract' }, c.proposal?.abstract ?? '')),
        ),
        h(
          'div',
          { class: 'stack' },
          card('Score', h('div', null, h('div', { class: 'mean' }, c.meanScore.toFixed(2), h('small', null, ' / 5 mean of three reviews')), h('div', { class: 'score-grid', style: 'grid-template-columns:1fr' }, perCriterion.map(([n, v]) => h('div', { class: 'score-item' }, h('span', null, n), h('b', null, v.toFixed(2))))))),
          b ? card('Budget impact', budgetImpact(c, b)) : null,
          card('History', timelineList(timeline)),
        ),
      ),
    );
  });
}

function budgetImpact(c, b) {
  const fits = c.requestedMinor <= b.remainingMinor;
  const after = b.remainingMinor - c.requestedMinor;
  return h(
    'div',
    null,
    h('dl', { class: 'facts' }, h('dt', null, 'Requested'), h('dd', null, h('strong', null, money(c.requestedMinor))), h('dt', null, 'Remaining now'), h('dd', null, money(b.remainingMinor)), h('dt', null, 'If awarded'), h('dd', null, fits ? `${money(after)} left` : h('span', { style: 'color:var(--bad);font-weight:700' }, `${money(-after)} over the envelope`))),
    h('div', { style: 'margin-top:12px' }, meter(b.envelopeMinor, b.committedMinor, c.status === 'decided' ? 0 : c.requestedMinor)),
    h('p', { class: 'small muted', style: 'margin:8px 0 0' }, `Envelope ${money(b.envelopeMinor)} · fixed at publication. `, ruleRef('INV-9')),
  );
}

function decidedPanel(c) {
  const d = c.decision;
  return card(
    'Panel decision',
    h(
      'div',
      null,
      alertBox(d.outcome === 'award' ? 'ok' : 'info', d.outcome === 'award' ? `Awarded ${money(d.amountMinor)}` : 'Declined', h('p', null, `“${d.rationale}”`), h('p', { class: 'small' }, `Recorded by ${c.decidedByName ?? 'the panel chair'} on ${dateTime(d.decidedAt)}. Decisions are final.`)),
    ),
  );
}

function decisionPanel(el, c, fits) {
  const reconsider = c.status === 'reconsider';
  const awardBlocked = reconsider || !!c.integrityHold;
  const choice = (v, title, desc, disabled) =>
    h('label', { class: 'choice', style: disabled ? 'opacity:.6;cursor:not-allowed' : null }, h('input', { type: 'radio', name: 'outcome', value: v, disabled }), h('span', null, h('strong', null, title), h('span', { class: 'small muted' }, desc)));
  const rationale = h('textarea', { name: 'rationale', id: 'f-rationale', rows: 4, placeholder: 'The panel’s reasons. The applicant receives this text.' });
  const area = h('div');
  const errors = h('div', { tabindex: '-1' });
  const next = h('button', { class: 'btn btn-primary', type: 'button' }, 'Continue…');
  const form = h(
    'div',
    null,
    c.budget && !reconsider
      ? h(
          'p',
          { class: 'budget-line' },
          fits
            ? `Awarding ${money(c.requestedMinor)} would leave ${money(c.budget.remainingMinor - c.requestedMinor)} of the ${money(c.budget.envelopeMinor)} envelope.`
            : `Awarding ${money(c.requestedMinor)} would exceed the envelope: only ${money(c.budget.remainingMinor)} of ${money(c.budget.envelopeMinor)} remains.`,
        )
      : null,
    reconsider ? alertBox('warn', 'The award was refused: the budget cannot cover it', h('p', null, 'The envelope is fixed and never grows, so the only remaining outcome is to decline. ', ruleRef('INV-9'))) : null,
    !reconsider && !fits && !c.integrityHold ? alertBox('warn', 'This request exceeds what remains in the budget', h('p', null, 'If you try to award it, Quorum will refuse and nothing will be committed.')) : null,
    errors,
    h(
      'fieldset',
      { class: 'field', style: 'margin-top:14px' },
      h('legend', null, 'Outcome'),
      h('div', { class: 'choice-list' }, choice('award', `Award ${money(c.requestedMinor)}`, awardBlocked ? (reconsider ? 'Not possible — the envelope cannot fund it.' : 'Not possible while the integrity hold stands.') : 'Commits the full requested amount against the call’s budget.', awardBlocked), choice('decline', 'Decline', 'The proposal is not funded this round.', false)),
    ),
    h('div', { class: 'field' }, h('label', { for: 'f-rationale' }, 'Rationale'), h('div', { class: 'hint' }, 'Required. At least 20 characters; kept in the audit trail.'), rationale, counter(rationale, 20)),
    h('div', { class: 'form-actions' }, next),
    area,
  );
  const key = crypto.randomUUID();
  next.addEventListener('click', () => {
    errors.replaceChildren();
    const outcome = form.querySelector('input[name=outcome]:checked')?.value;
    const why = rationale.value.trim();
    const problems = [];
    if (!outcome) problems.push('Choose award or decline.');
    if (why.length < 20) problems.push('Write a rationale of at least 20 characters.');
    if (problems.length) {
      errors.replaceChildren(alertBox('bad', 'Not ready to record', h('ul', null, problems.map((p) => h('li', null, p)))));
      errors.focus();
      return;
    }
    const award = outcome === 'award';
    area.replaceChildren(
      confirmStep({
        tone: award ? 'warn' : 'danger',
        title: award ? `Award ${money(c.requestedMinor)} to “${c.title}”?` : `Decline “${c.title}”?`,
        body: h('div', null, h('p', null, award ? 'The amount is committed against the call’s envelope immediately, and the applicant is told.' : 'The applicant is told the proposal was not funded, with your rationale.'), h('p', { class: 'small' }, h('strong', null, 'Rationale: '), `“${why}”`)),
        ack: 'I am recording the panel’s decision. It is final and cannot be changed.',
        confirmLabel: award ? 'Record award' : 'Record decline',
        onCancel: () => area.replaceChildren(),
        onConfirm: async (btn) => {
          btn.disabled = true;
          try {
            await post(`/api/adjudications/${c.proposalId}/decision`, { outcome, rationale: why }, { key });
            toast(award ? 'Award recorded. The applicant has been notified.' : 'Decline recorded. The applicant has been notified.');
            decision(el, c.proposalId);
          } catch (e) {
            if (e.code === 'envelope_exceeded') {
              toast('Award refused — over budget. Nothing was committed.', 'bad');
              decision(el, c.proposalId);
              return;
            }
            btn.disabled = false;
            area.prepend(alertBox('bad', 'Not recorded', h('p', null, e.message, ' ', ruleRef(e.rule))));
          }
        },
      }),
    );
  });
  return card('Record the panel’s decision', form);
}
