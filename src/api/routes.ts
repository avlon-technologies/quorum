/**
 * The HTTP API. Every route declares its access (deny by default, NFR-3) and, for commands, the
 * model command it realizes. Resource scoping (INV-11) is done by each context's command/query:
 * an applicant's foreign proposal or a reviewer's foreign assignment is reported as not found.
 */
import type { Http, Principal } from '../platform/http.ts';
import type { Deps } from '../platform/deps.ts';
import type { TokenService } from '../platform/auth.ts';
import type { TriageRunner } from '../contexts/submission/triage.ts';
import { DomainError, badRequest, forbidden, notFound, unauthenticated } from '../platform/errors.ts';
import { inTx } from '../platform/db.ts';
import { DAY_MS, OffsetClock } from '../platform/clock.ts';
import * as identity from '../contexts/identity/service.ts';
import * as calls from '../contexts/calls/service.ts';
import * as submission from '../contexts/submission/service.ts';
import * as review from '../contexts/peer-review/service.ts';
import * as adjudication from '../contexts/adjudication/service.ts';
import * as notification from '../contexts/notification/service.ts';
import * as oversight from '../contexts/oversight/service.ts';
import { CONTINUUM_MODEL } from '../contracts/model.generated.ts';

const Q = '::Quorum.ResearchFunding';
const uuidParam = { type: 'object', required: ['id'], properties: { id: { type: 'string', minLength: 8, maxLength: 64 } } };
const str = (min: number, max: number) => ({ type: 'string', minLength: min, maxLength: max });
const body = (required: string[], properties: Record<string, object>) => ({ type: 'object', additionalProperties: false, required, properties });

const isStaff = (p: Principal | null) => !!p && (p.roles.includes('programOfficer') || p.roles.includes('panelChair'));

