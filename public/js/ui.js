// DOM helpers. Everything is built with createElement/textContent — no innerHTML with data, so
// proposal titles, abstracts and review comments can never inject markup.
import { ApiError, newKey } from './api.js';

export function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v === false || v === null || v === undefined) continue;
    if (k === 'class') el.className = v;
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k === 'style') el.style.cssText = v; // CSSOM, permitted by the CSP (style attributes are not)
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'value' && 'value' in el) el.value = v;
    else if (k === 'checked') el.checked = !!v;
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  append(el, children);
  return el;
}
function append(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}
// Views compose optional parts as `cond ? node : null`; make replaceChildren skip those exactly as h() does.
const nativeReplace = Element.prototype.replaceChildren;
Element.prototype.replaceChildren = function (...nodes) {
  return nativeReplace.apply(this, nodes.flat(Infinity).filter((n) => n !== null && n !== undefined && n !== false));
};
export const frag = (...c) => { const f = document.createDocumentFragment(); append(f, c); return f; };

const SVG = {
  bell: 'M18 8a6 6 0 1 0-12 0c0 7-3 9-3 9h18s-3-2-3-9M13.73 21a2 2 0 0 1-3.46 0',
  check: 'M20 6 9 17l-5-5',
  alert: 'M12 9v4m0 4h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z',
  info: 'M12 16v-4m0-4h.01M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0z',
  lock: 'M7 11V7a5 5 0 0 1 10 0v4M5 11h14v10H5z',
  inbox: 'M22 12h-6l-2 3h-4l-2-3H2M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z',
  clock: 'M12 6v6l4 2M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0z',
  logo: 'M16.5 16.5 21 21M18 11a7 7 0 1 1-14 0 7 7 0 0 1 14 0z',
  shield: 'M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z',
};
export function icon(name, size = 18) {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('viewBox', '0 0 24 24');
  s.setAttribute('width', size);
  s.setAttribute('height', size);
  s.setAttribute('fill', 'none');
  s.setAttribute('stroke', 'currentColor');
  s.setAttribute('stroke-width', '2');
  s.setAttribute('stroke-linecap', 'round');
  s.setAttribute('stroke-linejoin', 'round');
  s.setAttribute('aria-hidden', 'true');
  s.classList.add('ico');
  const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  p.setAttribute('d', SVG[name] ?? SVG.info);
  s.append(p);
  return s;
}

// ------------------------------------------------------------ formatting
const money0 = new Intl.NumberFormat('en-CA', { style: 'currency', currency: 'CAD', maximumFractionDigits: 0 });
export const money = (minor) => money0.format((minor ?? 0) / 100);
const dFmt = new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: 'short', day: 'numeric' });
const dtFmt = new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
export const date = (iso) => (iso ? dFmt.format(new Date(iso)) : '—');
export const dateTime = (iso) => (iso ? dtFmt.format(new Date(iso)) : '—');
let nowOffset = 0; // demo clock: the server's notion of "now"
export const setServerNow = (iso) => (nowOffset = new Date(iso).getTime() - Date.now());
export const now = () => new Date(Date.now() + nowOffset);
export const DAY = 86400000;
export function relDays(iso) {
  const days = Math.round((new Date(iso).getTime() - now().getTime()) / DAY);
  if (days === 0) return 'today';
  if (days === 1) return 'tomorrow';
  if (days === -1) return 'yesterday';
  return days > 0 ? `in ${days} days` : `${-days} days ago`;
}
export function dueLabel(iso) {
  const ms = new Date(iso).getTime() - now().getTime();
  const days = Math.ceil(ms / DAY);
  if (ms < 0) return { text: `${Math.floor(-ms / DAY) || 'less than 1'} day${Math.floor(-ms / DAY) === 1 ? '' : 's'} overdue`, tone: 'bad' };
  if (days <= 3) return { text: `due ${days <= 1 ? 'within a day' : `in ${days} days`}`, tone: 'warn' };
  return { text: `due ${date(iso)}`, tone: 'plain' };
}
export const initials = (name) => (name ?? '?').replace(/^(Dr|Prof)\.?\s+/i, '').split(/\s+/).map((p) => p[0]).slice(0, 2).join('').toUpperCase();
export const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

// ------------------------------------------------------------ status vocabulary (one place)
export const PROPOSAL_STATUS = {
  draft: ['Draft', 'plain'],
  submitted: ['Submitted', 'info'],
  screening: ['In screening', 'info'],
  eligible: ['Eligible', 'accent'],
  ineligible: ['Ineligible', 'bad'],
  underReview: ['Under review', 'accent'],
  scored: ['Scored — awaiting decision', 'warn'],
  awarded: ['Awarded', 'ok'],
  declined: ['Declined', 'bad'],
  withdrawn: ['Withdrawn', 'plain'],
};
export const ASSIGNMENT_STATUS = {
  assigned: ['Awaiting acceptance', 'info'],
  accepted: ['In progress', 'accent'],
  overdue: ['Overdue', 'bad'],
  completed: ['Submitted', 'ok'],
  revoked: ['Withdrawn', 'plain'],
};
export function pill(map, status, extraClass = '') {
  const [label, tone] = map[status] ?? [status, 'plain'];
  return h('span', { class: `pill ${tone} ${extraClass}` }, label);
}
export const statusPill = (s) => pill(PROPOSAL_STATUS, s);

