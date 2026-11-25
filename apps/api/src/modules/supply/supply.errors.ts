import { BadRequestException, NotFoundException } from '@nestjs/common';

export function supplierNotFoundException(): NotFoundException {
  return new NotFoundException({
    message: 'Supplier was not found.',
    i18nKey: 'supply.notFound',
    errorCode: 'supply.notFound',
  });
}

export function supplierInvalidCountryException(countryAlpha2: string): BadRequestException {
  return new BadRequestException({
    message: `Invalid ISO 3166-1 country code (${countryAlpha2}).`,
    i18nKey: 'supply.invalidCountry',
    i18nParams: { countryAlpha2 },
    errorCode: 'supply.invalidCountry',
  });
}

export function supplierValidationException(reason: string): BadRequestException {
  return new BadRequestException({
    message: `Invalid supplier payload: ${reason}`,
    i18nKey: 'supply.validation',
    i18nParams: { reason },
    errorCode: 'supply.validation',
  });
}
