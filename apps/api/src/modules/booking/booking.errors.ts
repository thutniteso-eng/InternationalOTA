import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import type { PublicQuoteResponse } from '../pricing/index.js';

export function bookingValidationException(reason: string): UnprocessableEntityException {
  return new UnprocessableEntityException({
    message: `Invalid booking payload: ${reason}.`,
    i18nKey: 'booking.validation.invalidPayload',
    i18nParams: { reason },
    errorCode: 'booking_validation_error',
  });
}

export function bookingInvalidQueryException(reason: string): BadRequestException {
  return new BadRequestException({
    message: `Invalid booking query parameters: ${reason}.`,
    i18nKey: 'booking.query.invalidParams',
    i18nParams: { reason },
    errorCode: 'booking_invalid_query',
  });
}

export function bookingNotFoundException(): NotFoundException {
  return new NotFoundException({
    message: 'Booking was not found.',
    i18nKey: 'booking.hold.notFound',
    errorCode: 'not_found',
  });
}

export function bookingDepartureNotFoundException(): NotFoundException {
  return new NotFoundException({
    message: 'Departure was not found.',
    i18nKey: 'pricing.quote.departureNotFound',
    errorCode: 'not_found',
  });
}

export function bookingPriceChangedException(quote: PublicQuoteResponse): ConflictException {
  return new ConflictException({
    message: 'Tour price or policy changed since your quote; please review the updated quote.',
    i18nKey: 'booking.hold.priceChanged',
    errorCode: 'price_changed',
    quote,
  });
}

export function bookingSoldOutException(): ConflictException {
  return new ConflictException({
    message: 'Not enough seats remaining for this departure.',
    i18nKey: 'booking.hold.soldOut',
    errorCode: 'sold_out',
  });
}

export function bookingTooManyActiveHoldsException(maxHolds: number): ConflictException {
  return new ConflictException({
    message: `Maximum active holds limit (${maxHolds}) reached for this customer.`,
    i18nKey: 'booking.hold.tooManyActiveHolds',
    i18nParams: { maxHolds },
    errorCode: 'too_many_active_holds',
  });
}

export function bookingDepartureClosedException(): UnprocessableEntityException {
  return new UnprocessableEntityException({
    message: 'This departure is closed or cancelled.',
    i18nKey: 'booking.hold.closed',
    errorCode: 'closed',
  });
}

export function bookingCutoffPassedException(): UnprocessableEntityException {
  return new UnprocessableEntityException({
    message: 'Booking cutoff time has already passed for this departure.',
    i18nKey: 'booking.hold.cutoffPassed',
    errorCode: 'cutoff_passed',
  });
}

export function bookingEmailNotVerifiedException(): ForbiddenException {
  return new ForbiddenException({
    message: 'A verified email address is required before proceeding to payment.',
    i18nKey: 'booking.hold.emailNotVerified',
    errorCode: 'email_not_verified',
  });
}

export function bookingConflictException(): ConflictException {
  return new ConflictException({
    message: 'Booking state conflicts with the requested operation.',
    i18nKey: 'booking.hold.conflict',
    errorCode: 'conflict',
  });
}

export function bookingNotCancellableException(): ConflictException {
  return new ConflictException({
    message: 'Booking cannot be cancelled before payment in its current status.',
    i18nKey: 'booking.hold.notCancellable',
    errorCode: 'not_cancellable',
  });
}

export function bookingTooLateToCancelException(): ConflictException {
  return new ConflictException({
    message: 'This booking can no longer be cancelled because the departure has already started.',
    i18nKey: 'booking.hold.tooLateToCancel',
    errorCode: 'too_late_to_cancel',
  });
}
