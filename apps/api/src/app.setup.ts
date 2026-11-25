import type { INestApplication } from '@nestjs/common';
import type { Express } from 'express';
import { IdentityService } from './modules/identity/index.js';

/**
 * Configures the NestJS Express application so that Better Auth receives
 * the raw, unparsed request stream on `/api/auth/*`, while all other routes
 * use NestJS's built-in JSON and URL-encoded body parsers.
 *
 * Callers MUST create the Nest application with `{ bodyParser: false }`.
 */
export function configureApp(app: INestApplication): void {
  const httpAdapter = app.getHttpAdapter();
  const expressApp = httpAdapter.getInstance() as Express;
  const identityService = app.get(IdentityService);

  // Express 5 syntax for wildcard subpaths (matches /api/auth and /api/auth/...)
  expressApp.all('/api/auth/{*splat}', identityService.getAuthHandler());

  // Re-enable NestJS's built-in body parsers for all non-auth routes
  httpAdapter.registerParserMiddleware();
}
