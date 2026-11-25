import { SetMetadata } from '@nestjs/common';
import type { Role } from './identity.types.js';

export const ROLES_METADATA_KEY = 'identity_required_roles';

/**
 * Declares the roles permitted to access a controller or route handler.
 * Enforced by `RolesGuard`.
 */
export const Roles = (...roles: Role[]) => SetMetadata(ROLES_METADATA_KEY, roles);
