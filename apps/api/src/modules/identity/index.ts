export { AuthGuard } from './auth.guard.js';
export { CurrentPrincipal } from './current-principal.decorator.js';
export { EMAIL_SENDER, type EmailSender, LogOnlyEmailSender } from './email-sender.interface.js';
export { IdentityModule } from './identity.module.js';
export { IdentityService } from './identity.service.js';
export {
  type AuthenticatedRequest,
  derivePrincipalKind,
  type Principal,
  type PrincipalKind,
  type Role,
} from './identity.types.js';
export { Roles, ROLES_METADATA_KEY } from './roles.decorator.js';
export { RolesGuard } from './roles.guard.js';
