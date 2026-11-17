/**
 * ::Quorum.ResearchFunding.PeerReview.ThreeSubmittedReviews (INV-5): the panel size. A business-rule constant
 * shared by AssignmentService (panel full) and ReviewCompletion (scored at exactly three); owned by neither.
 */
export const REVIEWERS_PER_PROPOSAL = 3;

/**
 * ADR-023 (BDL RevokeOnErasure, obligation ReleaseErasedReviewersWork): the reason AssignmentService records
 * when it revokes an erased reviewer's outstanding assignment. Shared so Notification can tell the program
 * officers a replacement is needed instead of writing to the erased account; owned by neither context.
 */
export const REVOKED_ON_ERASURE = 'the reviewer’s account was erased; the place is open for a replacement reviewer';
