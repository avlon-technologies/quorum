/**
 * Full browser journey — `npm run test:e2e`.
 *
 * Seeds a fresh database in a temp directory, starts Quorum in-process with background workers and
 * the demo clock, then drives the real UI in headless Chromium through all four roles and all
 * journeys. Asserts outcomes, fails on page errors or unexpected console errors, runs an
 * accessibility smoke on every key screen, and captures desktop (1366x900) and mobile (390x844)
 * screenshots into docs/screenshots/. Exit code 0 = every check passed.
 */
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type Page } from 'playwright';
import { createApp } from '../../src/app.ts';
import { OffsetClock } from '../../src/platform/clock.ts';
import { seedFile, DEMO_PASSWORD } from '../../src/seed.ts';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
const OUT = join(ROOT, 'docs', 'screenshots');
const VIEWPORTS = [
  ['desktop', 1366, 900],
  ['mobile', 390, 844],
] as const;

const failures: string[] = [];
const consoleErrors: string[] = [];
const a11y: string[] = [];
const shots: string[] = [];
let step = 'setup';

function check(cond: unknown, msg: string) {
  if (!cond) failures.push(`[${step}] ${msg}`);
  else console.log(`  ✓ ${msg}`);
}

async function main() {
  const dataDir = mkdtempSync(join(tmpdir(), 'quorum-e2e-'));
  const dbFile = join(dataDir, 'quorum.sqlite');
  mkdirSync(OUT, { recursive: true });
  console.log(`[e2e] seeding ${dbFile}`);
  await seedFile(dbFile, { reset: true });
  const app = await createApp({ dbFile, dataDir, demo: true, clock: new OffsetClock(), workers: true });
  await app.http.listen({ port: 0, host: '127.0.0.1' });
  const addr = app.http.server.address();
  const base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
  console.log(`[e2e] Quorum at ${base}`);
  const browser = await chromium.launch();
  try {
    await journeys(browser, base);
  } finally {
    await browser.close();
    await app.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
}

// ------------------------------------------------------------------ helpers

async function session(browser: Browser, base: string, email?: string): Promise<Page> {
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 900 } });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => consoleErrors.push(`[${step}] pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    // Expected business refusals (4xx) are logged by the browser as failed resources; anything else is a defect.
    if (/Failed to load resource: the server responded with a status of 4\d\d/.test(m.text())) return;
    consoleErrors.push(`[${step}] console: ${m.text()}`);
  });
  if (email) {
    await page.goto(`${base}/#/signin`);
    await page.getByLabel('Email').fill(email);
    await page.getByLabel('Password').fill(DEMO_PASSWORD);
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await page.locator('.topbar .user-chip').waitFor();
  }
  return page;
}

const visibleText = (page: Page, text: string | RegExp, timeout = 10_000) => page.getByText(text).first().waitFor({ state: 'visible', timeout });

async function accessibility(page: Page, name: string) {
  const issues: string[] = await page.evaluate(() => {
    const out: string[] = [];
    const vis = (e: Element) => !!((e as HTMLElement).offsetWidth || (e as HTMLElement).offsetHeight || e.getClientRects().length);
    for (const el of document.querySelectorAll<HTMLInputElement>('input,select,textarea')) {
      if (el.type === 'hidden') continue;
      const named = (el.labels && el.labels.length) || el.getAttribute('aria-label') || el.getAttribute('aria-labelledby');
      if (!named) out.push(`${el.tagName.toLowerCase()}[name=${el.name || el.id}] has no accessible label`);
    }
    for (const b of document.querySelectorAll('button, a[href]')) {
      if (!vis(b)) continue;
      const n = (b.getAttribute('aria-label') || b.textContent || '').trim();
      if (!n) out.push(`${b.tagName.toLowerCase()} without an accessible name`);
    }
    const h1 = [...document.querySelectorAll('h1')].filter(vis).length;
    if (h1 !== 1) out.push(`${h1} visible h1 elements (expected 1)`);
    return out;
  });
  for (const i of issues) a11y.push(`${name}: ${i}`);
}

