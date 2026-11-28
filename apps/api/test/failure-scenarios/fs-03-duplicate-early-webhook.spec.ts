import { randomUUID } from 'node:crypto';
import {
  and,
  bookingEvents,
  eq,
  financeJournalEntries,
  inboxMessages,
  paymentsMockPspTransactions,
  paymentsPaymentAttempts,
} from '@internationalota/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  bootFailureScenarioHarness,
  type FailureScenarioHarness,
  findBookingRow,
  type SignedInActor,
} from './harness.js';

describe('FS-03: Duplicate and early webhook before provider_ref is stored', () => {
  let h: FailureScenarioHarness;
  let customer: SignedInActor;

  beforeAll(async () => {
    h = await bootFailureScenarioHarness({ faultInjection: true });
    customer = await h.signUpVerifiedCustomer('fs03-cust@example.com', 'Webhook Early');
  }, 60_000);

  afterAll(async () => {
    await h?.teardown();
  });

  it('recovers early webhook delivered before provider_ref is stored + 5x concurrent copies into 1 confirmation and 1 ledger posting', async () => {
    const departureId = await h.generateDeparture({ capacity: 10 });
    const quote = await h.getQuote(departureId, 1, 'vi');
    const hold = await h.holdBooking(customer.cookie, departureId, quote.snapshotHash, {
      contactEmail: customer.email,
    });
    expect(hold.status).toBe(201);

    // 1. Crash checkout right after provider creates checkout, BEFORE tx2 stores provider_ref
    h.faultInjector.arm('checkout.after_provider_before_tx2', 1);
    const crashedCheckout = await h.checkoutBooking(
      customer.cookie,
      hold.body.reference,
      h.nextIdemKey('fs03-early'),
    );
    expect(crashedCheckout.status).toBe(500);

    const [attemptRow] = await h.db
      .select()
      .from(paymentsPaymentAttempts)
      .where(eq(paymentsPaymentAttempts.bookingId, hold.body.id));
    expect(attemptRow?.providerRef).toBeNull();

    const [mockTx] = await h.db
      .select()
      .from(paymentsMockPspTransactions)
      .where(eq(paymentsMockPspTransactions.attemptId, attemptRow!.id));
    expect(mockTx).toBeDefined();

    // 2. Callback arrives 5x concurrently BEFORE payment_attempts.provider_ref is stored
    const sharedEventId = randomUUID();
    const occurredAt = new Date().toISOString();
    await h.db
      .update(paymentsMockPspTransactions)
      .set({ status: 'succeeded', lastEventId: sharedEventId, occurredAt: new Date(occurredAt) })
      .where(eq(paymentsMockPspTransactions.id, mockTx!.id));

    const signed = h.mockProvider.buildSignedCallback({
      eventId: sharedEventId,
      providerRef: mockTx!.providerRef,
      outcome: 'succeeded',
      amountMinor: mockTx!.amountMinor,
      currency: mockTx!.currency,
      occurredAt,
    });

    const deliveries = await Promise.all(
      Array.from({ length: 5 }, () =>
        fetch(`${h.baseUrl}/webhooks/mock-psp`, {
          method: 'POST',
          headers: signed.headers,
          body: signed.rawBody,
        }),
      ),
    );
    for (const d of deliveries) {
      expect(d.status).toBe(200);
    }

    const inboxRows = await h.db
      .select()
      .from(inboxMessages)
      .where(eq(inboxMessages.providerEventId, sharedEventId));
    expect(inboxRows).toHaveLength(1);

    // Early relay while provider_ref is still null fails safely and stays retryable
    await h.inboxService.relayBatch({ baseBackoffMs: 0 });
    const [earlyAttempt] = await h.db
      .select()
      .from(paymentsPaymentAttempts)
      .where(eq(paymentsPaymentAttempts.id, attemptRow!.id));
    expect(earlyAttempt?.status).toBe('initiated');

    // 3. Recovery via reconciliation job (restores provider_ref) + inbox retry
    const reconRes = await h.paymentsService.reconcilePending({ staleAfterMinutes: 0 });
    expect(reconRes.resolvedCount).toBe(1);

    await h.drainAllWorkers();

    const finalBooking = await findBookingRow(h.db, hold.body.reference);
    expect(finalBooking?.status).toBe('confirmed');

    const confirmEvents = await h.db
      .select()
      .from(bookingEvents)
      .where(
        and(eq(bookingEvents.bookingId, hold.body.id), eq(bookingEvents.toStatus, 'confirmed')),
      );
    expect(confirmEvents).toHaveLength(1);

    const captureEntries = await h.db
      .select()
      .from(financeJournalEntries)
      .where(
        and(
          eq(financeJournalEntries.sourceType, 'payment_attempt'),
          eq(financeJournalEntries.sourceId, attemptRow!.id),
          eq(financeJournalEntries.entryKind, 'payment_capture'),
        ),
      );
    expect(captureEntries).toHaveLength(1);

    await h.assertReconciliationOk('fs-03-duplicate-early-webhook');
  });
});
