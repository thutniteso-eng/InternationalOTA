import {
  BadRequestException,
  ConflictException,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';

export function inventoryDepartureNotFoundException(): NotFoundException {
  return new NotFoundException({
    message: 'Departure was not found.',
    i18nKey: 'inventory.departure.notFound',
    errorCode: 'inventory.departure.notFound',
  });
}

export function inventoryCapacityBelowAllocatedException(
  capacity: number,
  allocated: number,
): UnprocessableEntityException {
  return new UnprocessableEntityException({
    message: `Departure capacity (${capacity}) cannot be reduced below currently allocated seats (${allocated}).`,
    i18nKey: 'inventory.departure.capacityBelowAllocated',
    i18nParams: { capacity, allocated },
    errorCode: 'inventory.departure.capacityBelowAllocated',
  });
}

export function inventoryNonExistentLocalTimeException(
  localDate: string,
  localTime: string,
  timeZone: string,
): UnprocessableEntityException {
  return new UnprocessableEntityException({
    message: `Local departure time ${localDate} ${localTime} does not exist in time zone ${timeZone} due to daylight saving time transition.`,
    i18nKey: 'inventory.departure.nonExistentLocalTime',
    i18nParams: { localDate, localTime, timeZone },
    errorCode: 'inventory.departure.nonExistentLocalTime',
  });
}

export function inventoryDepartureAlreadyCancelledException(): UnprocessableEntityException {
  return new UnprocessableEntityException({
    message: 'Cancelled departures cannot be reopened.',
    i18nKey: 'inventory.departure.alreadyCancelled',
    errorCode: 'inventory.departure.alreadyCancelled',
  });
}

export function inventoryUnsupportedProductKindException(
  kind: string,
): UnprocessableEntityException {
  return new UnprocessableEntityException({
    message: `Dated departures are supported only for tour and activity products (got "${kind}").`,
    i18nKey: 'inventory.product.unsupportedKind',
    i18nParams: { kind },
    errorCode: 'inventory.product.unsupportedKind',
  });
}

export function inventoryAllocationQuantityConflictException(
  existingQuantity: number,
  requestedQuantity: number,
): ConflictException {
  return new ConflictException({
    message: `Allocation reference is already active with a different quantity (${existingQuantity} vs ${requestedQuantity}).`,
    i18nKey: 'inventory.allocation.quantityConflict',
    i18nParams: { existingQuantity, requestedQuantity },
    errorCode: 'inventory.allocation.quantityConflict',
  });
}

export function inventoryAllocationAlreadyReleasedException(): ConflictException {
  return new ConflictException({
    message: 'Allocation reference has already been released and cannot be reused.',
    i18nKey: 'inventory.allocation.alreadyReleased',
    errorCode: 'inventory.allocation.alreadyReleased',
  });
}

export function inventoryInvalidQueryException(reason: string): BadRequestException {
  return new BadRequestException({
    message: `Invalid inventory query parameters: ${reason}`,
    i18nKey: 'inventory.query.invalidParams',
    i18nParams: { reason },
    errorCode: 'inventory.query.invalidParams',
  });
}
