// What the operator is told after a permit cancellation attempt, and whether
// ParkOS actually considers the permit cancelled.
//
// This exists as a pure function because the old flow got it wrong in a way
// that cost real money: it showed a green "Permit cancelled" even when the
// Stripe call had failed, so staff walked away believing billing had stopped
// while the customer kept paying $150/mo. The rule worth pinning down is that
// success is never reported for a permit whose subscription is still live.

export type PermitCancelAttempt = {
  /** Whether the permit has a Stripe subscription that must be stopped first. */
  hasSubscription: boolean
  /** Recording the cancellation request failed (no Stripe call was made). */
  intentFailed?: boolean
  /** The Stripe cancel call failed. Billing is still running. */
  stripeFailed?: boolean
  /** The direct cancel_permit RPC failed. Only reachable with no subscription. */
  directFailed?: boolean
}

export type PermitCancelOutcome = {
  kind: 'success' | 'error'
  message: string
  /** True only when ParkOS state is already final. Never true while a
   *  subscription exists — the Stripe webhook decides that, not the browser. */
  cancelled: boolean
}

export function permitCancelOutcome(attempt: PermitCancelAttempt): PermitCancelOutcome {
  if (!attempt.hasSubscription) {
    // No subscription means no billing to stop, so cancel_permit is the whole
    // operation and its result is final either way.
    return attempt.directFailed
      ? { kind: 'error', message: 'The permit could not be cancelled.', cancelled: false }
      : { kind: 'success', message: 'Permit cancelled', cancelled: true }
  }

  if (attempt.intentFailed) {
    return {
      kind: 'error',
      message: 'The cancellation could not be started. The permit is unchanged.',
      cancelled: false,
    }
  }

  if (attempt.stripeFailed) {
    return {
      kind: 'error',
      message:
        'Billing could not be stopped in Stripe. The permit is still active and still billing — try again.',
      cancelled: false,
    }
  }

  return {
    kind: 'success',
    message: 'Cancellation requested — billing stopped. The permit closes when Stripe confirms.',
    cancelled: false,
  }
}

/** Whether a row should read as an in-flight cancellation rather than its status. */
export function isCancelling(
  status: string,
  cancellationRequestedAt: string | null,
): boolean {
  return cancellationRequestedAt !== null && status !== 'cancelled'
}
