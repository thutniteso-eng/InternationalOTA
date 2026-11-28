import { bookingBookings, eq, inventoryDepartures } from '@internationalota/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  bootFailureScenarioHarness,
  type FailureScenarioHarness,
  type SignedInActor,
} from './harness.js';

describe('FS-01: 50 concurrent requests for the last seat', () => {
  let h: FailureScenarioHarness;
  const customers: SignedInActor[] = [];

  beforeAll(async () => {
    h = await bootFailureScenarioHarness();
    for (let i = 0; i < 50; i++) {
      customers.push(
        await h.signUpVerifiedCustomer(`fs01-cust-${i + 1}@example.com`, `Customer ${i + 1}`),
      );
    }
  }, 60_000);

  afterAll(async () => {
    await h?.teardown();
  });

  it('allows exactly 1 hold -> paid -> confirmed, returns 49 sold_out, allocated = capacity, reconciliation ok', async () => {
    const departureId = await h.generateDeparture({ capacity: 1 });
    const quote = await h.getQuote(departureId, 1, 'vi');

    const results = await Promise.all(
      customers.map((c, idx) =>
        h.holdBooking(c.cookie, departureId, quote.snapshotHash, {
          idemKey: h.nextIdemKey(`fs01-${idx}`),
          contactName: `Guest ${idx + 1}`,
          contactEmail: c.email,
        }),
      ),
    );

    const winners = results.filter((r) => r.status === 201);
    const losers = results.filter((r) => r.status === 409);
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(49);
    for (const loser of losers) {
      expect(loser.body.code ?? loser.body.errorCode).toBe('sold_out');
    }

    const winnerIdx = results.findIndex((r) => r.status === 201);
    const winner = winners[0]!;
    const winnerActor = customers[winnerIdx]!;

    const checkout = await h.checkoutBooking(winnerActor.cookie, winner.body.reference);
    expect(checkout.status).toBe(200);

    const payStatus = await h.submitMockPspAction(checkout.body.providerRef, 'success');
    expect(payStatus).toBe(303);

    await h.drainAllWorkers();

    const [bookingRow] = await h.db
      .select()
      .from(bookingBookings)
      .where(eq(bookingBookings.reference, winner.body.reference));
    expect(bookingRow?.status).toBe('confirmed');

    const [depRow] = await h.db
      .select()
      .from(inventoryDepartures)
      .where(eq(inventoryDepartures.id, departureId));
    expect(depRow?.allocated).toBe(depRow?.capacity);
    expect(depRow?.allocated).toBe(1);

    await h.assertReconciliationOk('fs-01-last-seat');
  });
});
