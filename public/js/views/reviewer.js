// Reviewer workspace: ORCID verification, assignments, the blind review form, peer reviews after submit.
import { get, post, session } from '../api.js';
import { h, card, empty, load, money, date, dateTime, dueLabel, alertBox, bindForm, field, counter, confirmStep, toast, ruleRef, icon, pill, ASSIGNMENT_STATUS, dots, plural } from '../ui.js';

const SCALE = [
  [1, 'Poor'],
  [2, 'Fair'],
  [3, 'Good'],
  [4, 'Very good'],
  [5, 'Excellent'],
];

export async function home(el) {
  await load(el, async () => {
    const [me, list] = await Promise.all([get('/api/me'), get('/api/assignments')]);
    session.me = me;
    const todo = list.filter((a) => ['assigned', 'accepted', 'overdue'].includes(a.status));
    const done = list.filter((a) => a.status === 'completed');
    const gone = list.filter((a) => a.status === 'revoked');
    const overdue = todo.filter((a) => a.status === 'overdue').length;
    el.replaceChildren(
      h('div', { class: 'page-head' }, h('div', null, h('div', { class: 'eyebrow' }, 'Reviewer workspace'), h('h1', null, 'My reviews'), h('p', { class: 'lede' }, 'Proposals you have been asked to review. Your scores stay private from other reviewers until each of you submits.'))),
      me.orcidStatus !== 'verified' ? orcidPanel(el) : null,
      h(
        'div',
        { class: 'stat-row' },
        stat('To do', todo.length, todo.length ? 'attention' : 'calm'),
        stat('Overdue', overdue, overdue ? 'danger' : 'calm'),
        stat('Submitted', done.length, 'calm'),
      ),
      h('div', { class: 'section-title' }, h('h2', null, 'Needs your attention'), h('span', { class: 'count' }, todo.length)),
      todo.length
        ? card(null, h('ul', { class: 'queue' }, todo.sort((a, b) => a.due_at.localeCompare(b.due_at)).map(item)), { flush: true })
        : card(null, empty('check', 'You are all caught up', me.orcidStatus === 'verified' ? 'New assignments appear here, and you will get a notification.' : 'Verify your ORCID iD so program officers can assign proposals to you.')),
      done.length ? h('div', { class: 'section-title' }, h('h2', null, 'Submitted'), h('span', { class: 'count' }, done.length)) : null,
      done.length ? card(null, h('ul', { class: 'queue' }, done.map(item)), { flush: true }) : null,
      gone.length ? h('div', { class: 'section-title' }, h('h2', null, 'Withdrawn assignments'), h('span', { class: 'count' }, gone.length)) : null,
      gone.length ? card(null, h('ul', { class: 'queue' }, gone.map(item)), { flush: true }) : null,
    );
  });
}

const stat = (label, value, tone) => h('div', { class: `stat ${tone}` }, h('div', { class: 'label' }, label), h('div', { class: 'value' }, value));

function item(a) {
  const due = dueLabel(a.due_at);
  const action = { assigned: 'Respond', accepted: 'Write review', overdue: 'Write review now', completed: 'View', revoked: 'Details' }[a.status];
  return h(
    'li',
    null,
    h(
      'div',
      null,
      h('a', { class: 'q-title', href: `#/reviewer/assignments/${a.id}` }, a.proposal?.title ?? 'Proposal'),
      h(
        'div',
        { class: 'q-meta' },
        h('span', { class: 'mono' }, a.proposal?.reference ?? ''),
        pill(ASSIGNMENT_STATUS, a.status),
        ['assigned', 'accepted', 'overdue'].includes(a.status) ? h('span', { class: due.tone === 'bad' ? '' : '' }, h('span', { class: `pill ${due.tone}` }, due.text)) : null,
        a.status === 'completed' ? h('span', null, `Submitted ${date(a.completed_at)}`) : null,
        a.status === 'revoked' ? h('span', null, a.revoke_reason) : null,
      ),
    ),
    h('a', { class: `btn ${['assigned', 'accepted', 'overdue'].includes(a.status) ? 'btn-primary' : ''} btn-sm`, href: `#/reviewer/assignments/${a.id}` }, action),
  );
}

