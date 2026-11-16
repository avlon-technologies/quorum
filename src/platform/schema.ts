/**
 * Schema, one migration per entry. Tables are prefixed by the bounded context that is their
 * ONLY writer (decision D1). Cross-context reads go through a context's api module, never SQL.
 *
 *   idn_*  Identity      ::Quorum.ResearchFunding.Identity.AccountStore
 *   cal_*  Calls         ::Quorum.ResearchFunding.Calls.CallStore
 *   sub_*  Submission    ::Quorum.ResearchFunding.Submission.ProposalStore
 *   rev_*  PeerReview    ::Quorum.ResearchFunding.PeerReview.ReviewStore / CompletionLedger
 *   adj_*  Adjudication  ::Quorum.ResearchFunding.Adjudication.AdjudicationStore
 *   ntf_*  Notification  ::Quorum.ResearchFunding.Notification.OutboundMessageStore
 *   ovs_*  Oversight     ::Quorum.ResearchFunding.Oversight.Portfolio / AuditTrail
 *   evt_*, cmd_*         platform: event outbox + per-consumer delivery (binding: sqlite-outbox), command log
 */
export const MIGRATIONS: string[] = [
  /* 1 — initial schema */ `
  -- ---------------------------------------------------------------- platform
  CREATE TABLE evt_outbox (
    seq            INTEGER PRIMARY KEY AUTOINCREMENT,
    message_id     TEXT NOT NULL UNIQUE,
    type           TEXT NOT NULL,
    partition_key  TEXT NOT NULL,
    payload        TEXT NOT NULL,
    actor_id       TEXT NOT NULL,
    occurred_at    TEXT NOT NULL,
    causation_id   TEXT
  );
  CREATE INDEX evt_outbox_partition ON evt_outbox(partition_key, seq);

  CREATE TABLE evt_delivery (
    consumer        TEXT NOT NULL,
    message_id      TEXT NOT NULL REFERENCES evt_outbox(message_id),
    seq             INTEGER NOT NULL,
    partition_key   TEXT NOT NULL,
    status          TEXT NOT NULL CHECK (status IN ('pending','delivered','failed')),
    attempts        INTEGER NOT NULL DEFAULT 0,
    next_attempt_at TEXT NOT NULL,
    last_error      TEXT,
    delivered_at    TEXT,
    PRIMARY KEY (consumer, message_id)
  );
  CREATE INDEX evt_delivery_due ON evt_delivery(status, next_attempt_at, seq);
  CREATE INDEX evt_delivery_partition ON evt_delivery(consumer, partition_key, seq);

  CREATE TABLE cmd_log (
    actor_id        TEXT NOT NULL,
    idempotency_key TEXT NOT NULL,
    route           TEXT NOT NULL,
    request_hash    TEXT NOT NULL,
    status_code     INTEGER NOT NULL,
    response        TEXT NOT NULL,
    created_at      TEXT NOT NULL,
    PRIMARY KEY (actor_id, idempotency_key)
  );

  -- ---------------------------------------------------------------- Identity
  CREATE TABLE idn_account (
    id             TEXT PRIMARY KEY,
    kind           TEXT NOT NULL CHECK (kind IN ('person','agent')),
    email          TEXT NOT NULL UNIQUE COLLATE NOCASE,
    name           TEXT NOT NULL,
    institution    TEXT NOT NULL,
    password_hash  TEXT,
    orcid_id       TEXT,
    orcid_status   TEXT NOT NULL DEFAULT 'unverified' CHECK (orcid_status IN ('unverified','verified')),
    orcid_verified_at TEXT,
    created_at     TEXT NOT NULL
  );
  CREATE TABLE idn_role_grant (
    account_id TEXT NOT NULL REFERENCES idn_account(id),
    role       TEXT NOT NULL CHECK (role IN ('applicant','reviewer','programOfficer','panelChair')),
    granted_at TEXT NOT NULL,
    granted_by TEXT NOT NULL,
    PRIMARY KEY (account_id, role)
  );

  -- ---------------------------------------------------------------- Calls
  CREATE TABLE cal_call (
    id           TEXT PRIMARY KEY,
    reference    TEXT NOT NULL UNIQUE,
    title        TEXT NOT NULL,
    summary      TEXT NOT NULL,
    deadline     TEXT NOT NULL,
    envelope_minor     INTEGER NOT NULL CHECK (envelope_minor > 0),
    max_request_minor  INTEGER NOT NULL CHECK (max_request_minor > 0),
    status       TEXT NOT NULL CHECK (status IN ('open','closed')),
    opened_at    TEXT NOT NULL,
    opened_by    TEXT NOT NULL,
    closed_at    TEXT,
    closed_by    TEXT,
    close_reason TEXT
  );
  CREATE TABLE cal_criterion (
    call_id     TEXT NOT NULL REFERENCES cal_call(id),
    id          TEXT NOT NULL,
    position    INTEGER NOT NULL,
    name        TEXT NOT NULL,
    guidance    TEXT NOT NULL,
    PRIMARY KEY (call_id, id)
  );
  -- envelope and criteria are immutable once a call is open (D6)
  CREATE TRIGGER cal_call_envelope_immutable BEFORE UPDATE OF envelope_minor, max_request_minor ON cal_call
  BEGIN SELECT RAISE(ABORT, 'envelope is immutable once a call is open'); END;
  CREATE TRIGGER cal_criterion_immutable BEFORE UPDATE ON cal_criterion
  BEGIN SELECT RAISE(ABORT, 'criteria are immutable once a call is open'); END;

  -- ---------------------------------------------------------------- Submission
  CREATE TABLE sub_proposal (
    id             TEXT PRIMARY KEY,
    number         INTEGER NOT NULL UNIQUE,
    call_id        TEXT NOT NULL,
    applicant_id   TEXT NOT NULL,
    title          TEXT NOT NULL,
    abstract       TEXT NOT NULL,
    requested_minor INTEGER NOT NULL CHECK (requested_minor >= 0),
    status         TEXT NOT NULL CHECK (status IN ('draft','submitted','screening','eligible','ineligible','underReview','scored','awarded','declined','withdrawn')),
    submitted_at   TEXT,
    created_at     TEXT NOT NULL,
    updated_at     TEXT NOT NULL,
    status_reason  TEXT
  );
  CREATE INDEX sub_proposal_applicant ON sub_proposal(applicant_id);
  CREATE INDEX sub_proposal_status ON sub_proposal(status);
  CREATE TABLE sub_triage (
    proposal_id  TEXT PRIMARY KEY REFERENCES sub_proposal(id),
    verdict      TEXT CHECK (verdict IN ('eligible','ineligible','unclear')),
    rationale    TEXT NOT NULL,
    provider     TEXT NOT NULL,
    recorded_at  TEXT NOT NULL
  );
  -- durable instances of the Triage workflow (::Quorum…Submission.Triage)
  CREATE TABLE sub_triage_job (
    proposal_id     TEXT PRIMARY KEY REFERENCES sub_proposal(id),
    status          TEXT NOT NULL CHECK (status IN ('pending','done')),
    attempts        INTEGER NOT NULL DEFAULT 0,
    next_attempt_at TEXT NOT NULL,
    last_error      TEXT
  );
  CREATE TABLE sub_screening (
    proposal_id  TEXT PRIMARY KEY REFERENCES sub_proposal(id),
    outcome      TEXT NOT NULL CHECK (outcome IN ('eligible','ineligible')),
    agreed_with_agent INTEGER,
    reason       TEXT NOT NULL,
    decided_by   TEXT NOT NULL,
    decided_at   TEXT NOT NULL
  );

  -- ---------------------------------------------------------------- PeerReview
  CREATE TABLE rev_call_criteria (
    call_id   TEXT NOT NULL,
    id        TEXT NOT NULL,
    position  INTEGER NOT NULL,
    name      TEXT NOT NULL,
    guidance  TEXT NOT NULL,
    PRIMARY KEY (call_id, id)
  );
  CREATE TABLE rev_case (
    proposal_id  TEXT PRIMARY KEY,
    call_id      TEXT,
    applicant_id TEXT,
    status       TEXT NOT NULL CHECK (status IN ('open','withdrawn')),
    opened_at    TEXT NOT NULL
  );
  CREATE TABLE rev_conflict (
    reviewer_id  TEXT NOT NULL,
    proposal_id  TEXT NOT NULL,
    reason       TEXT NOT NULL,
    declared_by  TEXT NOT NULL,
    declared_at  TEXT NOT NULL,
    PRIMARY KEY (reviewer_id, proposal_id)
  );
  CREATE TABLE rev_assignment (
    id           TEXT PRIMARY KEY,
    proposal_id  TEXT NOT NULL,
    reviewer_id  TEXT NOT NULL,
    status       TEXT NOT NULL CHECK (status IN ('assigned','accepted','completed','overdue','revoked')),
    due_at       TEXT NOT NULL,
    assigned_by  TEXT NOT NULL,
    assigned_at  TEXT NOT NULL,
    accepted_at  TEXT,
    completed_at TEXT,
    overdue_at   TEXT,
    revoked_at   TEXT,
    revoke_reason TEXT
  );
  -- at most one non-revoked assignment per (proposal, reviewer)
  CREATE UNIQUE INDEX rev_assignment_active ON rev_assignment(proposal_id, reviewer_id) WHERE status <> 'revoked';
  CREATE INDEX rev_assignment_reviewer ON rev_assignment(reviewer_id);
  -- INV-3 defence in depth: no live assignment may coexist with a declared conflict
  CREATE TRIGGER rev_assignment_no_conflict BEFORE INSERT ON rev_assignment
  WHEN EXISTS (SELECT 1 FROM rev_conflict c WHERE c.reviewer_id = NEW.reviewer_id AND c.proposal_id = NEW.proposal_id)
  BEGIN SELECT RAISE(ABORT, 'INV-3: reviewer has a declared conflict with this proposal'); END;
  CREATE TABLE rev_review (
    id            TEXT PRIMARY KEY,
    assignment_id TEXT NOT NULL UNIQUE REFERENCES rev_assignment(id),
    proposal_id   TEXT NOT NULL,
    reviewer_id   TEXT NOT NULL,
    status        TEXT NOT NULL CHECK (status IN ('pending','submitted')),
    comment       TEXT,
    submitted_at  TEXT,
    voided_at     TEXT,
    void_reason   TEXT
  );
  CREATE TABLE rev_score (
    review_id    TEXT NOT NULL REFERENCES rev_review(id),
    criterion_id TEXT NOT NULL,
    score        INTEGER NOT NULL CHECK (score BETWEEN 1 AND 5),
    PRIMARY KEY (review_id, criterion_id)
  );
  CREATE TABLE rev_completion (
    proposal_id  TEXT PRIMARY KEY,
    mean_score   REAL NOT NULL,
    review_ids   TEXT NOT NULL,
    completed_at TEXT NOT NULL
  );

  -- ---------------------------------------------------------------- Adjudication
  CREATE TABLE adj_budget (
    call_id         TEXT PRIMARY KEY,
    envelope_minor  INTEGER NOT NULL,
    committed_minor INTEGER NOT NULL DEFAULT 0,
    CHECK (committed_minor >= 0 AND committed_minor <= envelope_minor)
  );
  CREATE TABLE adj_case (
    proposal_id     TEXT PRIMARY KEY,
    call_id         TEXT NOT NULL,
    title           TEXT NOT NULL,
    requested_minor INTEGER NOT NULL,
    mean_score      REAL NOT NULL,
    status          TEXT NOT NULL CHECK (status IN ('awaitingDecision','reconsider','decided')),
    integrity_hold  TEXT,
    opened_at       TEXT NOT NULL,
    decision_due    TEXT NOT NULL,
    escalated_at    TEXT
  );
  CREATE TABLE adj_pending_hold (
    proposal_id TEXT PRIMARY KEY,
    reason      TEXT NOT NULL
  );
  CREATE TABLE adj_decision (
    proposal_id   TEXT PRIMARY KEY REFERENCES adj_case(proposal_id),
    call_id       TEXT NOT NULL,
    outcome       TEXT NOT NULL CHECK (outcome IN ('award','decline')),
    amount_minor  INTEGER NOT NULL,
    rationale     TEXT NOT NULL,
    decided_by    TEXT NOT NULL,
    decided_at    TEXT NOT NULL
  );

  -- ---------------------------------------------------------------- Notification
  CREATE TABLE ntf_proposal (
    proposal_id  TEXT PRIMARY KEY,
    applicant_id TEXT NOT NULL,
    title        TEXT NOT NULL
  );
  CREATE TABLE ntf_message (
    id             TEXT PRIMARY KEY,
    event_id       TEXT NOT NULL,
    recipient      TEXT NOT NULL,
    kind           TEXT NOT NULL,
    subject        TEXT NOT NULL,
    body           TEXT NOT NULL,
    link           TEXT,
    created_at     TEXT NOT NULL,
    read_at        TEXT,
    status         TEXT NOT NULL CHECK (status IN ('queued','delivered','failed')),
    attempts       INTEGER NOT NULL DEFAULT 0,
    next_attempt_at TEXT NOT NULL,
    last_error     TEXT,
    delivered_at   TEXT,
    UNIQUE (event_id, recipient)
  );
  CREATE INDEX ntf_message_recipient ON ntf_message(recipient, created_at);
  CREATE INDEX ntf_message_queue ON ntf_message(status, next_attempt_at);

  -- ---------------------------------------------------------------- Oversight (read side)
  CREATE TABLE ovs_call (
    call_id         TEXT PRIMARY KEY,
    title           TEXT NOT NULL,
    deadline        TEXT NOT NULL,
    status          TEXT NOT NULL,
    envelope_minor  INTEGER NOT NULL,
    awarded_minor   INTEGER NOT NULL DEFAULT 0,
    last_seq        INTEGER NOT NULL
  );
  CREATE TABLE ovs_proposal (
    proposal_id      TEXT PRIMARY KEY,
    call_id          TEXT NOT NULL,
    title            TEXT NOT NULL,
    applicant_name   TEXT NOT NULL,
    status           TEXT NOT NULL,
    requested_minor  INTEGER NOT NULL,
    reviews_submitted INTEGER NOT NULL DEFAULT 0,
    mean_score       REAL,
    awarded_minor    INTEGER,
    submitted_at     TEXT NOT NULL,
    updated_at       TEXT NOT NULL,
    last_seq         INTEGER NOT NULL
  );
  CREATE TABLE ovs_audit (
    seq          INTEGER PRIMARY KEY,
    message_id   TEXT NOT NULL UNIQUE,
    at           TEXT NOT NULL,
    event        TEXT NOT NULL,
    proposal_id  TEXT,
    call_id      TEXT,
    subject_id   TEXT,
    actor_id     TEXT NOT NULL,
    summary      TEXT NOT NULL,
    reason       TEXT
  );
  CREATE INDEX ovs_audit_proposal ON ovs_audit(proposal_id, seq);
  `,
];
