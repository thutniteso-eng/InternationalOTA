export const FAULT_POINTS = [
  'checkout.after_tx1',
  'checkout.after_provider_before_tx2',
  'webhook.after_inbox_insert_before_handler',
  'confirm.after_booking_update_before_ledger',
  'refund.after_processing_before_provider',
] as const;

export type FaultPoint = (typeof FAULT_POINTS)[number];

export class SimulatedCrash extends Error {
  readonly faultPoint: FaultPoint;

  constructor(faultPoint: FaultPoint) {
    super(`Simulated crash at fault point "${faultPoint}"`);
    this.name = 'SimulatedCrash';
    this.faultPoint = faultPoint;
  }
}
