import {
  and,
  eq,
  financeJournalEntries,
  financeJournalLines,
  inventoryDepartures,
} from '@internationalota/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  bootFailureScenarioHarness,
  type FailureScenarioHarness,
  findBookingRow,
  type SignedInActor,
} from './harness.js';

describe('FS-07: Price change before pay', () => {
  let h: FailureScenarioHarness;
  let customer: SignedInActor;

  beforeAll(async () => {
    h = await bootFailureScenarioHarness();
    customer = await h.signUpVerifiedCustomer('fs07-cust@example.com', 'Price Change');
  }, 60_000);

  afterAll(async () => {
    await h?.teardown();
  });

  it('rejects old quote hash with 409 price_changed, accepts new hash, pays at updated total, reconciliation ok', async () => {
    const departureId = await h.generateDeparture({ capacity: 10 });
    const oldQuote = await h.getQuote(departureId, 1, 'vi');
    expect(oldQuote.totalAmountMinor).toBe('1000000');

    // Admin publishes new price list (1,350,000 VND per adult)
    const priceRes = await h.adminPost(`/admin/pricing/products/${h.productId}/price-lists`, {
      currency: 'VND',
      validFrom: '2026-02-01',
      items: [
        { paxType: 'adult', amountMinor: '1350000', minAge: 10, occupiesSeat: true },
        { paxType: 'child', amountMinor: '900000', minAge: 5, maxAge: 9, occupiesSeat: true },
        { paxType: 'infant', amountMinor: '0', minAge: 0, maxAge: 4, occupiesSeat: false },
      ],
    });
    expect(priceRes.status).toBe(201);

    // Hold using stale hash -> 409 price_changed with updated quote
    const staleHold = await h.holdBooking(customer.cookie, departureId, oldQuote.snapshotHash, {
      contactEmail: customer.email,
    });
    expect(staleHold.status).toBe(409);
    const staleBody = staleHold.body as unknown as {
      errorCode?: string;
      code?: string;
      quote?: { totalAmountMinor: string; snapshotHash: string };
    };
    expect(staleBody.code ?? staleBody.errorCode).toBe('price_changed');
    expect(staleBody.quote?.totalAmountMinor).toBe('1350000');
    expect(staleBody.quote?.snapshotHash).toBeDefined();
    expect(staleBody.quote?.snapshotHash).not.toBe(oldQuote.snapshotHash);

    const [depAfterReject] = await h.db
      .select()
      .from(inventoryDepartures)
      .where(eq(inventoryDepartures.id, departureId));
    expect(depAfterReject?.allocated).toBe(0);

    // Accept new price hash -> hold -> checkout -> Mock PSP pay -> confirmed at 1,350,000 VND
    const acceptedHold = await h.holdBooking(
      customer.cookie,
      departureId,
      staleBody.quote!.snapshotHash,
      { contactEmail: customer.email },
    );
    expect(acceptedHold.status).toBe(201);
    expect(acceptedHold.body.totalAmountMinor).toBe('1350000');

    const checkout = await h.checkoutBooking(customer.cookie, acceptedHold.body.reference);
    expect(checkout.status).toBe(200);
    expect(await h.submitMockPspAction(checkout.body.providerRef, 'success')).toBe(303);
    await h.drainAllWorkers();

    const finalBooking = await findBookingRow(h.db, acceptedHold.body.reference);
    expect(finalBooking?.status).toBe('confirmed');
    expect(finalBooking?.totalAmountMinor).toBe(1_350_000n);

    const [entry] = await h.db
      .select()
      .from(financeJournalEntries)
      .where(
        and(
          eq(financeJournalEntries.sourceType, 'payment_attempt'),
          eq(financeJournalEntries.sourceId, checkout.body.attemptId),
        ),
      );
    expect(entry).toBeDefined();
    const lines = await h.db
      .select()
      .from(financeJournalLines)
      .where(eq(financeJournalLines.entryId, entry!.id));
    expect(lines.every((l) => l.debitMinor === 1_350_000n || l.creditMinor === 1_350_000n)).toBe(
      true,
    );

    await h.assertReconciliationOk('fs-07-price-change-before-pay');
  });
});
