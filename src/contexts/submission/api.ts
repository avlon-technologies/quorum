/**
 * Submission's public surface (read-only): proposal summaries for the UI composition layer.
 * No other context may change a proposal — there is deliberately no command here (ADR-001).
 */
export { getProposal, listProposals, ref } from './service.ts';
export type { ProposalView } from './service.ts';
