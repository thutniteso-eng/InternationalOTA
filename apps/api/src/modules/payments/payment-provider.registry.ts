import { Injectable } from '@nestjs/common';
import type { PaymentProvider } from './payments.types.js';

@Injectable()
export class PaymentProviderRegistry {
  private readonly providers = new Map<string, PaymentProvider>();

  register(provider: PaymentProvider): void {
    this.providers.set(provider.provider, provider);
  }

  unregister(providerName: string): void {
    this.providers.delete(providerName);
  }

  get(providerName?: string): PaymentProvider | undefined {
    const target =
      providerName?.trim() || process.env['PAYMENT_DEFAULT_PROVIDER']?.trim() || 'mock';
    return this.providers.get(target);
  }

  listProviders(): readonly string[] {
    return Array.from(this.providers.keys());
  }
}
