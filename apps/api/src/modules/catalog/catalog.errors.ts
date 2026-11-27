import {
  BadRequestException,
  ConflictException,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';

export function catalogProductNotFoundException(): NotFoundException {
  return new NotFoundException({
    message: 'Product was not found.',
    i18nKey: 'catalog.product.notFound',
    errorCode: 'catalog.product.notFound',
  });
}

export function catalogSupplierNotFoundException(): UnprocessableEntityException {
  return new UnprocessableEntityException({
    message: 'Referenced supplier was not found.',
    i18nKey: 'catalog.supplier.notFound',
    errorCode: 'catalog.supplier.notFound',
  });
}

export function catalogInvalidLocaleException(locale: string): UnprocessableEntityException {
  return new UnprocessableEntityException({
    message: `Locale "${locale}" is not enabled.`,
    i18nKey: 'catalog.translation.invalidLocale',
    i18nParams: { locale },
    errorCode: 'catalog.translation.invalidLocale',
  });
}

export function catalogInvalidSlugException(): BadRequestException {
  return new BadRequestException({
    message: 'Slug must contain only lowercase letters, numbers, and hyphens.',
    i18nKey: 'catalog.translation.invalidSlug',
    errorCode: 'catalog.translation.invalidSlug',
  });
}

export function catalogSlugConflictException(locale: string, slug: string): ConflictException {
  return new ConflictException({
    message: `Slug "${slug}" is already in use for locale "${locale}".`,
    i18nKey: 'catalog.translation.slugConflict',
    i18nParams: { locale, slug },
    errorCode: 'catalog.translation.slugConflict',
  });
}

export function catalogImagesTooManyException(): UnprocessableEntityException {
  return new UnprocessableEntityException({
    message: 'A product may have at most 20 images.',
    i18nKey: 'catalog.images.tooMany',
    errorCode: 'catalog.images.tooMany',
  });
}

export function catalogImagesInvalidUrlException(): BadRequestException {
  return new BadRequestException({
    message: 'Image URLs must use HTTPS.',
    i18nKey: 'catalog.images.invalidUrl',
    errorCode: 'catalog.images.invalidUrl',
  });
}

export function catalogInvalidQueryException(reason: string): BadRequestException {
  return new BadRequestException({
    message: `Invalid catalog query parameters: ${reason}`,
    i18nKey: 'catalog.query.invalidParams',
    i18nParams: { reason },
    errorCode: 'catalog.query.invalidParams',
  });
}

export function catalogTimeZoneLockedByDeparturesException(): UnprocessableEntityException {
  return new UnprocessableEntityException({
    message: 'Product time zone cannot be changed while scheduled departures exist.',
    i18nKey: 'catalog.product.timeZoneHasDepartures',
    errorCode: 'catalog.product.timeZoneHasDepartures',
  });
}

export function catalogPublishBlockedException(params: {
  supplierSuspended: boolean;
  missingLocales: readonly string[];
  missingLocation: boolean;
  missingTimeZone: boolean;
}): UnprocessableEntityException {
  const missing: string[] = [];
  if (params.supplierSuspended) {
    missing.push('activeSupplier');
  }
  if (params.missingLocales.length > 0) {
    missing.push(...params.missingLocales.map((loc) => `translation:${loc}`));
  }
  if (params.missingLocation) {
    missing.push('location');
  }
  if (params.missingTimeZone) {
    missing.push('timeZone');
  }

  const issueGroups = [
    params.supplierSuspended,
    params.missingLocales.length > 0,
    params.missingLocation,
    params.missingTimeZone,
  ].filter(Boolean).length;

  if (issueGroups === 1) {
    if (params.supplierSuspended) {
      return new UnprocessableEntityException({
        message: 'Cannot publish product while its supplier is suspended.',
        i18nKey: 'catalog.publish.supplierSuspended',
        errorCode: 'catalog.publish.supplierSuspended',
        missing,
      });
    }
    if (params.missingLocales.length > 0) {
      const locales = params.missingLocales.join(', ');
      return new UnprocessableEntityException({
        message: `Cannot publish product: missing or incomplete required translations (${locales}).`,
        i18nKey: 'catalog.publish.missingTranslations',
        i18nParams: { locales },
        errorCode: 'catalog.publish.missingTranslations',
        missing,
      });
    }
    if (params.missingLocation) {
      return new UnprocessableEntityException({
        message: 'Cannot publish product: location coordinates are required.',
        i18nKey: 'catalog.publish.missingLocation',
        errorCode: 'catalog.publish.missingLocation',
        missing,
      });
    }
    return new UnprocessableEntityException({
      message: 'Cannot publish product: a valid IANA time zone is required.',
      i18nKey: 'catalog.publish.missingTimeZone',
      errorCode: 'catalog.publish.missingTimeZone',
      missing,
    });
  }

  const reasons = missing.join(', ');
  return new UnprocessableEntityException({
    message: `Cannot publish product: missing requirements (${reasons}).`,
    i18nKey: 'catalog.publish.blocked',
    i18nParams: { reasons },
    errorCode: 'catalog.publish.blocked',
    missing,
  });
}
