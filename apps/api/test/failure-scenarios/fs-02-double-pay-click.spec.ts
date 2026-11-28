import {
  eq,
  financeAccounts,
  financeJournalLines,
  paymentsPaymentAttempts,
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

describe('FS-02: Double pay click (same key vs different keys)', () => {
  let h: FailureScenarioHarness;
  let customer: SignedInActor;

  beforeAll(async () => {
    h = await bootFailureScenarioHarness();
    customer = await h.signUpVerifiedCustomer('fs02-cust@example.com', 'Double Click');
  }, 60_000);

  afterAll(async () => {
    await h?.teardown();
  });

  it('collapses same Idempotency-Key into 1 attempt and refunds double payment under different keys cleanly (reconciliation ok)', async () => {
    const dep1 = await h.generateDeparture({ capacity: 10 });
    const quote1 = await h.getQuote(dep1, 1, 'vi');
    const hold1 = await h.holdBooking(customer.cookie, dep1, quote1.snapshotHash, {
      contactEmail: customer.email,
    });
    expect(hold1.status).toBe(201);

    // 1. Same Idempotency-Key fired concurrently -> at most 1 attempt created
    const sharedKey = h.nextIdemKey('fs02-same');
    const [r1, r2] = await Promise.all([
      h.checkoutBooking(customer.cookie, hold1.body.reference, sharedKey),
      h.checkoutBooking(customer.cookie, hold1.body.reference, sharedKey),
    ]);
    const sameKeyStatuses = [r1.status, r2.status].sort((a, b) => a - b);
    expect(sameKeyStatuses[0]).toBe(200);
    expect([200, 409]).toContain(sameKeyStatuses[1]);

    // Ensure replaying same key returns identical attempt
    const replay = await h.checkoutBooking(customer.cookie, hold1.body.reference, sharedKey);
    expect(replay.status).toBe(200);
    const sameAttempts = await h.db
      .select()
      .from(paymentsPaymentAttempts)
      .where(eq(paymentsPaymentAttempts.bookingId, hold1.body.id));
    expect(sameAttempts).toHaveLength(1);

    // 2. Different Idempotency-Keys -> 2 attempts both succeed at Mock PSP -> 1 confirmed + 1 double_payment refunded
    const secondKeyCheckout = await h.checkoutBooking(
      customer.cookie,
      hold1.body.reference,
      h.nextIdemKey('fs02-diff'),
    );
    expect(secondKeyCheckout.status).toBe(200);

    const attempts = await h.db
      .select()
      .from(paymentsPaymentAttempts)
      .where(eq(paymentsPaymentAttempts.bookingId, hold1.body.id));
    expect(attempts).toHaveLength(2);

    const [pay1, pay2] = await Promise.all([
      h.submitMockPspAction(replay.body.providerRef, 'success'),
      h.submitMockPspAction(secondKeyCheckout.body.providerRef, 'success'),
    ]);
    expect(pay1).toBe(303);
    expect(pay2).toBe(303);

    await h.drainAllWorkers();

    const refreshedBooking = await findBookingRow(h.db, hold1.body.reference);
    expect(refreshedBooking?.status).toBe('confirmed');

    const finalAttempts = await h.db
      .select()
      .from(paymentsPaymentAttempts)
      .where(eq(paymentsPaymentAttempts.bookingId, hold1.body.id));
    const succeededAttempts = finalAttempts.filter((a) => a.status === 'succeeded');
    const refundRequiredAttempts = finalAttempts.filter((a) => a.status === 'refund_required');
    expect(succeededAttempts).toHaveLength(1);
    expect(refundRequiredAttempts).toHaveLength(1);

    const refunds = await h.db
      .select()
      .from(paymentsRefunds)
      .where(eq(paymentsRefunds.bookingId, hold1.body.id));
    expect(refunds).toHaveLength(1);
    expect(refunds[0]!.reason).toBe('double_payment');
    expect(refunds[0]!.status).toBe('succeeded');

    // Net ledger charge on customer prepayments = 1 * totalAmountMinor (1_000_000 VND)
    const [prepayAccount] = await h.db
      .select()
      .from(financeAccounts)
      .where(eq(financeAccounts.code, 'liability:customer_prepayments:VND'));
    expect(prepayAccount).toBeDefined();
    const prepayNet = await h.db.execute<{ net: string }>(sql`
      SELECT COALESCE(SUM(credit_minor - debit_minor), 0)::text AS net
      FROM ${financeJournalLines}
      WHERE account_id = ${prepayAccount!.id}
    `);
    expect(BigInt(prepayNet.rows[0]?.net ?? '0')).toBe(1_000_000n);

    const [clearingAccount] = await h.db
      .select()
      .from(financeAccounts)
      .where(eq(financeAccounts.code, 'asset:psp_clearing:mock:VND'));
    expect(clearingAccount).toBeDefined();
    const clearingNet = await h.db.execute<{ net: string }>(sql`
      SELECT COALESCE(SUM(debit_minor - credit_minor), 0)::text AS net
      FROM ${financeJournalLines}
      WHERE account_id = ${clearingAccount!.id}
    `);
    expect(BigInt(clearingNet.rows[0]?.net ?? '0')).toBe(1_000_000n);

    await h.assertReconciliationOk('fs-02-double-pay-click');
  });
});
