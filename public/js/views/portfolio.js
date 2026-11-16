// Portfolio: per-call funnel, budget and ranked proposals. Built only from the Oversight projection.
import { get, session } from '../api.js';
import { h, card, empty, load, statusPill, money, date, meter, plural } from '../ui.js';

const FUNNEL = [
  ['submitted', 'Submitted', ['submitted', 'screening', 'eligible', 'ineligible', 'underReview', 'scored', 'awarded', 'declined']],
  ['eligible', 'Eligible', ['eligible', 'underReview', 'scored', 'awarded', 'declined']],
  ['review', 'Under review', ['underReview']],
  ['scored', 'Awaiting decision', ['scored']],
  ['awarded', 'Awarded', ['awarded']],
];

export async function view(el) {
  await load(el, async () => {
    const calls = await get('/api/portfolio');
    const isChair = session.me.roles.includes('panelChair') && !session.me.roles.includes('programOfficer');
    const link = (p) => (isChair && ['scored', 'awarded', 'declined'].includes(p.status) ? `#/chair/decisions/${p.proposalId}` : !isChair ? `#/officer/proposals/${p.proposalId}` : null);
    let selected = calls[0]?.callId;
    const body = h('div');
    const render = () => {
      const c = calls.find((x) => x.callId === selected);
      if (!c) { body.replaceChildren(card(null, empty('inbox', 'No calls yet', 'The portfolio fills as calls are published and proposals submitted.'))); return; }
      const count = (statuses) => c.proposals.filter((p) => statuses.includes(p.status)).length;
      body.replaceChildren(
        h(
          'div',
          { class: 'stat-row' },
          FUNNEL.map(([k, label, st]) => h('div', { class: 'stat' }, h('div', { class: 'label' }, label), h('div', { class: 'value' }, count(st)))),
        ),
        h(
          'div',
          { class: 'grid grid-2', style: 'margin-top:16px' },
          card(
            `Proposals (${c.proposals.length})`,
            c.proposals.length
              ? h(
                  'div',
                  { class: 'table-wrap' },
                  h(
                    'table',
                    { class: 'data stack-sm' },
                    h('thead', null, h('tr', null, h('th', null, 'Proposal'), h('th', null, 'Status'), h('th', { class: 'num' }, 'Reviews'), h('th', { class: 'num' }, 'Mean'), h('th', { class: 'num' }, 'Requested'))),
                    h(
                      'tbody',
                      null,
                      c.proposals.map((p) =>
                        h(
                          'tr',
                          null,
                          h('td', { class: 'title-cell', 'data-label': 'Proposal' }, link(p) ? h('a', { href: link(p) }, p.title) : h('span', { style: 'font-weight:600' }, p.title), h('small', null, p.applicantName)),
                          h('td', { 'data-label': 'Status' }, statusPill(p.status)),
                          h('td', { class: 'num', 'data-label': 'Reviews' }, ['submitted', 'screening', 'eligible', 'ineligible', 'withdrawn'].includes(p.status) && !p.reviewsSubmitted ? '—' : `${Math.min(p.reviewsSubmitted, 3)} / 3`),
                          h('td', { class: 'num', 'data-label': 'Mean' }, p.meanScore === null ? '—' : p.meanScore.toFixed(2)),
                          h('td', { class: 'num', 'data-label': 'Requested' }, money(p.awardedMinor ?? p.requestedMinor)),
                        ),
                      ),
                    ),
                  ),
                )
              : empty('inbox', 'No submissions yet', 'Proposals appear here once submitted.'),
            { flush: !!c.proposals.length },
          ),
          h(
            'div',
            { class: 'stack' },
            card(
              'Budget',
              h(
                'div',
                null,
                h('div', { class: 'spread' }, h('div', null, h('div', { class: 'small muted' }, 'Awarded'), h('div', { class: 'money-big' }, money(c.committedMinor))), h('div', { style: 'text-align:right' }, h('div', { class: 'small muted' }, 'Remaining'), h('div', { class: 'money-big' }, money(c.remainingMinor)))),
                h('div', { style: 'margin-top:12px' }, meter(c.envelopeMinor, c.committedMinor)),
                h('p', { class: 'small muted', style: 'margin:8px 0 0' }, `Envelope ${money(c.envelopeMinor)}. Awards can never exceed it.`),
              ),
            ),
            card('Call', h('dl', { class: 'facts' }, h('dt', null, 'Status'), h('dd', null, c.status === 'open' ? 'Open' : 'Closed'), h('dt', null, 'Deadline'), h('dd', null, date(c.deadline)), h('dt', null, 'Proposals'), h('dd', null, plural(c.proposals.length, 'proposal')))),
          ),
        ),
      );
    };
    const select = h(
      'select',
      { id: 'portfolio-call', style: 'max-width:420px', onchange: (e) => { selected = e.target.value; render(); } },
      calls.map((c) => h('option', { value: c.callId }, `${c.title} (${c.status})`)),
    );
    el.replaceChildren(
      h('div', { class: 'page-head' }, h('div', null, h('div', { class: 'eyebrow' }, 'Oversight'), h('h1', null, 'Portfolio'), h('p', { class: 'lede' }, 'Where every proposal stands, and how much of each call’s budget is committed.')), calls.length > 1 ? h('div', null, h('label', { for: 'portfolio-call', class: 'small muted', style: 'display:block;font-weight:600' }, 'Call'), select) : null),
      body,
    );
    render();
  });
}
