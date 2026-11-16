/**
 * Simulates an interrupted delivery: a separate process submits a proposal (the event commits with
 * the state change), then starts delivering and is hard-killed INSIDE one consumer's delivery
 * transaction, after its handler ran but before the delivery mark committed.
 * argv: dbFile dataDir clockIso applicantId applicantName proposalId killConsumer
 */
import { createDeps } from '../../src/app.ts';
import { ManualClock } from '../../src/platform/clock.ts';
import { submitProposal } from '../../src/contexts/submission/service.ts';

const [dbFile, dataDir, clockIso, applicantId, applicantName, proposalId, killConsumer] = process.argv.slice(2) as string[];
const deps = createDeps({ dbFile, dataDir, clock: new ManualClock(clockIso) });

deps.db.transaction(() => submitProposal(deps, { accountId: applicantId!, name: applicantName! }, proposalId!)).immediate();
process.stdout.write('submitted\n');

deps.bus.faultInjector = (consumer, event) => {
  if (consumer === killConsumer && event.type === 'ProposalSubmitted') {
    process.stdout.write(`killing inside ${consumer}\n`);
    process.kill(process.pid, 'SIGKILL'); // no cleanup, no rollback handler: the OS just ends the process
  }
};
deps.bus.drain();
process.stdout.write('not killed\n');
