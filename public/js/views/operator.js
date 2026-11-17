// Operator workspace: delivery health and recovery (retry, or skip with a reason), backups,
// personal-data erasure, and the append-only log of operator actions. The operator holds no business role.
import { get, post } from '../api.js';
import { h, card, empty, load, dateTime, alertBox, bindForm, field, toast, confirmStep, counter, plural } from '../ui.js';

const ago = (iso) => {
  if (!iso) return 'never';
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  return s < 90 ? 'just now' : s < 5400 ? `${Math.round(s / 60)} minutes ago` : s < 129600 ? `${Math.round(s / 3600)} hours ago` : `${Math.round(s / 86400)} days ago`;
};

export async function home(el) {
  await load(el, async () => {
    const [hl, actions] = await Promise.all([get('/api/operations/health'), get('/api/operations/actions')]);
    const reload = () => home(el);
    const failed = hl.delivery.failed ?? [];
    const out = Object.fromEntries((hl.outbound ?? []).map((r) => [r.status, r.n]));
    el.replaceChildren(
      h('div', { class: 'page-head' }, h('div', null, h('div', { class: 'eyebrow' }, 'Operations'), h('h1', null, 'System health'), h('p', { class: 'lede' }, 'Event delivery, email, backups and data-protection requests. Every action here is recorded with your name and reason.'))),
      h(
        'div',
        { class: 'stat-row', style: 'margin-bottom:18px' },
        stat('Events waiting', hl.delivery.pending, hl.delivery.oldestPendingAgeSeconds > 300 ? 'attention' : 'calm'),
        stat('Parked deliveries', failed.length, failed.length ? 'danger' : 'calm'),
        stat('Emails failed', out.failed ?? 0, out.failed ? 'danger' : 'calm'),
        stat('Last backup', ago(hl.backup.lastAt), hl.backup.lastAt ? 'calm' : 'attention'),
      ),
      card('Parked deliveries', failed.length ? h('ul', { class: 'queue' }, failed.map((f) => parkedItem(f, reload))) : empty('check', 'Nothing is parked', 'Every event has reached every part of Quorum.'), { flush: true }),
      h('div', { class: 'grid grid-cols', style: 'margin-top:20px' }, backupCard(hl, reload), erasureCard(reload)),
      h('section', { style: 'margin-top:20px' }, card('Operator actions', actionsTable(actions), { flush: true })),
    );
  });
}

const stat = (label, value, tone) => h('div', { class: `stat ${tone}` }, h('div', { class: 'label' }, label), h('div', { class: 'value' }, String(value)));

function parkedItem(f, reload) {
  const li = h('li', null);
  const retry = h('button', { class: 'btn btn-sm', type: 'button' }, 'Retry');
  const skip = h('button', { class: 'btn btn-sm btn-ghost', type: 'button', disabled: f.skippable ? null : true, title: f.skippable ? null : 'This part of Quorum guards a rule; fix the cause and retry.' }, 'Skip…');
  retry.addEventListener('click', async () => {
    retry.disabled = true;
    try {
      await post('/api/operations/deliveries/retry', { consumer: f.consumer, messageId: f.messageId, reason: 'retried from the operator page' });
      toast('Retry scheduled.');
      setTimeout(reload, 800);
    } catch (e) {
      retry.disabled = false;
      toast(e.message, 'bad');
    }
  });
  skip.addEventListener('click', () => {
    const reason = h('textarea', { name: 'reason', rows: 3, required: true, minlength: 10, maxlength: 500 });
    const form = h(
      'form',
      { novalidate: true },
      alertBox('warn', 'Skipping drops this event for this part of Quorum', h('p', null, 'Anything it would have done is lost, including data later events rely on (for notifications, later emails about the same proposal may not be sent). Prefer retry once the cause is fixed.')),
      field('Why are you skipping it?', reason, 'Recorded in the operator log. At least 10 characters.'),
      counter(reason, 10),
      h('div', { class: 'form-actions' }, h('button', { class: 'btn btn-danger', type: 'submit' }, 'Skip this delivery'), h('button', { class: 'btn btn-ghost', type: 'button', onclick: reload }, 'Cancel')),
    );
    bindForm(form, async (fd, { key }) => {
      await post('/api/operations/deliveries/skip', { consumer: f.consumer, messageId: f.messageId, reason: String(fd.get('reason') ?? '').trim() }, { key });
      toast('Delivery skipped and recorded.');
      reload();
    }, { busy: 'Skipping…' });
    li.append(h('div', { style: 'grid-column:1 / -1' }, form));
    skip.disabled = true;
    setTimeout(() => reason.focus(), 0);
  });
  li.append(
    h('div', null, h('span', { class: 'q-title' }, `${f.type} → ${f.consumer}`), h('div', { class: 'q-meta' }, h('span', null, plural(f.attempts, 'attempt')), h('span', null, dateTime(f.occurredAt)), h('span', { class: 'mono' }, f.lastError ?? ''))),
    h('div', { class: 'row' }, retry, skip),
  );
  return li;
}