async function shot(page: Page, name: string) {
  await page.waitForLoadState('networkidle').catch(() => {});
  // Full-page captures render fixed/sticky layers at the current scroll offset: start every capture
  // from the top, without transient toasts covering content.
  await page.evaluate(() => {
    window.scrollTo(0, 0);
    document.getElementById('toasts')?.replaceChildren();
  });
  await accessibility(page, name);
  for (const [label, w, h] of VIEWPORTS) {
    await page.setViewportSize({ width: w, height: h });
    await page.waitForTimeout(200);
    await page.evaluate(() => window.scrollTo(0, 0));
    if (label === 'mobile') {
      const sw = await page.evaluate(() => document.documentElement.scrollWidth);
      if (sw > w + 1) failures.push(`[${step}] ${name}: horizontal scroll at ${w}px (page is ${sw}px wide)`);
    }
    const file = `${name}-${label}.png`;
    await page.screenshot({ path: join(OUT, file), fullPage: true });
    shots.push(file);
  }
  await page.setViewportSize({ width: 1366, height: 900 });
}

/** Poll with reloads until a locator shows up — for state produced by asynchronous reactions. */
async function eventually(page: Page, probe: () => Promise<boolean>, what: string, tries = 20) {
  for (let i = 0; i < tries; i++) {
    if (await probe()) return true;
    await page.waitForTimeout(500);
    await page.reload();
    await page.locator('.view').first().waitFor();
    await page.waitForLoadState('networkidle').catch(() => {});
  }
  failures.push(`[${step}] timed out waiting for: ${what}`);
  return false;
}

const LONG_ABSTRACT =
  'Sea-ice travel routes are central to hunting, visiting and supply in Arctic communities, and they are becoming less predictable as the climate warms. We will combine community observations, ice-thickness surveys and satellite imagery to produce weekly route-safety maps co-designed with local hunters and search-and-rescue volunteers.';

// ------------------------------------------------------------------ the journeys