// ------------------------------------------------------------ building blocks
export function alertBox(tone, title, ...body) {
  const ico = { info: 'info', ok: 'check', warn: 'alert', bad: 'alert' }[tone];
  return h('div', { class: `alert ${tone}`, role: tone === 'bad' ? 'alert' : null }, icon(ico), h('div', null, title ? h('strong', null, title) : null, ...body));
}
export function empty(iconName, title, text, action) {
  return h('div', { class: 'empty' }, h('div', { class: 'empty-ico' }, icon(iconName, 22)), h('h3', null, title), text ? h('p', null, text) : null, action ?? null);
}
/** A whole-page empty or error state: the page's single h1. */
export function emptyPage(iconName, title, text, action) {
  return h('div', { class: 'card' }, h('div', { class: 'empty' }, h('div', { class: 'empty-ico' }, icon(iconName, 22)), h('h1', { class: 'empty-title' }, title), text ? h('p', null, text) : null, action ?? null));
}
export function card(title, body, opts = {}) {
  return h(
    'section',
    { class: `card ${opts.class ?? ''}`, 'aria-labelledby': opts.id ?? null },
    title ? h('div', { class: 'card-head' }, h(opts.level ?? 'h2', { id: opts.id ?? null }, title), opts.actions ?? null) : null,
    opts.flush ? body : h('div', { class: 'card-body' }, body),
    opts.foot ? h('div', { class: 'card-foot' }, opts.foot) : null,
  );
}
export function skeleton(lines = 4) {
  return h('div', { class: 'card card-pad', 'aria-busy': 'true', 'aria-label': 'Loading' }, Array.from({ length: lines }, (_, i) => h('div', { class: 'skeleton', style: `width:${90 - i * 12}%` })));
}
export function ruleRef(rule) {
  return rule ? h('span', { class: 'rule-ref', title: `Quorum rule ${rule}` }, rule) : null;
}
export function dots(n) {
  return h('span', { class: 'dots', 'aria-label': `${n} out of 5` }, [1, 2, 3, 4, 5].map((i) => h('i', { class: i <= n ? 'on' : '' })));
}
export function meter(envelope, committed, pending = 0) {
  const pct = (v) => `${Math.max(0, Math.min(100, (v / Math.max(envelope, 1)) * 100))}%`;
  const over = Math.max(0, committed + pending - envelope);
  return h(
    'div',
    { class: 'meter', role: 'img', 'aria-label': `${money(committed)} committed of ${money(envelope)}${pending ? `, ${money(pending)} pending` : ''}` },
    h('div', { class: 'committed', style: `width:${pct(committed)}` }),
    pending ? h('div', { class: over ? 'over' : 'pending', style: `width:${pct(Math.min(pending, Math.max(0, envelope - committed)) || (over ? 3 : 0))}` }) : null,
  );
}

// ------------------------------------------------------------ toasts
export function toast(message, tone = 'ok') {
  const box = document.getElementById('toasts');
  const t = h(
    'div',
    { class: `toast ${tone}` },
    icon(tone === 'ok' ? 'check' : 'alert'),
    h('span', null, message),
    h('button', { type: 'button', class: 'toast-close', 'aria-label': 'Dismiss notification', onclick: () => t.remove() }, '×'),
  );
  box.append(t);
  while (box.children.length > 2) box.firstElementChild.remove(); // newest two only
  setTimeout(() => t.remove(), 5000);
}

// ------------------------------------------------------------ forms: actionable errors, values preserved
/**
 * Wire a form to an async action. On a refusal the form keeps every value the person typed, shows a
 * summary at the top (focused, with links to fields) and inline messages per field. The same
 * Idempotency-Key is reused when the person retries the same unchanged input.
 */
export function bindForm(form, action, opts = {}) {
  const summary = h('div', { class: 'form-summary', tabindex: '-1' });
  form.prepend(summary);
  let key = newKey();
  form.addEventListener('input', () => (key = newKey()));
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    clearErrors(form, summary);
    const btn = ev.submitter ?? form.querySelector('button[type=submit]');
    const label = btn?.innerHTML;
    if (btn) {
      btn.disabled = true;
      btn.replaceChildren(h('span', { class: 'spinner', 'aria-hidden': 'true' }), ' ', opts.busy ?? 'Saving…');
    }
    try {
      await action(new FormData(form), { key, submitter: btn });
      key = newKey();
    } catch (e) {
      showErrors(form, summary, e, opts);
    } finally {
      if (btn && btn.isConnected) {
        btn.disabled = false;
        btn.innerHTML = label;
      }
    }
  });
}

