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

describe('FS-08: Cancel during confirm (20x race)', () => {
  let h: FailureScenarioHarness;
  let customer: SignedInActor;

  beforeAll(async () => {
    h = await bootFailureScenarioHarness();
    customer = await h.signUpVerifiedCustomer('fs08-cust@example.com', 'Cancel Confirm Race');
  }, 60_000);

  afterAll(async () => {
    await h?.teardown();
  });

  it('never leaves cancelled charged without refund or confirmed without seats across 20 concurrent races, reconciliation ok', async () => {
    const departureId = await h.generateDeparture({ capacity: 30 });
    const quote = await h.getQuote(departureId, 1, 'vi');

    // Verify transitionBooking rejects stale expectedVersion (v1 after checkout bumped to v2)
    {
      const versionHold = await h.holdBooking(customer.cookie, departureId, quote.snapshotHash, {
        contactEmail: customer.email,
      });
      expect(versionHold.status).toBe(201);
      const versionCheckout = await h.checkoutBooking(customer.cookie, versionHold.body.reference);
      expect(versionCheckout.status).toBe(200);

      const staleCancel = await h.bookingService.cancelBeforePayment(
        versionHold.body.id,
        customer.userId,
        { expectedVersion: 1 },
      );
      expect(staleCancel.ok).toBe(false);

      const freshCancel = await h.cancelBookingHttp(customer.cookie, versionHold.body.reference);
      expect(freshCancel.status).toBe(200);
    }

    let expectedConfirmedSeats = 0;

    for (let i = 0; i < 20; i++) {
      const hold = await h.holdBooking(customer.cookie, departureId, quote.snapshotHash, {
        contactEmail: customer.email,
      });
      expect(hold.status).toBe(201);

      const checkout = await h.checkoutBooking(customer.cookie, hold.body.reference);
      expect(checkout.status).toBe(200);

      await Promise.allSettled([
        h.cancelBookingHttp(customer.cookie, hold.body.reference),
        h.submitMockPspAction(checkout.body.providerRef, 'success'),
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

      expect(['confirmed', 'cancelled']).toContain(booking?.status);
      if (booking?.status === 'confirmed') {
        expectedConfirmedSeats += booking.seats;
        expect(attempt?.status).toBe('succeeded');
        expect(booking.paymentRef).toBe(checkout.body.providerRef);
      } else {
        // Never cancelled while charged without a refund
        expect(['succeeded', 'refund_required']).toContain(attempt?.status);
        expect(refunds).toHaveLength(1);
        expect(refunds[0]!.status).toBe('succeeded');
        expect(refunds[0]!.amountMinor).toBe(booking?.totalAmountMinor);
      }
    }

    const [dep] = await h.db
      .select()
      .from(inventoryDepartures)
      .where(eq(inventoryDepartures.id, departureId));
    expect(dep?.allocated).toBe(expectedConfirmedSeats);

    await h.assertReconciliationOk('fs-08-cancel-during-confirm');
  }, 60_000);
});
