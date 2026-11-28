import {
  bookingBookings,
  eq,
  inventoryDepartures,
  paymentsPaymentAttempts,
  paymentsRefunds,
} from '@internationalota/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  bootFailureScenarioHarness,
  type FailureScenarioHarness,
  type SignedInActor,
} from './harness.js';

describe('FS-06: Hold expires as payment arrives (20x race)', () => {
  let h: FailureScenarioHarness;
  let customer: SignedInActor;

  beforeAll(async () => {
    h = await bootFailureScenarioHarness();
    customer = await h.signUpVerifiedCustomer('fs06-cust@example.com', 'Expiry Race');
  }, 60_000);

  afterAll(async () => {
    await h?.teardown();
  });

  it('produces either confirmed+seats or expired+refund_required->refunded across 20 races, reconciliation ok', async () => {
    const departureId = await h.generateDeparture({ capacity: 30 });
    const quote = await h.getQuote(departureId, 1, 'vi');

    let expectedConfirmedSeats = 0;

    for (let i = 0; i < 20; i++) {
      const hold = await h.holdBooking(customer.cookie, departureId, quote.snapshotHash, {
        contactEmail: customer.email,
      });
      expect(hold.status).toBe(201);

      const checkout = await h.checkoutBooking(customer.cookie, hold.body.reference);
      expect(checkout.status).toBe(200);

      // Advance clock past hold_expires_at (+20 min) so expireDue() races concurrently with PSP callback + inbox relay
      const expiredClock = new Date(Date.now() + 20 * 60_000);
      await Promise.allSettled([
        (
          h.bookingService as unknown as {
            expireDue(opts: { limit: number; asOf: Date }): Promise<unknown>;
          }
        ).expireDue({ limit: 5, asOf: expiredClock }),
        h
          .submitMockPspAction(checkout.body.providerRef, 'success')
          .then(() => h.inboxService.relayBatch({ baseBackoffMs: 0 })),
      ]);

      await h.drainAllWorkers();

      const [booking] = await h.db
        .select()
        .from(bookingBookings)
        .where(eq(bookingBookings.id, hold.body.id));
      const [attempt] = await h.db
        .select()
        .from(paymentsPaymentAttempts)
        .where(eq(paymentsPaymentAttempts.id, checkout.body.attemptId));
      const refunds = await h.db
        .select()
        .from(paymentsRefunds)
        .where(eq(paymentsRefunds.paymentAttemptId, checkout.body.attemptId));

      expect(['confirmed', 'expired']).toContain(booking?.status);
      if (booking?.status === 'confirmed') {
        expectedConfirmedSeats += booking.seats;
        expect(attempt?.status).toBe('succeeded');
        expect(refunds).toHaveLength(0);
      } else {
        expect(booking?.status).toBe('expired');
        expect(attempt?.status).toBe('refund_required');
        expect(refunds).toHaveLength(1);
        expect(refunds[0]!.status).toBe('succeeded');
      }
    }

    const [dep] = await h.db
      .select()
      .from(inventoryDepartures)
      .where(eq(inventoryDepartures.id, departureId));
    expect(dep?.allocated).toBe(expectedConfirmedSeats);

    await h.assertReconciliationOk('fs-06-hold-expiry-payment-race');
  }, 60_000);
});