function backupCard(hl, reload) {
  const btn = h('button', { class: 'btn', type: 'button' }, 'Back up now');
  const status = h('p', { class: 'small muted', 'aria-live': 'polite' }, hl.backup.lastAt ? `Newest backup: ${dateTime(hl.backup.lastAt)}.` : 'No backup has been taken yet.');
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    status.textContent = 'Backing up…';
    try {
      const r = await post('/api/operations/backup', {});
      toast(`Backup verified (${Math.round(r.bytes / 1024)} KB in ${r.tookMs} ms).`);
      reload();
    } catch (e) {
      btn.disabled = false;
      status.textContent = '';
      toast(e.message, 'bad');
    }
  });
  return card('Backups', h('div', null, h('p', { class: 'small' }, 'Backups are taken online and verified before they count. Restoring is an offline procedure: see the operations runbook.'), status, btn));
}

function erasureCard(reload) {
  const q = h('input', { type: 'search', name: 'q', minlength: 2, maxlength: 200, autocomplete: 'off' });
  const results = h('div', { 'aria-live': 'polite' });
  const form = h('form', { novalidate: true, role: 'search' }, field('Find the account (name, email or id)', q), h('div', { class: 'form-actions' }, h('button', { class: 'btn', type: 'submit' }, 'Find')));
  bindForm(form, async (fd) => {
    const rows = await get(`/api/operations/accounts?q=${encodeURIComponent(String(fd.get('q') ?? '').trim())}`);
    results.replaceChildren(
      rows.length
        ? h('ul', { class: 'queue' }, rows.map((a) => accountRow(a, results, reload)))
        : h('p', { class: 'small muted' }, 'No account matches.'),
    );
  }, { busy: 'Searching…' });
  return card('Erase personal data', h('div', null, h('p', { class: 'small' }, 'For a data-subject request. Names, email, institution and ORCID iD are removed everywhere Quorum holds them; proposals, reviews and decisions are kept and refer to the account by id.'), form, results));
}

function accountRow(a, results, reload) {
  const li = h('li', null, h('div', null, h('span', { class: 'q-title' }, a.name), h('div', { class: 'q-meta' }, h('span', null, a.email), h('span', null, a.roles.join(', ') || 'no roles'), a.erasedAt ? h('span', { class: 'pill plain' }, `erased ${dateTime(a.erasedAt)}`) : null)));
  if (a.erasedAt || a.kind !== 'person') return li;
  const start = h('button', { class: 'btn btn-sm btn-danger', type: 'button' }, 'Erase…');
  start.addEventListener('click', () => {
    const reason = h('textarea', { name: 'reason', rows: 2, maxlength: 500 });
    const box = confirmStep({
      title: `Erase ${a.name}?`,
      tone: 'danger',
      body: h('div', null, h('p', null, 'This cannot be undone. The person can no longer sign in, and their name disappears from notifications, the portfolio and the audit trail.'), field('Request reference and reason', reason, 'Recorded in the operator log. At least 10 characters.')),
      ack: 'I have verified this request and understand it cannot be undone.',
      confirmLabel: 'Erase personal data',
      onCancel: () => {
        wrap.remove();
        start.hidden = false;
        start.focus();
      },
      onConfirm: async (go) => {
        const r = reason.value.trim();
        if (r.length < 10) {
          toast('Give the request reference and reason (at least 10 characters).', 'bad');
          reason.focus();
          return;
        }
        go.disabled = true;
        try {
          const out = await post(`/api/operations/accounts/${a.id}/erase`, { reason: r });
          toast(`Erased. ${plural(out.eventsRedacted, 'event')} redacted.`);
          reload();
        } catch (e) {
          go.disabled = false;
          toast(e.message, 'bad');
        }
      },
    });
    const wrap = h('div', { style: 'grid-column:1 / -1' }, box);
    li.append(wrap);
    start.hidden = true;
  });
  li.append(start);
  return li;
}

function actionsTable(actions) {
  if (!actions.length) return empty('clock', 'No operator actions yet', null);
  return h(
    'div',
    { class: 'table-wrap' },
    h(
      'table',
      { class: 'data stack-sm' },
      h('thead', null, h('tr', null, h('th', null, 'When'), h('th', null, 'Action'), h('th', null, 'Subject'), h('th', null, 'Reason'))),
      h('tbody', null, actions.map((x) => h('tr', null, h('td', { 'data-label': 'When', class: 'nowrap small' }, dateTime(x.at)), h('td', { 'data-label': 'Action' }, x.action), h('td', { 'data-label': 'Subject', class: 'mono small', title: x.subject }, x.subject.split(/[\\/]/).pop()), h('td', { 'data-label': 'Reason', class: 'small' }, x.reason)))),
    ),
  );
}
