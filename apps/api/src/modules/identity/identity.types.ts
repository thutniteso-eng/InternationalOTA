import type { IdentityRole } from '@internationalota/db';
import type { Request } from 'express';

export type Role = IdentityRole;

export type PrincipalKind = 'customer' | 'staff' | 'partner';

export interface Principal {
  userId: string;
  kind: PrincipalKind;
  roles: Role[];
}

export interface AuthenticatedRequest extends Request {
  principal?: Principal;
}

export function derivePrincipalKind(roles: readonly Role[]): PrincipalKind {
  if (roles.includes('admin') || roles.includes('operator')) {
    return 'staff';
  }
  if (roles.includes('partner_admin') || roles.includes('partner_staff')) {
    return 'partner';
  }
  return 'customer';
}
