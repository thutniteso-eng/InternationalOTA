import {
  and,
  eq,
  financeAccounts,
  financeJournalLines,
  inventoryDepartures,
  notificationsEmailMessages,
  opsAdminAudit,
  paymentsRefunds,
  sql,
} from '@internationalota/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  bootFailureScenarioHarness,
  type FailureScenarioHarness,
  findBookingRow,
  type SignedInActor,
} from './harness.js';

describe('FS-04: Paid but supplier rejects (POST /admin/bookings/:reference/reject)', () => {
  let h: FailureScenarioHarness;
  let customer: SignedInActor;

  beforeAll(async () => {
    h = await bootFailureScenarioHarness();
    customer = await h.signUpVerifiedCustomer('fs04-cust@example.com', 'Supplier Reject Guest');
  }, 60_000);

  afterAll(async () => {
    await h?.teardown();
  });

  it('enforces auth/status guards, rejects confirmed booking idempotently, releases seats, issues 100% refund, sends supplier-rejection email, reconciliation ok', async () => {
    const departureId = await h.generateDeparture({ capacity: 5 });
    const quote = await h.getQuote(departureId, 1, 'vi');

    // Non-confirmed booking -> 409
    const heldHold = await h.holdBooking(customer.cookie, departureId, quote.snapshotHash, {
      contactEmail: customer.email,
      locale: 'vi',
    });
    expect(heldHold.status).toBe(201);

    // 401 unauthenticated
    const unauthRes = await h.rejectBookingHttp(heldHold.body.reference, 'Supplier full', {
      cookie: '',
    });
    expect(unauthRes.status).toBe(401);

    // 403 non-admin customer
    const forbiddenRes = await h.rejectBookingHttp(heldHold.body.reference, 'Supplier full', {
      cookie: customer.cookie,
    });
    expect(forbiddenRes.status).toBe(403);

    // 400 missing reason
    const badReasonRes = await h.rejectBookingHttp(heldHold.body.reference, '   ');
    expect(badReasonRes.status).toBe(400);

    // 409 when booking is still held (not confirmed)
    const heldRejectRes = await h.rejectBookingHttp(heldHold.body.reference, 'Not confirmed yet');
    expect(heldRejectRes.status).toBe(409);

    // Pay and confirm booking
    const checkout = await h.checkoutBooking(customer.cookie, heldHold.body.reference);
    expect(checkout.status).toBe(200);
    expect(await h.submitMockPspAction(checkout.body.providerRef, 'success')).toBe(303);
    await h.drainAllWorkers();

    const confirmedRow = await findBookingRow(h.db, heldHold.body.reference);
    expect(confirmedRow?.status).toBe('confirmed');
    h.emailTransport.clearCapturedMessages();

    // Verify atomic rollback: if ledger/outbox fails after inventory release inside reject tx,
    // seats MUST remain allocated (kills release-outside-tx mutations) and reconciliation stays ok.
    const origEnqueue = h.outboxService.enqueue.bind(h.outboxService);
    h.outboxService.enqueue = () => Promise.reject(new Error('Simulated outbox abort in reject'));
    try {
      const abortedReject = await h.rejectBookingHttp(heldHold.body.reference, 'Should rollback');
      expect(abortedReject.status).toBe(500);
    } finally {
      h.outboxService.enqueue = origEnqueue;
    }
    const [depAfterAbort] = await h.db
      .select()
      .from(inventoryDepartures)
      .where(eq(inventoryDepartures.id, departureId));
    expect(depAfterAbort?.allocated).toBe(1);
    await h.assertReconciliationOk('fs-04-abort-rollback');

    // Happy reject with Idempotency-Key
    const rejectKey = h.nextIdemKey('fs04-reject');
    const rejectRes = await h.rejectBookingHttp(
      heldHold.body.reference,
      'Supplier boat maintenance',
      { idemKey: rejectKey },
    );
    expect(rejectRes.status, JSON.stringify(rejectRes.body)).toBe(200);
    expect(rejectRes.body['bookingStatus']).toBe('cancelled');
    expect(rejectRes.body['refundAmountMinor']).toBe('1000000');

    // Idempotent replay -> 200 with Idempotent-Replayed header
    const replayRes = await h.rejectBookingHttp(
      heldHold.body.reference,
      'Supplier boat maintenance',
      { idemKey: rejectKey },
    );
    expect(replayRes.status).toBe(200);
    expect(replayRes.headers.get('Idempotent-Replayed')).toBe('true');

    // New Idempotency-Key on already-cancelled booking -> 409
    const secondRejectRes = await h.rejectBookingHttp(
      heldHold.body.reference,
      'Second reject attempt',
    );
    expect(secondRejectRes.status).toBe(409);

    // Seats released & audit row recorded
    const [depAfterReject] = await h.db
      .select()
      .from(inventoryDepartures)
      .where(eq(inventoryDepartures.id, departureId));
    expect(depAfterReject?.allocated).toBe(0);

    const audits = await h.db
      .select()
      .from(opsAdminAudit)
      .where(
        and(
          eq(opsAdminAudit.targetId, heldHold.body.id),
          eq(opsAdminAudit.action, 'booking_reject'),
        ),
      );
    expect(audits).toHaveLength(1);
    expect(audits[0]!.reason).toBe('Supplier boat maintenance');

    // Drain refund executor & email workers
    await h.drainAllWorkers();

    const refunds = await h.db
      .select()
      .from(paymentsRefunds)
      .where(eq(paymentsRefunds.bookingId, heldHold.body.id));
    expect(refunds).toHaveLength(1);
    expect(refunds[0]!.reason).toBe('supplier_rejected');
    expect(refunds[0]!.status).toBe('succeeded');
    expect(refunds[0]!.amountMinor).toBe(1_000_000n);

    // Prepayments liability net = 0
    const [prepayAccount] = await h.db
      .select()
      .from(financeAccounts)
      .where(eq(financeAccounts.code, 'liability:customer_prepayments:VND'));
    const prepayNet = await h.db.execute<{ net: string }>(sql`
      SELECT COALESCE(SUM(credit_minor - debit_minor), 0)::text AS net
      FROM ${financeJournalLines}
      WHERE account_id = ${prepayAccount!.id}
    `);
    expect(BigInt(prepayNet.rows[0]?.net ?? '0')).toBe(0n);

    // Customer received cancellation email mentioning supplier rejection + 100% refund
    const emails = await h.db.select().from(notificationsEmailMessages);
    expect(emails.some((e) => e.template === 'booking_cancelled' && e.status === 'sent')).toBe(
      true,
    );
    expect(emails.some((e) => e.template === 'refund_succeeded' && e.status === 'sent')).toBe(true);

    const capturedCancel = h.emailTransport
      .getCapturedMessages()
      .find((m) => m.headers?.['X-Notification-Template'] === 'booking_cancelled');
    expect(capturedCancel?.text).toContain('nhà cung cấp từ chối');
    expect(capturedCancel?.text).toContain('100%');

    await h.assertReconciliationOk('fs-04-supplier-reject');
  });
});