function orcidPanel(el) {
  const input = h('input', { type: 'text', name: 'orcidId', placeholder: '0000-0000-0000-0000', autocomplete: 'off', inputmode: 'text', maxlength: 19, style: 'max-width:280px' });
  const form = h(
    'form',
    { novalidate: true },
    field('Your ORCID iD', input, 'Sixteen characters in four groups, as shown on orcid.org. The last character may be X.'),
    h('div', { class: 'form-actions' }, h('button', { class: 'btn btn-primary', type: 'submit' }, 'Verify ORCID iD')),
  );
  bindForm(form, async (fd, { key }) => {
    await post('/api/me/orcid', { orcidId: String(fd.get('orcidId') ?? '').trim() }, { key });
    toast('ORCID iD verified. You can now be assigned proposals.');
    home(el);
  }, { busy: 'Checking ORCID…' });
  return h(
    'section',
    { class: 'card', style: 'border-left:4px solid var(--warn);margin-bottom:18px' },
    h('div', { class: 'card-body' }, h('h2', null, 'Verify your ORCID iD to start reviewing'), h('p', { class: 'muted' }, 'Quorum only assigns proposals to reviewers whose ORCID iD has been verified against the ORCID registry. ', ruleRef('INV-12')), form),
  );
}

export async function assignment(el, id) {
  await load(el, async () => {
    const d = await get(`/api/assignments/${id}`);
    const a = d.assignment;
    const p = d.proposal;
    const due = dueLabel(a.due_at);
    let main;
    if (a.status === 'assigned') main = respondPanel(el, d);
    else if (a.status === 'accepted' || a.status === 'overdue') main = reviewForm(el, d);
    else if (a.status === 'completed') main = await submittedPanel(d);
    else main = card(null, empty('info', 'This assignment was withdrawn', a.revoke_reason ?? 'You no longer need to review this proposal.'));
    el.replaceChildren(
      h('div', { class: 'crumbs' }, h('a', { href: '#/reviewer' }, 'My reviews'), ' / ', p?.reference ?? ''),
      h(
        'div',
        { class: 'page-head' },
        h('div', null, h('div', { class: 'eyebrow' }, `${p?.reference ?? ''} · ${d.call?.title ?? ''}`), h('h1', null, p?.title ?? 'Proposal')),
        h('div', { class: 'row' }, pill(ASSIGNMENT_STATUS, a.status), ['assigned', 'accepted', 'overdue'].includes(a.status) ? h('span', { class: `pill ${due.tone}` }, due.text) : null),
      ),
      a.status === 'overdue' ? alertBox('warn', 'This review is overdue', h('p', null, `It was due ${dateTime(a.due_at)}; late reviews are still accepted — please submit as soon as you can, or tell the program officer if you cannot.`)) : null,
      h(
        'div',
        { class: 'grid grid-2 proposal-first', style: 'margin-top:16px' },
        h('div', { class: 'stack' }, main),
        h(
          'div',
          { class: 'stack' },
          card('The proposal', h('div', null, h('p', { class: 'abstract' }, p?.abstract ?? ''), h('dl', { class: 'facts', style: 'margin-top:12px' }, h('dt', null, 'Requested'), h('dd', null, money(p?.requestedMinor)), h('dt', null, 'Review due'), h('dd', null, dateTime(a.due_at))))),
          card('How blind review works', h('ul', { class: 'small', style: 'margin:0;padding-left:18px' }, h('li', null, 'Other reviewers’ scores and comments are hidden from you until you submit your own.'), h('li', null, 'Yours are hidden from them in the same way.'), h('li', null, 'Submitted reviews are final and go to the panel.'))),
        ),
      ),
    );
  });
}

function respondPanel(el, d) {
  const a = d.assignment;
  const holder = h('div');
  const accept = h('button', { class: 'btn btn-primary', type: 'button' }, 'Accept assignment');
  const conflictBtn = h('button', { class: 'btn', type: 'button' }, 'I have a conflict of interest…');
  const key = crypto.randomUUID();
  const attest = h('input', { type: 'checkbox', id: 'attest-accept' });
  accept.addEventListener('click', async () => {
    if (!attest.checked) {
      holder.replaceChildren(alertBox('bad', 'Confirm you have no conflict first', h('p', null, 'Tick the confirmation, or declare a conflict instead.')));
      attest.focus();
      return;
    }
    accept.disabled = true;
    try {
      await post(`/api/assignments/${a.id}/accept`, undefined, { key });
      toast('Assignment accepted. You can start your review.');
      assignment(el, a.id);
    } catch (e) {
      accept.disabled = false;
      holder.replaceChildren(alertBox('bad', 'Not accepted', h('p', null, e.message)));
    }
  });
  conflictBtn.addEventListener('click', () => holder.replaceChildren(conflictForm(el, d)));
  return card(
    'Will you review this proposal?',
    h(
      'div',
      null,
      h('p', null, 'Read the abstract, then accept — or declare a conflict if you have a personal, professional or institutional connection to the applicant.'),
      h('label', { class: 'check', for: 'attest-accept' }, attest, h('span', null, 'I have no conflict of interest with this proposal or its applicant.')),
      h('div', { class: 'form-actions', style: 'margin-top:14px' }, accept, conflictBtn),
      holder,
    ),
  );
}

