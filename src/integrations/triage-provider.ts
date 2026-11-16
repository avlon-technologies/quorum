/**
 * The EligibilityTriage agent's model provider — realizes ::Quorum…Submission.EligibilityTriage's
 * `model[caps: reasoning, structured-output]`. The agent receives ONLY a read-only view of the
 * proposal (its ProposalReader tool); it has no handle on the database and no command it can send
 * (INV-10, ADR-011). Its output is a verdict proposal; what happens to it is decided elsewhere.
 */
import type { TriageInput, TriageOutput, TriageProvider } from '../contracts/triage-port.ts';
export type { TriageInput, TriageOutput, TriageProvider };

const words = (s: string) => new Set(s.toLowerCase().match(/[a-z]{5,}/g) ?? []);

/** Deterministic stub: the same proposal always gets the same verdict and rationale. */
export class StubTriageProvider implements TriageProvider {
  readonly name = 'stub-triage-1 (deterministic rules)';
  /** Test hook: make the next N calls fail, to exercise retry and the on-fail=continue path. */
  failNext = 0;
  async assess(i: TriageInput): Promise<TriageOutput> {
    if (this.failNext > 0) {
      this.failNext--;
      throw new Error('triage provider unavailable (injected)');
    }
    const findings: string[] = [];
    let verdict: TriageOutput['verdict'] = 'eligible';
    if (i.requestedMinor > i.maxRequestMinor) {
      verdict = 'ineligible';
      findings.push(`Requested amount exceeds the call's per-proposal maximum (${(i.requestedMinor / 100).toFixed(0)} > ${(i.maxRequestMinor / 100).toFixed(0)}).`);
    } else {
      findings.push('Requested amount is within the per-proposal maximum.');
    }
    const len = i.abstract.trim().length;
    if (len < 400) {
      if (verdict === 'eligible') verdict = 'unclear';
      findings.push(`The abstract is short (${len} characters); scope cannot be judged confidently.`);
    } else {
      findings.push(`The abstract is substantive (${len} characters).`);
    }
    const scope = words(`${i.callTitle} ${i.callSummary}`);
    const overlap = [...words(`${i.title} ${i.abstract}`)].filter((w) => scope.has(w));
    if (overlap.length < 2) {
      if (verdict === 'eligible') verdict = 'unclear';
      findings.push('Few terms in the proposal match the call\'s stated scope.');
    } else {
      findings.push(`Matches the call's scope on: ${overlap.slice(0, 5).join(', ')}.`);
    }
    return { verdict, rationale: findings.join(' ') };
  }
}