export function registerRoutes(h: Http, deps: Deps, tokens: TokenService, ops: { settle: () => Promise<void>; triageRunner: TriageRunner }) {
  const names = (ids: string[]) => identity.accountNames(deps, ids);

  // ================================================================ platform
  h.query({ method: 'GET', url: '/api/health', access: 'public' }, () => {
    deps.db.prepare('SELECT 1').get();
    return {
      status: 'ok',
      model: CONTINUUM_MODEL,
      integrations: { orcid: deps.orcid.kind, triage: deps.triage.name, mail: deps.mail.kind },
      demo: deps.config.demo,
      now: deps.clock.now().toISOString(),
    };
  });

  // ================================================================ Identity
  h.query(
    { method: 'POST', url: '/api/session', access: 'public', body: body(['email', 'password'], { email: str(3, 200), password: str(1, 200) }) },
    async (req) => {
      const id = identity.authenticate(deps, req.body.email, req.body.password);
      if (!id) throw unauthenticated('That email and password do not match an account.');
      const { token, expiresAt } = await tokens.issue(id);
      return { token, expiresAt, me: identity.loadPrincipal(deps, id) };
    },
  );
  h.query({ method: 'GET', url: '/api/me', access: 'authenticated' }, (_req, p) => p);

  h.command(
    {
      method: 'POST',
      url: '/api/accounts',
      access: 'public',
      realizes: `${Q}.Identity.RegisterApplicant`,
      body: body(['email', 'name', 'institution', 'password'], {
        email: { type: 'string', format: 'email', maxLength: 200 },
        name: str(2, 120),
        institution: str(2, 160),
        password: str(10, 200),
      }),
    },
    async (req, ctx) => {
      const r = ctx.tx(() => identity.registerApplicant(deps, req.body));
      const { token, expiresAt } = await tokens.issue(r.accountId);
      return { token, expiresAt, me: identity.loadPrincipal(deps, r.accountId) };
    },
    201,
  );

  h.command(
    { method: 'POST', url: '/api/me/orcid', access: ['reviewer'], realizes: `${Q}.Identity.VerifyOrcid`, body: body(['orcidId'], { orcidId: str(16, 19) }) },
    async (req, ctx) => {
      const orcidId = String(req.body.orcidId).trim().toUpperCase();
      const record = await identity.lookupOrcid(deps, orcidId); // outside the transaction: an external call
      return ctx.tx(() => identity.recordOrcidVerification(deps, ctx.principal.accountId, orcidId, record.exists));
    },
  );

  h.query({ method: 'GET', url: '/api/reviewers', access: ['programOfficer'] }, () => identity.listReviewers(deps));

  // ================================================================ Calls
  h.query({ method: 'GET', url: '/api/calls', access: 'authenticated' }, (_req, p) =>
    calls.listCalls(deps, { onlyOpen: !isStaff(p) }),
  );
  h.query({ method: 'GET', url: '/api/calls/:id', access: 'authenticated', params: uuidParam }, (req, p) => {
    const c = calls.getCall(deps, req.params.id);
    if (!isStaff(p) && c.status !== 'open') throw notFound('Call');
    return { ...c, budget: isStaff(p) ? adjudication.budgetOf(deps, c.id) : null };
  });
  h.command(
    {
      method: 'POST',
      url: '/api/calls',
      access: ['programOfficer'],
      realizes: `${Q}.Calls.PublishCall`,
      body: body(['title', 'summary', 'deadline', 'envelope', 'maxRequest', 'criteria'], {
        title: str(5, 160),
        summary: str(20, 2000),
        deadline: str(10, 40),
        envelope: { type: 'number', exclusiveMinimum: 0, maximum: 1e10 },
        maxRequest: { type: 'number', exclusiveMinimum: 0, maximum: 1e10 },
        criteria: {
          type: 'array',
          minItems: 1,
          maxItems: 8,
          items: body(['name', 'guidance'], { name: str(2, 80), guidance: str(0, 400) }),
        },
      }),
    },
    (req, ctx) => ctx.tx(() => calls.publishCall(deps, ctx.principal.accountId, req.body)),
    201,
  );
  h.command(
    { method: 'POST', url: '/api/calls/:id/close', access: ['programOfficer'], realizes: `${Q}.Calls.CloseCall`, params: uuidParam, body: body(['reason'], { reason: str(5, 500) }) },
    (req, ctx) => ctx.tx(() => calls.closeCall(deps, ctx.principal.accountId, req.params.id, req.body.reason)),
  );

  // ================================================================ Submission
  const draftBody = { title: str(0, 200), abstract: str(0, 6000), requested: { type: 'number', minimum: 0, maximum: 1e10 } };

  h.query({ method: 'GET', url: '/api/proposals', access: ['applicant', 'programOfficer', 'panelChair'] }, (req, p) => {
    const q = req.query as { status?: string; callId?: string };
    if (p!.roles.includes('programOfficer') || p!.roles.includes('panelChair')) {
      return submission.listProposals(deps, { callId: q.callId, status: q.status ? (q.status.split(',') as never) : undefined });
    }
    return submission.listProposals(deps, { applicantId: p!.accountId });
  });

  h.query({ method: 'GET', url: '/api/proposals/:id', access: 'authenticated', params: uuidParam }, (req, p) => {
    const view = submission.getProposal(deps, req.params.id);
    if (!view) throw notFound('Proposal');
    const staff = isStaff(p);
    const own = view.applicantId === p!.accountId && p!.roles.includes('applicant');
    const assigned =
      p!.roles.includes('reviewer') && review.assignmentsForProposal(deps, view.id).some((a) => a.reviewer_id === p!.accountId && a.status !== 'revoked');
    if (!staff && !own && !assigned) throw notFound('Proposal'); // INV-11: other people's proposals do not exist for you
    if (!staff && !own) {
      // A reviewer sees what they need to review, never the triage advice or screening notes.
      return { ...view, triage: null, screening: null, statusReason: null, call: calls.getCallStatus(deps, view.callId) };
    }
    const applicant = names([view.applicantId]).get(view.applicantId);
    return {
      ...view,
      triage: staff ? view.triage : null,
      call: calls.getCallStatus(deps, view.callId),
      applicant: applicant ? { name: applicant.name, institution: applicant.institution } : null,
      readiness: own && view.status === 'draft' ? submission.submissionProblems({ title: view.title, abstract: view.abstract, requested_minor: view.requestedMinor } as never, calls.getCallStatus(deps, view.callId)?.maxRequestMinor ?? 0) : undefined,
    };
  });

  h.command(
    {
      method: 'POST',
      url: '/api/proposals',
      access: ['applicant'],
      realizes: `${Q}.Submission.SaveDraft`,
      body: body(['callId', 'title', 'abstract', 'requested'], { callId: str(8, 64), ...draftBody }),
    },
    (req, ctx) => ctx.tx(() => submission.toView(deps, submission.createDraft(deps, ctx.principal.accountId, req.body))),
    201,
  );
  h.command(
    { method: 'PUT', url: '/api/proposals/:id', access: ['applicant'], realizes: `${Q}.Submission.SaveDraft`, params: uuidParam, body: body(['title', 'abstract', 'requested'], draftBody) },
    (req, ctx) => ctx.tx(() => submission.toView(deps, submission.updateDraft(deps, ctx.principal.accountId, req.params.id, req.body))),
  );
  h.command(
    { method: 'POST', url: '/api/proposals/:id/submit', access: ['applicant'], realizes: `${Q}.Submission.SubmitProposal`, params: uuidParam },
    (req, ctx) => ctx.tx(() => submission.toView(deps, submission.submitProposal(deps, ctx.principal, req.params.id))),
  );
  h.command(
    { method: 'POST', url: '/api/proposals/:id/withdraw', access: ['applicant'], realizes: `${Q}.Submission.WithdrawProposal`, params: uuidParam, body: body(['reason'], { reason: str(3, 500) }) },
    (req, ctx) => ctx.tx(() => submission.toView(deps, submission.withdrawProposal(deps, ctx.principal.accountId, req.params.id, req.body.reason))),
  );
  h.command(
    {
      method: 'POST',
      url: '/api/proposals/:id/screening',
      access: ['programOfficer'],
      realizes: `${Q}.Submission.ConfirmEligibility`,
      params: uuidParam,
      body: body(['outcome', 'reason'], { outcome: { type: 'string', enum: ['eligible', 'ineligible'] }, reason: str(0, 1000) }),
    },
    (req, ctx) => ctx.tx(() => submission.toView(deps, submission.confirmEligibility(deps, ctx.principal.accountId, req.params.id, req.body.outcome, req.body.reason))),
  );

  // ================================================================ PeerReview
  h.query({ method: 'GET', url: '/api/proposals/:id/assignments', access: ['programOfficer'], params: uuidParam }, (req) => {
    const list = review.assignmentsForProposal(deps, req.params.id);
    const nm = names(list.map((a) => a.reviewer_id));
    const conflicts = review.conflictsForProposal(deps, req.params.id);
    const cn = names(conflicts.map((c) => c.reviewerId));
    return {
      assignments: list.map((a) => ({ ...a, reviewer: nm.get(a.reviewer_id) ?? null })),
      conflicts: conflicts.map((c) => ({ ...c, reviewer: cn.get(c.reviewerId) ?? null })),
    };
  });

  h.query({ method: 'GET', url: '/api/proposals/:id/reviewer-candidates', access: ['programOfficer'], params: uuidParam }, (req) =>
    identity.listReviewers(deps).map((r) => ({ ...r, eligibility: review.assignmentEligibility(deps, req.params.id, r.id) })),
  );

  h.command(
    {
      method: 'POST',
      url: '/api/proposals/:id/assignments',
      access: ['programOfficer'],
      realizes: `${Q}.PeerReview.AssignReviewer`,
      params: uuidParam,
      body: body(['reviewerId'], { reviewerId: str(8, 64) }),
    },
    (req, ctx) => ctx.tx(() => review.assignReviewer(deps, ctx.principal.accountId, req.params.id, req.body.reviewerId)),
    201,
  );
  h.command(
    { method: 'POST', url: '/api/assignments/:id/revoke', access: ['programOfficer'], realizes: `${Q}.PeerReview.RevokeAssignment`, params: uuidParam, body: body(['reason'], { reason: str(5, 500) }) },
    (req, ctx) => ctx.tx(() => review.revokeAssignment(deps, ctx.principal.accountId, req.params.id, req.body.reason)),
  );
  h.command(
    { method: 'POST', url: '/api/assignments/:id/accept', access: ['reviewer'], realizes: `${Q}.PeerReview.AcceptAssignment`, params: uuidParam },
    (req, ctx) => ctx.tx(() => review.acceptAssignment(deps, ctx.principal.accountId, req.params.id)),
  );
  h.command(
    {
      method: 'POST',
      url: '/api/conflicts',
      access: ['reviewer', 'programOfficer'],
      realizes: `${Q}.PeerReview.DeclareConflict`,
      body: body(['proposalId', 'reason'], { proposalId: str(8, 64), reviewerId: str(8, 64), reason: str(5, 500) }),
    },
    (req, ctx) =>
      ctx.tx(() => {
        const isOfficer = ctx.principal.roles.includes('programOfficer');
        const reviewerId = req.body.reviewerId ?? ctx.principal.accountId;
        if (!isOfficer && !ctx.principal.roles.includes('reviewer')) throw forbidden('Only reviewers and program officers declare conflicts.');
        return review.declareConflict(deps, { accountId: ctx.principal.accountId, isOfficer }, { reviewerId, proposalId: req.body.proposalId, reason: req.body.reason });
      }),
    201,
  );
  h.command(
    {
      method: 'POST',
      url: '/api/assignments/:id/review',
      access: ['reviewer'],
      realizes: `${Q}.PeerReview.SubmitReview`,
      params: uuidParam,
      body: body(['scores', 'comment', 'attestsNoConflict'], {
        scores: { type: 'object', additionalProperties: { type: 'integer' }, maxProperties: 20 },
        comment: str(0, 6000),
        attestsNoConflict: { type: 'boolean' },
      }),
    },
    (req, ctx) => ctx.tx(() => review.submitReview(deps, ctx.principal.accountId, req.params.id, req.body)),
  );

  h.query({ method: 'GET', url: '/api/assignments', access: ['reviewer'] }, (_req, p) => {
    const list = review.assignmentsForReviewer(deps, p!.accountId);
    const proposals = new Map(submission.listProposals(deps, { ids: list.map((a) => a.proposal_id) }).map((x) => [x.id, x]));
    return list.map((a) => {
      const pr = proposals.get(a.proposal_id);
      return { ...a, proposal: pr ? { id: pr.id, reference: pr.reference, title: pr.title, status: pr.status } : null };
    });
  });
  h.query({ method: 'GET', url: '/api/assignments/:id', access: ['reviewer'], params: uuidParam }, (req, p) => {
    const d = review.assignmentDetail(deps, p!.accountId, req.params.id);
    const pr = submission.getProposal(deps, d.assignment.proposal_id);
    return {
      ...d,
      proposal: pr ? { id: pr.id, reference: pr.reference, title: pr.title, abstract: pr.abstract, requestedMinor: pr.requestedMinor, status: pr.status } : null,
      call: pr ? calls.getCallStatus(deps, pr.callId) : null,
    };
  });

  // INV-7 lives in review.getPeerReviews — the API never decides visibility itself.
  h.query({ method: 'GET', url: '/api/proposals/:id/reviews', access: ['reviewer', 'programOfficer', 'panelChair'], params: uuidParam }, (req, p) =>
    review.getPeerReviews(deps, { accountId: p!.accountId, canSeeAll: isStaff(p) }, req.params.id, names),
  );

  // ================================================================ Adjudication
  h.query({ method: 'GET', url: '/api/adjudications', access: ['panelChair', 'programOfficer'] }, (req) => {
    const q = req.query as { open?: string };
    return adjudication.listCases(deps, { open: q.open === '1' });
  });
  h.query({ method: 'GET', url: '/api/adjudications/:id', access: ['panelChair', 'programOfficer'], params: uuidParam }, (req) => {
    const c = adjudication.getCase(deps, req.params.id);
    const p = submission.getProposal(deps, req.params.id);
    const decidedBy = c.decision ? names([c.decision.decidedBy]).get(c.decision.decidedBy)?.name ?? null : null;
    return { ...c, decidedByName: decidedBy, proposal: p ? { reference: p.reference, abstract: p.abstract, status: p.status, applicantId: p.applicantId } : null };
  });
  h.command(
    {
      method: 'POST',
      url: '/api/adjudications/:id/decision',
      access: ['panelChair'],
      realizes: `${Q}.Adjudication.PanelDecision.decide`,
      params: uuidParam,
      body: body(['outcome', 'rationale'], { outcome: { type: 'string', enum: ['award', 'decline'] }, rationale: str(0, 2000) }),
    },
    (req, ctx) => ctx.tx(() => adjudication.recordDecision(deps, ctx.principal.accountId, req.params.id, req.body)),
  );

  // ================================================================ Oversight (read side)
  h.query({ method: 'GET', url: '/api/portfolio', access: ['programOfficer', 'panelChair'] }, (req) =>
    oversight.getPortfolio(deps, (req.query as { callId?: string }).callId),
  );
  h.query({ method: 'GET', url: '/api/proposals/:id/timeline', access: ['programOfficer', 'panelChair'], params: uuidParam }, (req) => {
    const t = oversight.getTimeline(deps, req.params.id);
    const nm = names(t.map((x) => x.actorId).filter((a) => !a.includes(':') && a !== 'quorum-platform'));
    return t.map((x) => ({ ...x, actor: nm.get(x.actorId)?.name ?? (x.actorId === 'quorum-platform' ? 'Quorum (automatic)' : x.actorId.startsWith('agent:') ? 'Eligibility triage agent' : x.actorId) }));
  });
  h.query({ method: 'GET', url: '/api/activity', access: ['programOfficer'] }, () => oversight.recentActivity(deps));

  // ================================================================ Notifications
  h.query({ method: 'GET', url: '/api/notifications', access: 'authenticated' }, (_req, p) => notification.inbox(deps, p!.accountId, p!.roles));
  h.command({ method: 'POST', url: '/api/notifications/read', access: 'authenticated' }, (_req, ctx) =>
    ctx.tx(() => ({ marked: notification.markRead(deps, ctx.principal.accountId, ctx.principal.roles) })),
  );

  // ================================================================ Workspaces (composed views; read-only)
  h.query({ method: 'GET', url: '/api/workspace/officer', access: ['programOfficer'] }, () => {
    const now = deps.clock.now().getTime();
    const screening = submission.listProposals(deps, { status: ['submitted', 'screening'] });
    const cases = new Map(review.openCases(deps).map((c) => [c.proposalId, c]));
    const needsReviewers = submission
      .listProposals(deps, { status: ['eligible', 'underReview'] })
      .map((p) => ({ ...p, activeAssignments: cases.get(p.id)?.active ?? 0, completedReviews: cases.get(p.id)?.completed ?? 0 }))
      .filter((p) => p.activeAssignments < 3);
    const overdue = review.overdueAssignments(deps);
    const op = new Map(submission.listProposals(deps, { ids: [...new Set(overdue.map((a) => a.proposal_id))] }).map((p) => [p.id, p]));
    const on = names(overdue.map((a) => a.reviewer_id));
    const decisionsOverdue = adjudication.listCases(deps, { open: true }).filter((c) => c.overdue);
    return {
      screening: screening.map((p) => ({ ...p, waitingDays: Math.floor((now - new Date(p.submittedAt ?? p.createdAt).getTime()) / DAY_MS) })),
      needsReviewers,
      overdueReviews: overdue.map((a) => ({
        ...a,
        reviewer: on.get(a.reviewer_id) ?? null,
        proposal: op.get(a.proposal_id) ? { id: a.proposal_id, reference: op.get(a.proposal_id)!.reference, title: op.get(a.proposal_id)!.title } : null,
        daysOverdue: Math.floor((now - new Date(a.due_at).getTime()) / DAY_MS),
      })),
      decisionsOverdue,
      delivery: deps.bus.health(),
      outbound: notification.outboundHealth(deps),
    };
  });

  // ================================================================ Operations (recovery)
  h.query({ method: 'GET', url: '/api/operations/health', access: ['programOfficer'] }, () => ({ delivery: deps.bus.health(), outbound: notification.outboundHealth(deps) }));
  h.command(
    { method: 'POST', url: '/api/operations/deliveries/retry', access: ['programOfficer'], body: body(['consumer', 'messageId'], { consumer: str(3, 100), messageId: str(8, 64) }) },
    (req, ctx) => ctx.tx(() => ({ retried: deps.bus.retry(req.body.consumer, req.body.messageId) })),
  );
  h.command({ method: 'POST', url: '/api/operations/rebuild-projections', access: ['programOfficer'] }, (_req, ctx) => {
    ctx.tx(() => null); // log the request; the replay runs its own transaction
    return { replayed: deps.bus.replay('oversight.portfolio-projector', oversight.resetProjection) };
  });

  // ================================================================ Demo controls (QUORUM_DEMO=1 only)
  h.command(
    { method: 'POST', url: '/api/demo/advance-clock', access: ['programOfficer'], body: body(['days'], { days: { type: 'integer', minimum: 1, maximum: 60 } }) },
    async (req, ctx) => {
      if (!deps.config.demo || !(deps.clock instanceof OffsetClock)) throw new DomainError(404, 'not_found', 'Demo controls are disabled. Start with QUORUM_DEMO=1.');
      const clock = deps.clock;
      const r = ctx.tx(() => {
        clock.offsetMs += req.body.days * DAY_MS;
        return { now: clock.now().toISOString(), offsetDays: Math.round(clock.offsetMs / DAY_MS) };
      });
      await ops.settle();
      return r;
    },
  );

  void inTx;
  void badRequest;
}