async function journeys(browser: Browser, base: string) {
  // ---------------------------------------------------------------- sign-in
  step = 'sign-in';
  console.log('[e2e] sign-in');
  {
    const page = await session(browser, base);
    await page.goto(`${base}/#/signin`);
    await page.getByRole('heading', { name: 'Sign in' }).waitFor();
    await shot(page, '01-signin');
    await page.getByLabel('Email').fill('officer@quorum.test');
    await page.getByLabel('Password').fill('wrong-password');
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await visibleText(page, 'That email and password do not match an account.');
    check(await page.getByLabel('Email').inputValue() === 'officer@quorum.test', 'wrong password is refused and the email stays filled in');
    await shot(page, '02-signin-refused');
    await page.context().close();
  }

  // ---------------------------------------------------------------- applicant: register
  step = 'applicant-register';
  console.log('[e2e] applicant registers');
  {
    const page = await session(browser, base);
    await page.goto(`${base}/#/register`);
    await page.getByLabel('Full name').fill('Dr. Noor Haddad');
    await page.getByLabel('Institution').fill('Memorial University of Newfoundland');
    await page.getByLabel('Email').fill(`noor.haddad.${Date.now()}@quorum.test`);
    await page.getByLabel('Password').fill('short');
    await page.getByRole('button', { name: 'Create account' }).click();
    await page.locator('.form-summary .alert').waitFor();
    check(await page.getByLabel('Full name').inputValue() === 'Dr. Noor Haddad', 'a refused registration keeps what was typed');
    await shot(page, '03-applicant-register-errors');
    await page.getByLabel('Password').fill('a-long-enough-password');
    await page.getByRole('button', { name: 'Create account' }).click();
    await page.getByRole('heading', { name: /Welcome, Dr\. Noor Haddad/ }).waitFor();
    await visibleText(page, 'No proposals yet');
    check(true, 'a new applicant lands on an empty workspace with an obvious next step');
    await shot(page, '04-applicant-new-empty');
    await page.context().close();
  }

  // ---------------------------------------------------------------- applicant: finish and submit a draft
  step = 'applicant-submit';
  console.log('[e2e] applicant submits a draft');
  {
    const page = await session(browser, base, 'priya.raman@quorum.test');
    await page.getByRole('heading', { name: /Welcome/ }).waitFor();
    await shot(page, '05-applicant-home');
    await page.getByRole('link', { name: 'Open calls' }).click();
    await page.getByRole('heading', { name: 'Open calls' }).waitFor();
    await shot(page, '06-applicant-open-calls');
    await page.getByRole('link', { name: 'My proposals' }).click();
    await page.getByRole('link', { name: 'Untitled draft' }).first().click();
    await page.getByRole('heading', { name: 'Untitled draft' }).waitFor();
    const title = 'Sea-ice travel safety from community observations';
    await page.getByLabel('Title').fill(title);
    await page.getByRole('button', { name: 'Review and submit…' }).click();
    await visibleText(page, 'not ready to submit');
    check(await page.getByLabel('Title').inputValue() === title, 'incomplete submit: the title the applicant typed is preserved');
    check(await page.locator('.field.invalid').count() >= 2, 'incomplete submit: the abstract and amount fields are flagged inline');
    await shot(page, '07-applicant-draft-errors');
    await page.getByLabel('Abstract').fill(LONG_ABSTRACT);
    await page.getByLabel('Amount requested (CAD)').fill('250000');
    await page.getByRole('button', { name: 'Review and submit…' }).click();
    await page.getByRole('heading', { name: 'Submit this proposal?' }).waitFor();
    check(await page.getByRole('button', { name: 'Submit proposal' }).isDisabled(), 'submit stays disabled until the applicant acknowledges it is final');
    await shot(page, '08-applicant-submit-confirm');
    await page.getByLabel('I confirm the proposal is complete and ready for screening.').check();
    await page.getByRole('button', { name: 'Submit proposal' }).click();
    await page.locator('.stepper').waitFor();
    const pill = (await page.locator('.page-head .pill').first().textContent())?.trim();
    check(pill === 'Submitted' || pill === 'In screening', `the submitted proposal shows its status (${pill})`);
    await shot(page, '09-applicant-submitted');

    step = 'not-found';
    await page.goto(`${base}/#/proposals/00000000-0000-4000-8000-000000000000`);
    await visibleText(page, 'Not found');
    check(true, 'an unknown or foreign proposal is reported as not found');
    await shot(page, '10-error-not-found');
    await page.context().close();
  }

  // ---------------------------------------------------------------- officer: screen and assign
  step = 'officer-screen-assign';
  console.log('[e2e] officer screens and assigns');
  {
    const page = await session(browser, base, 'officer@quorum.test');
    await page.getByRole('heading', { name: 'Work queue' }).waitFor();
    await shot(page, '11-officer-queue');
    await page.locator('.queue li', { hasText: 'Wildfire smoke forecasting' }).getByRole('link', { name: 'Screen' }).click();
    await visibleText(page, 'Agent suggests: eligible');
    await visibleText(page, /Advisory only/);
    check(true, "the agent's suggestion is labelled advisory");
    await shot(page, '12-officer-screening');
    await page.getByRole('radio', { name: /^Eligible/ }).check();
    await page.getByRole('button', { name: 'Record screening decision' }).click();
    await visibleText(page, 'Reviewers (0 of 3)');
    for (let i = 0; i < 3; i++) {
      await eventually(page, async () => (await page.getByRole('button', { name: 'Assign', exact: true }).count()) > 0, 'assignable reviewers');
      if (i === 0) await shot(page, '13-officer-assign-reviewers');
      await page.getByRole('button', { name: 'Assign', exact: true }).first().click();
      await visibleText(page, `Reviewers (${i + 1} of 3)`);
    }
    await eventually(page, async () => ((await page.locator('.page-head .pill').first().textContent()) ?? '').includes('Under review'), 'status Under review after three assignments');
    check(true, 'three assignments move the proposal to Under review');
    await shot(page, '14-officer-panel-complete');
    await page.getByRole('link', { name: 'Calls' }).click();
    await page.getByRole('heading', { name: 'Funding calls' }).waitFor();
    await shot(page, '15-officer-calls');
    await page.getByRole('link', { name: 'Audit log' }).click();
    await page.getByRole('heading', { name: 'Audit log' }).waitFor();
    await shot(page, '16-officer-audit-log');
    await page.context().close();
  }

  // ---------------------------------------------------------------- reviewer: ORCID (INV-12)
  step = 'reviewer-orcid';
  console.log('[e2e] reviewer verifies ORCID');
  {
    const page = await session(browser, base, 'marc.dubois@quorum.test');
    await page.getByRole('heading', { name: 'My reviews' }).waitFor();
    await visibleText(page, 'Verify your ORCID iD to start reviewing');
    await shot(page, '17-reviewer-unverified-empty');
    await page.getByLabel('Your ORCID iD').fill('0000-0002-1825-0097'); // already verified on another account
    await page.getByRole('button', { name: 'Verify ORCID iD' }).click();
    await visibleText(page, 'already verified on another account');
    check(await page.getByLabel('Your ORCID iD').inputValue() === '0000-0002-1825-0097', 'a refused ORCID keeps the typed iD');
    await shot(page, '18-reviewer-orcid-refused');
    await page.getByLabel('Your ORCID iD').fill('0000-0002-1234-5677');
    await page.getByRole('button', { name: 'Verify ORCID iD' }).click();
    await visibleText(page, 'ORCID iD verified');
    await page.getByText('Verify your ORCID iD to start reviewing').waitFor({ state: 'detached' });
    check(true, 'a registered ORCID iD is verified and the prompt disappears');
    await page.context().close();
  }

  // ---------------------------------------------------------------- reviewer: blind review (INV-6, INV-7)
  step = 'reviewer-review';
  console.log('[e2e] reviewer submits a blind review');
  {
    const page = await session(browser, base, 'fatima.alsayed@quorum.test');
    await page.getByRole('heading', { name: 'My reviews' }).waitFor();
    await shot(page, '19-reviewer-home');
    await page.getByRole('link', { name: 'Write review now' }).click();
    await page.getByRole('heading', { name: 'Your review' }).waitFor();
    check(await page.getByText('This review is overdue').isVisible(), 'the overdue state is explained on the form');
    await shot(page, '20-reviewer-review-form');

    // keyboard: arrow keys move within a criterion's scale, Tab moves to the next criterion
    await page.locator('input[name="scores.c1"][value="1"]').focus();
    await page.keyboard.press('Space');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');
    const c1 = await page.locator('input[name="scores.c1"]:checked').getAttribute('value');
    check(c1 === '4', `keyboard: arrows select a score within a criterion (got ${c1})`);
    await page.keyboard.press('Tab');
    const focused = await page.evaluate(() => (document.activeElement as HTMLInputElement | null)?.name);
    check(focused === 'scores.c2', `keyboard: Tab moves to the next criterion (focus on ${focused})`);
    await page.keyboard.press('ArrowRight');

    await page.getByRole('button', { name: 'Review and submit…' }).click();
    await visibleText(page, 'Your review is not complete yet');
    check((await page.locator('input[name="scores.c1"]:checked').getAttribute('value')) === '4', 'incomplete review: the scores already chosen are kept');
    check(await page.locator('fieldset.criterion.invalid').count() >= 3, 'incomplete review: every unscored criterion is flagged');
    await shot(page, '21-reviewer-review-incomplete');

    for (const [c, v] of [['c2', 3], ['c3', 4], ['c4', 5], ['c5', 3]] as const) {
      await page.locator(`label:has(input[name="scores.${c}"][value="${v}"])`).click();
    }
    await page.getByLabel('Comments for the panel').fill('Ambitious and well partnered. The sensor network is affordable; I would like a clearer maintenance funding plan beyond year three.');
    await page.getByLabel('I confirm I have no conflict of interest with this proposal or its applicant.').check();
    await page.getByRole('button', { name: 'Review and submit…' }).click();
    await page.getByRole('heading', { name: 'Submit your review?' }).waitFor();
    await shot(page, '22-reviewer-review-confirm');
    await page.getByLabel('My scores and comments are final.').check();
    await page.getByRole('button', { name: 'Submit review' }).click();
    await visibleText(page, 'Your review is submitted');
    await visibleText(page, 'Reviewer A');
    check(await page.getByText('Reviewer identities are not shown.').isVisible(), 'after submitting, peer reviews are visible and anonymised');
    await shot(page, '23-reviewer-peers-visible');
    await page.context().close();
  }

  // ---------------------------------------------------------------- chair: award within budget, refuse over budget (INV-8, INV-9)
  step = 'chair-decide';
  console.log('[e2e] chair decides');
  {
    const page = await session(browser, base, 'chair@quorum.test');
    await page.getByRole('heading', { name: 'Decisions' }).waitFor();
    await shot(page, '24-chair-queue');

    await page.locator('.queue li', { hasText: 'Fair risk models' }).getByRole('link', { name: 'Decide' }).click();
    await page.getByRole('heading', { name: 'Record the panel’s decision' }).waitFor();
    await shot(page, '25-chair-decision');
    await page.getByRole('radio', { name: /^Award/ }).check();
    await page.getByLabel('Rationale').fill('Strong fairness design and a credible plan for primary-care uptake; ranked first by the panel.');
    await page.getByRole('button', { name: 'Continue…' }).click();
    await page.getByRole('heading', { name: /^Award \$120,000/ }).waitFor();
    await shot(page, '26-chair-award-confirm');
    await page.getByLabel(/It is final and cannot be changed/).check();
    await page.getByRole('button', { name: 'Record award' }).click();
    await visibleText(page, 'Awarded $120,000');
    check(true, 'an award within the remaining budget is recorded');
    await shot(page, '27-chair-awarded');

    await page.goto(`${base}/#/chair`);
    await page.locator('.queue li', { hasText: 'A diverse benchmark' }).getByRole('link', { name: 'Decide' }).click();
    await page.getByRole('heading', { name: 'Record the panel’s decision' }).waitFor();
    check(await page.getByText('This request exceeds what remains in the budget').isVisible(), 'the chair is warned before an over-budget award');
    await page.getByRole('radio', { name: /^Award/ }).check();
    await page.getByLabel('Rationale').fill('Valuable benchmark; the panel would fund it if the budget allows.');
    await page.getByRole('button', { name: 'Continue…' }).click();
    await page.getByLabel(/It is final and cannot be changed/).check();
    await page.getByRole('button', { name: 'Record award' }).click();
    await visibleText(page, 'The award was refused: the budget cannot cover it');
    check(await page.getByRole('radio', { name: /^Award/ }).isDisabled(), 'after the refusal, award is no longer offered (INV-9)');
    await shot(page, '28-chair-over-budget-refused');
    await page.getByRole('radio', { name: /^Decline/ }).check();
    await page.getByLabel('Rationale').fill('The call envelope cannot fund this request; the panel declines it this round.');
    await page.getByRole('button', { name: 'Continue…' }).click();
    await page.getByLabel(/It is final and cannot be changed/).check();
    await page.getByRole('button', { name: 'Record decline' }).click();
    await page.getByRole('heading', { name: 'Panel decision' }).waitFor();
    await visibleText(page, 'Declined');
    check(true, 'the refused case is closed by a decline');
    await shot(page, '29-chair-declined');

    await page.getByRole('link', { name: 'Portfolio' }).click();
    await page.getByRole('heading', { name: 'Portfolio' }).waitFor();
    await shot(page, '30-portfolio');
    await page.context().close();
  }

  // ---------------------------------------------------------------- officer: demo clock, notifications
  step = 'officer-clock';
  console.log('[e2e] officer advances the demo clock');
  {
    const page = await session(browser, base, 'officer@quorum.test');
    await page.getByRole('heading', { name: 'Work queue' }).waitFor();
    await page.getByLabel('Days').fill('7');
    await page.getByRole('button', { name: 'Advance the clock' }).click();
    await visibleText(page, 'Clock advanced');
    await page.waitForTimeout(1500);
    const stillSignedIn = await page.locator('.topbar .user-chip').isVisible();
    check(stillSignedIn, 'advancing the demo clock keeps the officer signed in');
    if (!stillSignedIn) {
      // backend: session tokens expire on the business (demo) clock; sign in again to finish the journey
      await page.getByLabel('Email').fill('officer@quorum.test');
      await page.getByLabel('Password').fill(DEMO_PASSWORD);
      await page.getByRole('button', { name: 'Sign in', exact: true }).click();
      await page.getByRole('heading', { name: 'Work queue' }).waitFor();
    }
    await shot(page, '31-officer-after-clock');
    await page.locator('a[href="#/notifications"]').click();
    await page.getByRole('heading', { name: 'Notifications' }).waitFor();
    await shot(page, '32-notifications');
    await page.context().close();
  }
}

main()
  .catch((e) => failures.push(`[${step}] crashed: ${e instanceof Error ? e.stack ?? e.message : e}`))
  .finally(() => {
    console.log(`\n[e2e] ${shots.length} screenshots in docs/screenshots/`);
    for (const a of a11y) console.log(`  a11y: ${a}`);
    for (const c of consoleErrors) console.log(`  ✗ ${c}`);
    for (const f of failures) console.log(`  ✗ ${f}`);
    const ok = failures.length === 0 && consoleErrors.length === 0 && a11y.length === 0;
    console.log(ok ? '[e2e] PASS' : `[e2e] FAIL — ${failures.length} failures, ${consoleErrors.length} console errors, ${a11y.length} accessibility issues`);
    process.exit(ok ? 0 : 1);
  });
