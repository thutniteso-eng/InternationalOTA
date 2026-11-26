import {
  BadRequestException,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';

export function pricingInvalidCurrencyException(currency: string): UnprocessableEntityException {
  return new UnprocessableEntityException({
    message: `Currency "${currency}" is not a supported ISO 4217 code.`,
    i18nKey: 'pricing.priceList.invalidCurrency',
    i18nParams: { currency },
    errorCode: 'pricing.priceList.invalidCurrency',
  });
}

export function pricingCurrencyMismatchException(
  expectedCurrency: string,
  receivedCurrency: string,
): UnprocessableEntityException {
  return new UnprocessableEntityException({
    message: `Product currency is locked to ${expectedCurrency} (cannot create version in ${receivedCurrency}).`,
    i18nKey: 'pricing.priceList.currencyMismatch',
    i18nParams: { expectedCurrency, receivedCurrency },
    errorCode: 'pricing.priceList.currencyMismatch',
  });
}

export function pricingInvalidDateRangeException(reason: string): UnprocessableEntityException {
  return new UnprocessableEntityException({
    message: `Invalid price list validity dates: ${reason}.`,
    i18nKey: 'pricing.priceList.invalidDateRange',
    i18nParams: { reason },
    errorCode: 'pricing.priceList.invalidDateRange',
  });
}

export function pricingMissingAdultItemException(): UnprocessableEntityException {
  return new UnprocessableEntityException({
    message: 'A price list must include an adult item.',
    i18nKey: 'pricing.priceList.missingAdult',
    errorCode: 'pricing.priceList.missingAdult',
  });
}

export function pricingInvalidItemsException(reason: string): UnprocessableEntityException {
  return new UnprocessableEntityException({
    message: `Invalid price list items: ${reason}.`,
    i18nKey: 'pricing.priceList.invalidItems',
    i18nParams: { reason },
    errorCode: 'pricing.priceList.invalidItems',
  });
}

export function pricingOverlappingAgeBandsException(): UnprocessableEntityException {
  return new UnprocessableEntityException({
    message: 'Age bands within a price list must not overlap.',
    i18nKey: 'pricing.priceList.overlappingAgeBands',
    errorCode: 'pricing.priceList.overlappingAgeBands',
  });
}

export function pricingPolicyInvalidRuleCountException(): UnprocessableEntityException {
  return new UnprocessableEntityException({
    message: 'Cancellation policy must contain between 1 and 10 rules.',
    i18nKey: 'pricing.policy.invalidRuleCount',
    errorCode: 'pricing.policy.invalidRuleCount',
  });
}

export function pricingPolicyInvalidRuleValuesException(
  reason: string,
): UnprocessableEntityException {
  return new UnprocessableEntityException({
    message: `Invalid cancellation rule values: ${reason}.`,
    i18nKey: 'pricing.policy.invalidRuleValues',
    i18nParams: { reason },
    errorCode: 'pricing.policy.invalidRuleValues',
  });
}

export function pricingPolicyUnsortedRulesException(): UnprocessableEntityException {
  return new UnprocessableEntityException({
    message: 'Cancellation policy rules must be strictly sorted by hoursBeforeStart descending.',
    i18nKey: 'pricing.policy.unsortedRules',
    errorCode: 'pricing.policy.unsortedRules',
  });
}

export function pricingPolicyNonMonotonicRefundException(): UnprocessableEntityException {
  return new UnprocessableEntityException({
    message:
      'Cancellation policy refundPercent must be non-increasing as hoursBeforeStart decreases.',
    i18nKey: 'pricing.policy.nonMonotonicRefund',
    errorCode: 'pricing.policy.nonMonotonicRefund',
  });
}

export function pricingPolicyMissingZeroHourRuleException(): UnprocessableEntityException {
  return new UnprocessableEntityException({
    message: 'Cancellation policy must include a baseline rule with hoursBeforeStart = 0.',
    i18nKey: 'pricing.policy.missingZeroHourRule',
    errorCode: 'pricing.policy.missingZeroHourRule',
  });
}

export function pricingInvalidQueryException(reason: string): BadRequestException {
  return new BadRequestException({
    message: `Invalid pricing query parameters: ${reason}.`,
    i18nKey: 'pricing.query.invalidParams',
    i18nParams: { reason },
    errorCode: 'pricing.query.invalidParams',
  });
}

export function pricingDepartureNotFoundException(): NotFoundException {
  return new NotFoundException({
    message: 'Departure was not found.',
    i18nKey: 'pricing.quote.departureNotFound',
    errorCode: 'pricing.quote.departureNotFound',
  });
}
