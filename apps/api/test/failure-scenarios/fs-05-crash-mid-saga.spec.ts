import { randomUUID } from 'node:crypto';
import {
  and,
  eq,
  financeJournalEntries,
  inboxMessages,
  paymentsMockPspTransactions,
  paymentsPaymentAttempts,
  paymentsRefunds,
} from '@internationalota/db';
import { Test } from '@nestjs/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FaultInjectionModule, SimulatedCrash } from '../../src/common/fault-injection/index.js';
import {
  bootFailureScenarioHarness,
  type FailureScenarioHarness,
  findBookingRow,
  type SignedInActor,
} from './harness.js';

describe('FS-05: Crash mid-saga across all 5 fault points + FaultInjectionModule guards', () => {
  let h: FailureScenarioHarness;
  let customer: SignedInActor;

  beforeAll(async () => {
    h = await bootFailureScenarioHarness({ faultInjection: true });
    customer = await h.signUpVerifiedCustomer('fs05-cust@example.com', 'Saga Crash Guest');
  }, 60_000);

  afterAll(async () => {
    await h?.teardown();
  });

  it('AC2: FaultInjectionModule refuses APP_ENV=production and is a complete no-op when FAULT_INJECTION!=1', async () => {
    const prevAppEnv = process.env['APP_ENV'];
    const prevFlag = process.env['FAULT_INJECTION'];

    try {
      process.env['FAULT_INJECTION'] = '0';
      expect(h.faultInjector.isActive()).toBe(false);
      h.faultInjector.arm('checkout.after_tx1');
      expect(() => h.faultInjector.maybeFail('checkout.after_tx1')).not.toThrow();

      process.env['APP_ENV'] = 'production';
      process.env['FAULT_INJECTION'] = '1';
      expect(h.faultInjector.isActive()).toBe(false);
      h.faultInjector.arm('checkout.after_tx1');
      expect(() => h.faultInjector.maybeFail('checkout.after_tx1')).not.toThrow();

      const prodMod = await Test.createTestingModule({
        imports: [FaultInjectionModule],
      }).compile();
      await expect(prodMod.init()).rejects.toThrow(/APP_ENV=production/);
      await prodMod.close().catch(() => undefined);
    } finally {
      if (prevAppEnv === undefined) delete process.env['APP_ENV'];
      else process.env['APP_ENV'] = prevAppEnv;
      if (prevFlag === undefined) delete process.env['FAULT_INJECTION'];
      else process.env['FAULT_INJECTION'] = prevFlag;
      h.faultInjector.disarm();
    }
  });

  it('AC3: Recovers cleanly from all 5 fault points with reconciliation ok after each', async () => {
    // 1. checkout.after_tx1
    {
      const dep = await h.generateDeparture({ capacity: 10 });
      const quote = await h.getQuote(dep);
      const hold = await h.holdBooking(customer.cookie, dep, quote.snapshotHash, {
        contactEmail: customer.email,
      });
      expect(hold.status).toBe(201);

      const idemKey = h.nextIdemKey('fp1');
      h.faultInjector.arm('checkout.after_tx1', 1);
      const crashed = await h.checkoutBooking(customer.cookie, hold.body.reference, idemKey);
      expect(crashed.status).toBe(500);

      const retry = await h.checkoutBooking(customer.cookie, hold.body.reference, idemKey);
      expect(retry.status).toBe(200);
      expect(await h.submitMockPspAction(retry.body.providerRef, 'success')).toBe(303);

      // Payment reconciliation job expires the aborted pre-provider attempt cleanly
      await h.paymentsService.reconcilePending({ staleAfterMinutes: 0, expireAfterMinutes: 0 });
      await h.drainAllWorkers();

      const finalRow = await findBookingRow(h.db, hold.body.reference);
      expect(finalRow?.status).toBe('confirmed');
      await h.assertReconciliationOk('fs-05-fp1-checkout-after-tx1');
    }

    // 2. checkout.after_provider_before_tx2
    {
      const dep = await h.generateDeparture({ capacity: 10 });
      const quote = await h.getQuote(dep);
      const hold = await h.holdBooking(customer.cookie, dep, quote.snapshotHash, {
        contactEmail: customer.email,
      });
      expect(hold.status).toBe(201);

      h.faultInjector.arm('checkout.after_provider_before_tx2', 1);
      const crashed = await h.checkoutBooking(
        customer.cookie,
        hold.body.reference,
        h.nextIdemKey('fp2'),
      );
      expect(crashed.status).toBe(500);

      // Reconciler recovers provider_ref from provider before payment
      const reconPre = await h.paymentsService.reconcilePending({ staleAfterMinutes: 0 });
      expect(reconPre.checkedCount).toBeGreaterThanOrEqual(1);

      const [recoveredAttempt] = await h.db
        .select()
        .from(paymentsPaymentAttempts)
        .where(eq(paymentsPaymentAttempts.bookingId, hold.body.id));
      expect(recoveredAttempt?.providerRef).toMatch(/^mock_/);

      expect(await h.submitMockPspAction(recoveredAttempt!.providerRef!, 'success')).toBe(303);
      await h.drainAllWorkers();

      const finalRow = await findBookingRow(h.db, hold.body.reference);
      expect(finalRow?.status).toBe('confirmed');
      await h.assertReconciliationOk('fs-05-fp2-after-provider-before-tx2');
    }

    // 3. webhook.after_inbox_insert_before_handler
    {
      const dep = await h.generateDeparture({ capacity: 10 });
      const quote = await h.getQuote(dep);
      const hold = await h.holdBooking(customer.cookie, dep, quote.snapshotHash, {
        contactEmail: customer.email,
      });
      expect(hold.status).toBe(201);
      const checkout = await h.checkoutBooking(customer.cookie, hold.body.reference);
      expect(checkout.status).toBe(200);

      const eventId = randomUUID();
      const occurredAt = new Date().toISOString();
      await h.db
        .update(paymentsMockPspTransactions)
        .set({ status: 'succeeded', lastEventId: eventId, occurredAt: new Date(occurredAt) })
        .where(eq(paymentsMockPspTransactions.providerRef, checkout.body.providerRef));

      const signed = h.mockProvider.buildSignedCallback({
        eventId,
        providerRef: checkout.body.providerRef,
        outcome: 'succeeded',
        amountMinor: 1_000_000n,
        currency: 'VND',
        occurredAt,
      });

      h.faultInjector.arm('webhook.after_inbox_insert_before_handler', 1);
      const webhookCrash = await fetch(`${h.baseUrl}/webhooks/mock-psp`, {
        method: 'POST',
        headers: signed.headers,
        body: signed.rawBody,
      });
      expect(webhookCrash.status).toBe(500);

      const [inboxRow] = await h.db
        .select()
        .from(inboxMessages)
        .where(eq(inboxMessages.providerEventId, eventId));
      expect(inboxRow).toBeDefined();
      expect(inboxRow?.processedAt).toBeNull();

      await h.drainAllWorkers();
      const finalRow = await findBookingRow(h.db, hold.body.reference);
      expect(finalRow?.status).toBe('confirmed');
      await h.assertReconciliationOk('fs-05-fp3-webhook-after-inbox');
    }

    // 4. confirm.after_booking_update_before_ledger (rolls back transaction completely)
    {
      const dep = await h.generateDeparture({ capacity: 10 });
      const quote = await h.getQuote(dep);
      const hold = await h.holdBooking(customer.cookie, dep, quote.snapshotHash, {
        contactEmail: customer.email,
      });
      expect(hold.status).toBe(201);
      const checkout = await h.checkoutBooking(customer.cookie, hold.body.reference);
      expect(checkout.status).toBe(200);

      h.faultInjector.arm('confirm.after_booking_update_before_ledger', 1);
      expect(await h.submitMockPspAction(checkout.body.providerRef, 'success')).toBe(303);

      // Relay attempt 1 hits SimulatedCrash inside tx -> full rollback
      await h.inboxService.relayBatch({ baseBackoffMs: 0 });
      const rolledBackBooking = await findBookingRow(h.db, hold.body.reference);
      expect(rolledBackBooking?.status).toBe('payment_pending');

      const [rolledBackAttempt] = await h.db
        .select()
        .from(paymentsPaymentAttempts)
        .where(eq(paymentsPaymentAttempts.id, checkout.body.attemptId));
      expect(rolledBackAttempt?.status).toBe('initiated');

      const ledgerEntriesPreRetry = await h.db
        .select()
        .from(financeJournalEntries)
        .where(eq(financeJournalEntries.sourceId, checkout.body.attemptId));
      expect(ledgerEntriesPreRetry).toHaveLength(0);

      // Retry inbox relay recovers completely
      await h.drainAllWorkers();
      const confirmedBooking = await findBookingRow(h.db, hold.body.reference);
      expect(confirmedBooking?.status).toBe('confirmed');
      await h.assertReconciliationOk('fs-05-fp4-confirm-rollback');
    }

    // 5. refund.after_processing_before_provider
    {
      const dep = await h.generateDeparture({ capacity: 10 });
      const quote = await h.getQuote(dep);
      const hold = await h.holdBooking(customer.cookie, dep, quote.snapshotHash, {
        contactEmail: customer.email,
      });
      expect(hold.status).toBe(201);
      const checkout = await h.checkoutBooking(customer.cookie, hold.body.reference);
      expect(checkout.status).toBe(200);
      expect(await h.submitMockPspAction(checkout.body.providerRef, 'success')).toBe(303);
      await h.drainAllWorkers();

      const cancelRes = await h.cancelBookingHttp(customer.cookie, hold.body.reference);
      expect(cancelRes.status).toBe(200);

      h.faultInjector.arm('refund.after_processing_before_provider', 1);
      await expect(h.refundService.processDueRefunds()).rejects.toThrow(SimulatedCrash);

      const [stuckProcessing] = await h.db
        .select()
        .from(paymentsRefunds)
        .where(eq(paymentsRefunds.bookingId, hold.body.id));
      expect(stuckProcessing?.status).toBe('processing');
      expect(stuckProcessing?.providerRefundRef).toBeNull();

      // Recovery via refund executor reclaiming stale processing row + callback
      await h.drainAllWorkers();
      const [recoveredRefund] = await h.db
        .select()
        .from(paymentsRefunds)
        .where(and(eq(paymentsRefunds.id, stuckProcessing!.id)));
      expect(recoveredRefund?.status).toBe('succeeded');
      await h.assertReconciliationOk('fs-05-fp5-refund-after-processing');
    }
  }, 60_000);
});
