/**
 * The port between the Triage workflow (::Quorum.ResearchFunding.Submission.Triage) and the
 * EligibilityTriage agent's model provider. The workflow owns this contract; a provider implements it
 * and is injected through Deps, so the workflow never depends on a provider module (INV-10, ADR-011).
 */
export type TriageInput = {
  proposalId: string;
  title: string;
  abstract: string;
  requestedMinor: number;
  callTitle: string;
  callSummary: string;
  maxRequestMinor: number;
};
export type TriageOutput = { verdict: 'eligible' | 'ineligible' | 'unclear'; rationale: string };

export interface TriageProvider {
  readonly name: string;
  assess(input: TriageInput): Promise<TriageOutput>;
}
