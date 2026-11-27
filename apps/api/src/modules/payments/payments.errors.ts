import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';

export function paymentTooManyAttemptsException(maxAttempts: number): ConflictException {
  return new ConflictException({
    message: `Maximum number of payment attempts (${maxAttempts}) reached for this booking.`,
    i18nKey: 'payments.checkout.tooManyAttempts',
    i18nParams: { maxAttempts },
    errorCode: 'too_many_attempts',
  });
}

export function paymentNoProviderException(): ServiceUnavailableException {
  return new ServiceUnavailableException({
    message: 'No payment provider is currently available.',
    i18nKey: 'payments.checkout.noProvider',
    errorCode: 'no_provider',
  });
}

export function paymentProviderUnavailableException(): BadGatewayException {
  return new BadGatewayException({
    message: 'The payment gateway is temporarily unavailable.',
    i18nKey: 'payments.checkout.providerUnavailable',
    errorCode: 'provider_unavailable',
  });
}

export function paymentInvalidReturnUrlException(): BadRequestException {
  return new BadRequestException({
    message: 'Invalid return URL.',
    i18nKey: 'payments.checkout.invalidReturnUrl',
    errorCode: 'invalid_return_url',
  });
}

export function mockTransactionNotFoundException(): NotFoundException {
  return new NotFoundException({
    message: 'Mock payment transaction was not found.',
    i18nKey: 'payments.mock.notFound',
    errorCode: 'not_found',
  });
}
