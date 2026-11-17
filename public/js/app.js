// Quorum SPA shell: hash router, role-aware navigation, sign-in, notifications, demo clock.
import { session, get, post, setUnauthorizedHandler } from './api.js';
import { h, icon, initials, bindForm, field, alertBox, empty, emptyPage, load, card, dateTime, setServerNow, toast, now, date } from './ui.js';
import * as applicant from './views/applicant.js';
import * as officer from './views/officer.js';
import * as reviewer from './views/reviewer.js';
import * as chair from './views/chair.js';
import * as portfolio from './views/portfolio.js';
import * as operator from './views/operator.js';

const ROLE_LABEL = { applicant: 'Applicant', reviewer: 'Reviewer', programOfficer: 'Program officer', panelChair: 'Panel chair', operator: 'Operator' };
const ROLE_HOME = { programOfficer: '#/officer', panelChair: '#/chair', reviewer: '#/reviewer', applicant: '#/applicant', operator: '#/operator' };
const ROLE_ORDER = ['programOfficer', 'panelChair', 'reviewer', 'applicant', 'operator'];
const NAV = {
  applicant: [['#/applicant', 'My proposals'], ['#/calls', 'Open calls']],
  reviewer: [['#/reviewer', 'My reviews']],
  programOfficer: [['#/officer', 'Work queue'], ['#/officer/calls', 'Calls'], ['#/portfolio', 'Portfolio'], ['#/officer/activity', 'Audit log']],
  panelChair: [['#/chair', 'Decisions'], ['#/portfolio', 'Portfolio']],
  operator: [['#/operator', 'System health']],
};

let health = null;
let unread = 0;

