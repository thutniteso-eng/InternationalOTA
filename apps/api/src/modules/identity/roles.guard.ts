import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { AuthenticatedRequest, Role } from './identity.types.js';
import { ROLES_METADATA_KEY } from './roles.decorator.js';

/**
 * Guard that verifies the authenticated principal holds at least one of the
 * roles declared via `@Roles(...)`. Returns 403 problem+json on failure.
 */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const requiredRoles = this.reflector.getAllAndOverride<Role[]>(ROLES_METADATA_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (!requiredRoles || requiredRoles.length === 0) {
      return true;
    }

    const req = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const principal = req.principal;

    if (!principal) {
      throw new ForbiddenException({
        message: 'Insufficient role permissions',
        i18nKey: 'http.403.insufficientRole',
      });
    }

    const hasRole = requiredRoles.some((role) => principal.roles.includes(role));
    if (!hasRole) {
      throw new ForbiddenException({
        message: 'Insufficient role permissions',
        i18nKey: 'http.403.insufficientRole',
      });
    }

    return true;
  }
}
