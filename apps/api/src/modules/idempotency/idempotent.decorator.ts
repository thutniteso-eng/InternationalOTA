import { SetMetadata } from '@nestjs/common';

export const IDEMPOTENT_METADATA_KEY = 'IDEMPOTENT_METADATA_KEY';

/**
 * Decorator to enforce idempotency on route handlers via Idempotency-Key header.
 */
export const Idempotent = (): MethodDecorator => SetMetadata(IDEMPOTENT_METADATA_KEY, true);