function conflictForm(el, d) {
  const reason = h('textarea', { name: 'reason', rows: 3, placeholder: 'For example: same department as the applicant; co-authored a paper in the last three years.' });
  const form = h(
    'form',
    { novalidate: true, class: 'confirm-box' },
    h('h3', null, 'Declare a conflict of interest'),
    h('p', { class: 'small' }, 'Your assignment will be withdrawn and the program officer will assign someone else. You will not be able to review this proposal. ', ruleRef('INV-3')),
    field('What is the conflict?', reason),
    h('div', { class: 'form-actions' }, h('button', { class: 'btn btn-danger', type: 'submit' }, 'Declare conflict and withdraw')),
  );
  bindForm(form, async (fd, { key }) => {
    await post('/api/conflicts', { proposalId: d.assignment.proposal_id, reason: String(fd.get('reason') ?? '').trim() }, { key });
    toast('Conflict recorded. The assignment has been withdrawn.');
    location.hash = '#/reviewer';
  }, { busy: 'Recording…' });
  return form;
}

const draftKey = (id) => `quorum.review-draft.${id}`;

function reviewForm(el, d) {
  const a = d.assignment;
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(draftKey(a.id)) ?? '{}'); } catch { saved = {}; }
  const criteria = d.criteria;
  const fieldsets = criteria.map((c, i) =>
    h(
      'fieldset',
      { class: 'criterion', id: `crit-${c.id}` },
      h('legend', null, `${i + 1}. ${c.name}`),
      c.guidance ? h('div', { class: 'hint' }, c.guidance) : null,
      h(
        'div',
        { class: 'scale', role: 'radiogroup', 'aria-label': `${c.name}, score from 1 to 5` },
        SCALE.map(([v, label]) =>
          h('label', null, h('input', { type: 'radio', name: `scores.${c.id}`, value: v, checked: saved.scores?.[c.id] === v, 'aria-label': `${v} — ${label}` }), h('span', { 'aria-hidden': 'true' }, String(v), h('small', null, label))),
        ),
      ),
    ),
  );
  const comment = h('textarea', { name: 'comment', id: 'f-comment', rows: 8, placeholder: 'Strengths, weaknesses and what would make this proposal stronger. The panel reads this alongside your scores.' }, saved.comment ?? '');
  const attest = h('input', { type: 'checkbox', name: 'attestsNoConflict', id: 'f-attest', checked: !!saved.attest });
  const progress = h('div', { class: 'small muted', 'aria-live': 'polite' });
  const form = h(
    'form',
    { novalidate: true },
    h('div', null, fieldsets),
    h('div', { class: 'field', style: 'margin-top:8px' }, h('label', { for: 'f-comment' }, 'Comments for the panel'), h('div', { class: 'hint' }, 'At least 30 characters. Not shared with other reviewers until they submit.'), comment, counter(comment, 30)),
    h('fieldset', { class: 'field' }, h('label', { class: 'check', for: 'f-attest' }, attest, h('span', null, 'I confirm I have no conflict of interest with this proposal or its applicant.'))),
    h('div', { class: 'form-actions' }, h('button', { class: 'btn btn-primary', type: 'submit' }, 'Review and submit…'), progress),
  );
  const collect = () => {
    const fd = new FormData(form);
    const scores = {};
    for (const c of criteria) {
      const v = fd.get(`scores.${c.id}`);
      if (v !== null) scores[c.id] = Number(v);
    }
    return { scores, comment: comment.value, attestsNoConflict: attest.checked };
  };
  const persist = () => {
    const v = collect();
    try { localStorage.setItem(draftKey(a.id), JSON.stringify({ scores: v.scores, comment: v.comment, attest: v.attestsNoConflict })); } catch { /* ignore */ }
    const n = Object.keys(v.scores).length;
    progress.textContent = `${n} of ${criteria.length} criteria scored · draft kept on this device`;
  };
  form.addEventListener('input', persist);
  form.addEventListener('change', persist);
  persist();

  const confirmHolder = h('div');
  const submitKey = crypto.randomUUID();
  bindForm(
    form,
    async () => {
      const v = collect();
      const missing = criteria.filter((c) => v.scores[c.id] === undefined);
      const fields = missing.map((c) => ({ field: `scores.${c.id}`, message: `Score “${c.name}” from 1 to 5.` }));
      if (v.comment.trim().length < 30) fields.push({ field: 'comment', message: 'Write at least 30 characters for the panel.' });
      if (!v.attestsNoConflict) fields.push({ field: 'attestsNoConflict', message: 'Confirm you have no conflict of interest, or declare one instead.' });
      if (fields.length) {
        const { ApiError } = await import('../api.js');
        throw new ApiError(422, { error: { message: 'Your review is not complete yet. Nothing was sent; your answers are kept.', rule: 'INV-6', fields } });
      }
      const mean = Object.values(v.scores).reduce((s, x) => s + x, 0) / criteria.length;
      confirmHolder.replaceChildren(
        confirmStep({
          title: 'Submit your review?',
          body: h('div', null, h('p', null, `Your mean score is ${mean.toFixed(2)} across ${plural(criteria.length, 'criterion', 'criteria')}.`), h('p', null, 'Submitted reviews are final. Once you submit, you will see the other reviewers’ submitted reviews for this proposal.')),
          ack: 'My scores and comments are final.',
          confirmLabel: 'Submit review',
          onCancel: () => confirmHolder.replaceChildren(),
          onConfirm: async (btn) => {
            btn.disabled = true;
            try {
              await post(`/api/assignments/${a.id}/review`, collect(), { key: submitKey });
              try { localStorage.removeItem(draftKey(a.id)); } catch { /* ignore */ }
              toast('Review submitted. Thank you.');
              assignment(el, a.id);
            } catch (e) {
              btn.disabled = false;
              confirmHolder.prepend(alertBox('bad', 'Not submitted', h('p', null, e.message, ' ', ruleRef(e.rule)), e.fields?.length ? h('ul', null, e.fields.map((f) => h('li', null, f.message))) : null));
            }
          },
        }),
      );
      confirmHolder.scrollIntoView({ behavior: 'smooth', block: 'center' });
    },
    { busy: 'Checking…', fieldMap: Object.fromEntries(criteria.map((c) => [`scores.${c.id}`, `scores.${c.id}`])) },
  );
  return card('Your review', h('div', null, form, confirmHolder), {
    actions: h('button', { class: 'btn btn-ghost btn-sm', type: 'button', onclick: (e) => e.currentTarget.closest('.card').after(conflictForm(el, d)) }, 'Declare a conflict'),
  });
}