export function clearErrors(form, summary) {
  summary?.replaceChildren();
  form.querySelectorAll('.field-error').forEach((n) => n.remove());
  form.querySelectorAll('.invalid').forEach((n) => n.classList.remove('invalid'));
  form.querySelectorAll('[aria-invalid]').forEach((n) => n.removeAttribute('aria-invalid'));
}

export function showErrors(form, summary, e, opts = {}) {
  if (!(e instanceof ApiError)) {
    console.error(e);
    e = new ApiError(0, { error: { message: 'Something unexpected went wrong. Your input is still here; please try again.' } });
  }
  const items = [];
  for (const f of e.fields ?? []) {
    const name = opts.fieldMap?.[f.field] ?? f.field;
    const input = form.querySelector(`[name="${CSS.escape(name)}"]`);
    const holder = input?.closest('.field, fieldset');
    if (holder) {
      holder.classList.add('invalid');
      const id = `err-${name.replace(/\W/g, '-')}`;
      holder.append(h('div', { class: 'field-error', id }, icon('alert', 15), f.message));
      if (input) {
        input.setAttribute('aria-invalid', 'true');
        input.setAttribute('aria-describedby', id);
      }
      items.push(h('li', null, h('a', { href: `#${input?.id || ''}`, onclick: (ev) => { ev.preventDefault(); input?.focus(); } }, f.message)));
    } else {
      items.push(h('li', null, f.message));
    }
  }
  const title = e.status === 0 ? 'Not sent' : e.status >= 500 ? 'Quorum hit a problem' : 'This could not be done yet';
  summary.replaceChildren(
    alertBox(
      'bad',
      title,
      h('p', null, e.message, ' ', ruleRef(e.rule)),
      items.length ? h('ul', null, items) : null,
      e.status >= 500 && e.requestId ? h('p', { class: 'small' }, `Reference ${e.requestId}.`) : null,
    ),
  );
  summary.focus();
}

export function field(label, input, hint) {
  const id = input.id || `f-${input.name}`;
  input.id = id;
  return h('div', { class: 'field' }, h('label', { for: id }, label), hint ? h('div', { class: 'hint', id: `${id}-hint` }, hint) : null, input);
}

export function counter(textarea, min) {
  const c = h('div', { class: 'counter', 'aria-live': 'polite' });
  const upd = () => {
    const n = textarea.value.trim().length;
    c.textContent = min && n < min ? `${n} characters — at least ${min} needed` : `${n} characters`;
    c.classList.toggle('under', !!min && n < min);
  };
  textarea.addEventListener('input', upd);
  upd();
  return c;
}

/** An irreversible action: a second, explicit step with an acknowledgement checkbox. */
export function confirmStep({ title, body, ack, confirmLabel, tone = 'warn', onConfirm, onCancel }) {
  const box = h('div', { class: `confirm-box ${tone === 'danger' ? 'danger' : ''}`, role: 'group', 'aria-labelledby': 'confirm-title' });
  const cb = h('input', { type: 'checkbox', id: 'confirm-ack' });
  const go = h('button', { type: 'button', class: `btn ${tone === 'danger' ? 'btn-danger' : 'btn-primary'}`, disabled: true }, confirmLabel);
  cb.addEventListener('change', () => (go.disabled = !cb.checked));
  go.addEventListener('click', () => onConfirm(go));
  box.append(
    h('h3', { id: 'confirm-title' }, title),
    h('div', null, body),
    h('label', { class: 'check', for: 'confirm-ack' }, cb, h('span', null, ack)),
    h('div', { class: 'form-actions' }, go, h('button', { type: 'button', class: 'btn btn-ghost', onclick: onCancel }, 'Go back')),
  );
  setTimeout(() => cb.focus(), 0);
  return box;
}

/** Render an async view with loading and error states. */
export async function load(container, fn) {
  container.replaceChildren(skeleton());
  try {
    await fn();
  } catch (e) {
    const err = e instanceof ApiError ? e : null;
    if (!err || err.status >= 500 || err.status === 0) console.error(e); // expected refusals are shown, not logged
    container.replaceChildren(
      err?.status === 404
        ? emptyPage('info', 'Not found', 'This item does not exist, or you do not have access to it.', h('a', { class: 'btn', href: '#/' }, 'Back to your workspace'))
        : h(
            'div',
            { class: 'card card-pad' },
            h('h1', { class: 'empty-title' }, 'Something went wrong'),
            alertBox('bad', 'This page could not be loaded', h('p', null, err?.message ?? 'An unexpected error occurred.')),
            h('div', { class: 'form-actions' }, h('button', { class: 'btn', onclick: () => load(container, fn) }, 'Try again')),
          ),
    );
  }
}
