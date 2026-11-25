import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { AuthenticatedRequest, Principal } from './identity.types.js';

/**
 * Extracts the authenticated `Principal` attached to the request by `AuthGuard`.
 */
export const CurrentPrincipal = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): Principal | undefined => {
    const req = ctx.switchToHttp().getRequest<AuthenticatedRequest>();
    return req.principal;
  },
);
