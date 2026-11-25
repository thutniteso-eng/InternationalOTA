import {
  type CanActivate,
  type ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { IdentityService } from './identity.service.js';
import type { AuthenticatedRequest } from './identity.types.js';

/**
 * Guard that requires a valid authenticated session and attaches `req.principal`.
 * Returns 401 RFC 9457 problem+json when no valid session is present.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private readonly identityService: IdentityService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const principal = await this.identityService.resolvePrincipal(req.headers);

    if (!principal) {
      throw new UnauthorizedException({
        message: 'Authentication required',
        i18nKey: 'http.401.authRequired',
      });
    }

    req.principal = principal;
    return true;
  }
}