const ROUTES = [
  [/^#\/signin$/, () => signIn(), { public: true }],
  [/^#\/register$/, () => register(), { public: true }],
  [/^#\/applicant$/, (m, el) => applicant.home(el), { role: 'applicant' }],
  [/^#\/calls$/, (m, el) => applicant.calls(el), { role: 'applicant' }],
  [/^#\/calls\/([\w-]+)$/, (m, el) => applicant.call(el, m[1]), { role: 'applicant' }],
  [/^#\/proposals\/([\w-]+)$/, (m, el) => applicant.proposal(el, m[1]), { role: 'applicant' }],
  [/^#\/reviewer$/, (m, el) => reviewer.home(el), { role: 'reviewer' }],
  [/^#\/reviewer\/assignments\/([\w-]+)$/, (m, el) => reviewer.assignment(el, m[1]), { role: 'reviewer' }],
  [/^#\/officer$/, (m, el) => officer.queue(el, { onClock: refreshHealth }), { role: 'programOfficer' }],
  [/^#\/officer\/proposals\/([\w-]+)$/, (m, el) => officer.proposal(el, m[1]), { role: 'programOfficer' }],
  [/^#\/officer\/calls$/, (m, el) => officer.calls(el), { role: 'programOfficer' }],
  [/^#\/officer\/activity$/, (m, el) => officer.activity(el), { role: 'programOfficer' }],
  [/^#\/chair$/, (m, el) => chair.home(el), { role: 'panelChair' }],
  [/^#\/chair\/decisions\/([\w-]+)$/, (m, el) => chair.decision(el, m[1]), { role: 'panelChair' }],
  [/^#\/operator$/, (m, el) => operator.home(el), { role: 'operator' }],
  [/^#\/portfolio$/, (m, el) => portfolio.view(el), { role: ['programOfficer', 'panelChair'] }],
  [/^#\/notifications$/, (m, el) => notifications(el), {}],
];

function activeRole() {
  const roles = session.me?.roles ?? [];
  let r = null;
  try { r = localStorage.getItem('quorum.role'); } catch { /* ignore */ }
  return roles.includes(r) ? r : ROLE_ORDER.find((x) => roles.includes(x)) ?? null;
}
function setActiveRole(r) {
  try { localStorage.setItem('quorum.role', r); } catch { /* ignore */ }
}

async function refreshHealth() {
  try {
    health = await get('/api/health');
    setServerNow(health.now);
  } catch { /* the page still works */ }
  renderTopbar();
}

async function refreshUnread() {
  if (!session.token) return;
  try {
    const list = await get('/api/notifications');
    unread = list.filter((n) => !n.readAt).length;
  } catch { unread = 0; }
  renderTopbar();
}

function renderTopbar() {
  const bar = document.getElementById('topbar');
  const me = session.me;
  if (!me) { bar.hidden = true; bar.replaceChildren(); return; }
  bar.hidden = false;
  const role = activeRole();
  const here = location.hash.split('?')[0];
  const links = (NAV[role] ?? []).map(([href, label]) =>
    h('a', { href, 'aria-current': here === href || (href !== '#/' && here.startsWith(href + '/') && !NAV[role].some(([o]) => o !== href && here.startsWith(o))) ? 'page' : null }, label),
  );
  const roleSwitch =
    me.roles.length > 1
      ? h(
          'label',
          { class: 'row' },
          h('span', { class: 'sr-only' }, 'Acting as'),
          h(
            'select',
            {
              class: 'role-select',
              onchange: (e) => { setActiveRole(e.target.value); location.hash = ROLE_HOME[e.target.value]; },
            },
            me.roles.filter((r) => ROLE_LABEL[r]).map((r) => h('option', { value: r, selected: r === role ? 'selected' : null }, ROLE_LABEL[r])),
          ),
        )
      : null;
  bar.replaceChildren(
    h(
      'div',
      { class: 'topbar-inner' },
      h('a', { class: 'brand', href: ROLE_HOME[role] ?? '#/' }, h('span', { class: 'brand-mark' }, icon('logo', 17)), h('span', null, 'Quorum')),
      h('nav', { class: 'nav', 'aria-label': 'Main' }, links),
      h(
        'div',
        { class: 'topbar-right' },
        roleSwitch,
        h('a', { class: 'icon-btn', href: '#/notifications', 'aria-label': unread ? `Notifications, ${unread} unread` : 'Notifications' }, icon('bell', 20), unread ? h('span', { class: 'badge-count', 'aria-hidden': 'true' }, unread > 9 ? '9+' : unread) : null),
        h('div', { class: 'user-chip' }, h('span', { class: 'avatar', 'aria-hidden': 'true' }, initials(me.name)), h('span', { class: 'user-meta' }, h('span', null, me.name), h('small', null, ROLE_LABEL[role] ?? ''))),
        h('button', { class: 'btn-signout', type: 'button', onclick: signOut }, 'Sign out'),
      ),
    ),
    health?.demo
      ? h('div', { class: 'demo-strip' }, h('div', { class: 'inner' }, icon('clock', 15), h('span', null, h('strong', null, 'Demo environment. '), `Today is ${date(now().toISOString())}.`, h('span', { class: 'demo-detail' }, ` Integrations are stubbed: ORCID (${health.integrations.orcid}), triage (${health.integrations.triage}), mail (${health.integrations.mail}).`))))
      : null,
  );
}

function signOut() {
  session.token = null;
  session.me = null;
  renderTopbar();
  location.hash = '#/signin';
}

const DEMO = [
  ['officer@quorum.test', 'Dr. Amara Okafor', 'Program officer'],
  ['chair@quorum.test', 'Prof. Henrik Lindqvist', 'Panel chair'],
  ['fatima.alsayed@quorum.test', 'Dr. Fatima Al-Sayed', 'Reviewer — one review overdue'],
  ['hannah.weiss@quorum.test', 'Dr. Hannah Weiss', 'Reviewer'],
  ['marc.dubois@quorum.test', 'Prof. Marc Dubois', 'Reviewer — ORCID unverified'],
  ['priya.raman@quorum.test', 'Dr. Priya Raman', 'Applicant'],
  ['sarah.chen@quorum.test', 'Dr. Sarah Chen', 'Applicant and reviewer'],
];

function signIn() {
  const main = document.getElementById('main');
  const email = h('input', { type: 'email', name: 'email', autocomplete: 'username', required: true });
  const password = h('input', { type: 'password', name: 'password', autocomplete: 'current-password', required: true });
  const form = h(
    'form',
    { novalidate: true },
    h('h2', null, 'Sign in'),
    h('p', { class: 'muted' }, 'Use your Quorum account.'),
    field('Email', email),
    field('Password', password),
    h('div', { class: 'form-actions' }, h('button', { class: 'btn btn-primary', type: 'submit' }, 'Sign in'), h('a', { href: '#/register' }, 'New applicant? Create an account')),
  );
  bindForm(
    form,
    async (fd) => {
      const r = await post('/api/session', { email: String(fd.get('email') ?? '').trim(), password: String(fd.get('password') ?? '') });
      session.token = r.token;
      session.me = r.me;
      const role = ROLE_ORDER.find((x) => r.me.roles.includes(x));
      if (role) setActiveRole(role);
      await refreshHealth();
      void refreshUnread();
      location.hash = ROLE_HOME[role] ?? '#/notifications';
    },
    { busy: 'Signing in…' },
  );
  const demo = h(
    'div',
    { class: 'card-pad', style: 'padding:0;margin-top:22px' },
    h('h3', null, 'Demo accounts'),
    h('p', { class: 'small muted' }, 'Password for every demo account: ', h('code', { class: 'mono' }, 'quorum-demo-2026')),
    h(
      'div',
      { class: 'demo-accounts' },
      DEMO.map(([e, name, role]) =>
        h('button', { type: 'button', onclick: () => { email.value = e; password.value = 'quorum-demo-2026'; form.requestSubmit(); } }, h('span', null, name), h('small', null, role)),
      ),
    ),
  );
  main.replaceChildren(
    h(
      'div',
      { class: 'auth-wrap' },
      h(
        'div',
        { class: 'auth' },
        h(
          'div',
          { class: 'auth-side' },
          h('div', { class: 'brand' }, h('span', { class: 'brand-mark' }, icon('logo', 17)), h('span', null, 'Quorum')),
          h('h1', null, 'Fair, accountable research funding.'),
          h('p', null, 'Calls, submissions, blind peer review and panel decisions in one place — with every decision recorded and explained.'),
          h('ul', null, h('li', null, 'Three independent reviews for every eligible proposal'), h('li', null, 'Reviewers never see each other’s scores before submitting'), h('li', null, 'Awards can never exceed a call’s budget'), h('li', null, 'AI triage advises; people decide')),
        ),
        h('div', { class: 'auth-form' }, form, demo),
      ),
    ),
  );
  email.focus();
}

function register() {
  const main = document.getElementById('main');
  const form = h(
    'form',
    { novalidate: true },
    h('h1', { class: 'form-title' }, 'Create an applicant account'),
    h('p', { class: 'muted' }, 'Reviewer, officer and chair accounts are set up by the funding body.'),
    field('Full name', h('input', { type: 'text', name: 'name', autocomplete: 'name' })),
    field('Institution', h('input', { type: 'text', name: 'institution', autocomplete: 'organization' })),
    field('Email', h('input', { type: 'email', name: 'email', autocomplete: 'email' })),
    field('Password', h('input', { type: 'password', name: 'password', autocomplete: 'new-password' }), 'At least 10 characters.'),
    h('div', { class: 'form-actions' }, h('button', { class: 'btn btn-primary', type: 'submit' }, 'Create account'), h('a', { href: '#/signin' }, 'I already have an account')),
  );
  bindForm(form, async (fd, { key }) => {
    const r = await post('/api/accounts', Object.fromEntries(fd), { key });
    session.token = r.token;
    session.me = r.me;
    setActiveRole('applicant');
    await refreshHealth();
    toast('Welcome to Quorum. Your account is ready.');
    location.hash = '#/applicant';
  }, { busy: 'Creating…' });
  main.replaceChildren(h('div', { class: 'auth-wrap' }, h('div', { class: 'card card-pad', style: 'max-width:520px;width:100%' }, form)));
}

async function notifications(el) {
  await load(el, async () => {
    const list = await get('/api/notifications');
    const markAll = h('button', { class: 'btn btn-sm', type: 'button', onclick: async () => { await post('/api/notifications/read'); toast('All notifications marked as read.'); unread = 0; renderTopbar(); notifications(el); } }, 'Mark all as read');
    el.replaceChildren(
      h('div', { class: 'page-head' }, h('div', null, h('h1', null, 'Notifications'), h('p', { class: 'lede' }, 'Messages Quorum sent you. Copies also go to your email.')), list.some((n) => !n.readAt) ? markAll : null),
      list.length === 0
        ? card(null, empty('inbox', 'No notifications yet', 'When something needs your attention — an assignment, a decision, a deadline — it appears here.'))
        : card(
            null,
            h(
              'ul',
              { class: 'queue' },
              list.map((n) =>
                h(
                  'li',
                  null,
                  h('div', null, n.link ? h('a', { class: 'q-title', href: n.link }, n.subject) : h('span', { class: 'q-title' }, n.subject), h('div', { class: 'small', style: 'margin-top:2px' }, n.body), h('div', { class: 'q-meta' }, h('span', null, dateTime(n.createdAt)), !n.readAt ? h('span', { class: 'pill info' }, 'New') : null)),
                  null,
                ),
              ),
            ),
            { flush: true },
          ),
    );
  });
}

// ------------------------------------------------------------ router
async function route() {
  const hash = location.hash || '#/';
  const main = document.getElementById('main');
  if (!session.token && !/^#\/(signin|register)$/.test(hash)) { location.hash = '#/signin'; return; }
  if (session.token && !session.me) {
    try { session.me = await get('/api/me'); } catch { signOut(); return; }
    void refreshHealth();
    void refreshUnread();
  }
  if (hash === '#/' || hash === '#') { location.hash = ROLE_HOME[activeRole()] ?? '#/notifications'; return; }
  for (const [re, fn, opt] of ROUTES) {
    const m = hash.match(re);
    if (!m) continue;
    if (opt.role) {
      const need = Array.isArray(opt.role) ? opt.role : [opt.role];
      const role = activeRole();
      if (!need.includes(role)) {
        const alt = need.find((r) => session.me.roles.includes(r));
        if (alt) setActiveRole(alt);
        else {
          renderTopbar();
          main.replaceChildren(emptyPage('lock', 'Not available for your role', `This page is for ${need.map((r) => ROLE_LABEL[r]).join(' or ')} accounts.`, h('a', { class: 'btn', href: '#/' }, 'Go to your workspace')));
          return;
        }
      }
    }
    renderTopbar();
    const view = h('div', { class: 'view' });
    main.replaceChildren(view);
    await fn(m, view);
    document.title = opt.public ? (hash === '#/register' ? 'Create an account — Quorum' : 'Sign in — Quorum') : `${document.querySelector('.view h1')?.textContent ?? 'Quorum'} — Quorum`;
    if (!opt.public) main.focus({ preventScroll: true });
    window.scrollTo(0, 0);
    return;
  }
  main.replaceChildren(emptyPage('info', 'Page not found', 'That address does not match any page in Quorum.', h('a', { class: 'btn', href: '#/' }, 'Go to your workspace')));
}

setUnauthorizedHandler(() => { session.me = null; renderTopbar(); if (!/^#\/(signin|register)$/.test(location.hash)) { toast('Your session ended. Please sign in again.', 'bad'); location.hash = '#/signin'; } });
window.addEventListener('hashchange', route);
window.addEventListener('quorum:refresh-unread', refreshUnread);
setInterval(() => { if (document.visibilityState === 'visible') void refreshUnread(); }, 30000);
void refreshHealth().then(route);
export { alertBox };
