import { resolveAppEnv } from '@internationalota/shared';
import { Injectable } from '@nestjs/common';
import { type FaultPoint, SimulatedCrash } from './fault-injection.types.js';

/**
 * Test-only crash injector.
 *
 * Strictly inactive (complete no-op) unless BOTH:
 * - `resolveAppEnv() === 'test'`
 * - `process.env['FAULT_INJECTION'] === '1'`
 */
@Injectable()
export class FaultInjector {
  private readonly armedCounts = new Map<FaultPoint, number>();

  isActive(): boolean {
    return resolveAppEnv() === 'test' && process.env['FAULT_INJECTION'] === '1';
  }

  arm(point: FaultPoint, count = 1): void {
    if (!this.isActive()) {
      return;
    }
    if (count <= 0) {
      this.armedCounts.delete(point);
      return;
    }
    this.armedCounts.set(point, count);
  }

  disarm(point?: FaultPoint): void {
    if (point) {
      this.armedCounts.delete(point);
    } else {
      this.armedCounts.clear();
    }
  }

  isArmed(point: FaultPoint): boolean {
    if (!this.isActive()) {
      return false;
    }
    return (this.armedCounts.get(point) ?? 0) > 0;
  }

  maybeFail(point: FaultPoint): void {
    if (!this.isActive()) {
      return;
    }
    const remaining = this.armedCounts.get(point) ?? 0;
    if (remaining <= 0) {
      return;
    }
    if (remaining <= 1) {
      this.armedCounts.delete(point);
    } else {
      this.armedCounts.set(point, remaining - 1);
    }
    throw new SimulatedCrash(point);
  }
}