async function submittedPanel(d) {
  const peers = await get(`/api/proposals/${d.assignment.proposal_id}/reviews`);
  const crit = new Map(d.criteria.map((c) => [c.id, c.name]));
  const others = peers.reviews.filter((r) => !r.own);
  return h(
    'div',
    { class: 'stack' },
    alertBox('ok', 'Your review is submitted', h('p', null, `Submitted ${dateTime(d.review?.submittedAt)}. Thank you.`)),
    card('Your review', reviewBlock({ label: 'Your review', own: true, scores: d.review?.scores ?? {}, comment: d.review?.comment ?? '', mean: avg(d.review?.scores) }, crit)),
    card(
      'Other reviewers',
      peers.visible
        ? others.length
          ? h('div', null, h('p', { class: 'small muted' }, 'Reviewer identities are not shown.'), others.map((r) => reviewBlock(r, crit)))
          : empty('clock', 'No other reviews submitted yet', 'Other reviewers’ submitted reviews will appear here.')
        : h('div', { class: 'locked' }, icon('lock'), h('p', null, peers.lockedReason)),
    ),
  );
}

const avg = (s) => {
  const v = Object.values(s ?? {});
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : 0;
};

export function reviewBlock(r, crit) {
  return h(
    'article',
    { class: `review ${r.own ? 'own' : ''}` },
    h('div', { class: 'spread' }, h('strong', null, r.reviewerName ? `${r.reviewerName}` : r.label), h('span', { class: 'mean', style: 'font-size:1.25rem' }, r.mean.toFixed(2), h('small', null, ' / 5'))),
    h('div', { class: 'score-grid' }, Object.entries(r.scores).map(([k, v]) => h('div', { class: 'score-item' }, h('span', null, crit.get(k) ?? k), h('span', null, dots(v), ' ', h('b', null, v))))),
    h('p', { class: 'small', style: 'margin:0;white-space:pre-wrap' }, r.comment),
  );
}
