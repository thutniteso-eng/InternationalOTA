import { Controller, ForbiddenException, Get, Param, Post, UseGuards } from '@nestjs/common';
import { Idempotent } from '../idempotency/index.js';
import { AuthGuard } from './auth.guard.js';
import { CurrentPrincipal } from './current-principal.decorator.js';
import type { Principal } from './identity.types.js';
import { Roles } from './roles.decorator.js';
import { RolesGuard } from './roles.guard.js';

/**
 * Test-only controller registered when NODE_ENV === 'test'.
 * Exercises AuthGuard, CurrentPrincipal, RolesGuard, cross-account isolation,
 * and principal-scoped idempotency keys.
 */
@Controller('__test')
export class TestIdentityController {
  @Get('me')
  @UseGuards(AuthGuard)
  getMe(@CurrentPrincipal() principal: Principal): Principal {
    return principal;
  }

  @Get('admin-only')
  @UseGuards(AuthGuard, RolesGuard)
  @Roles('admin')
  getAdminOnly(@CurrentPrincipal() principal: Principal): { ok: true; userId: string } {
    return { ok: true, userId: principal.userId };
  }

  @Get('users/:id/private')
  @UseGuards(AuthGuard)
  getUserPrivate(
    @Param('id') id: string,
    @CurrentPrincipal() principal: Principal,
  ): { userId: string; secret: string } {
    if (principal.userId !== id) {
      throw new ForbiddenException('Cannot access another user resource');
    }
    return { userId: id, secret: `private-data-for-${id}` };
  }

  @Post('idempotent-auth')
  @UseGuards(AuthGuard)
  @Idempotent()
  postIdempotentAuth(@CurrentPrincipal() principal: Principal): {
    userId: string;
    ok: true;
  } {
    return { userId: principal.userId, ok: true };
  }
}
