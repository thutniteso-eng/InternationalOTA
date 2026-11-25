import type { INestApplication } from '@nestjs/common';
import type { Express, NextFunction, Request, Response } from 'express';
import { IdentityService } from './modules/identity/index.js';

/**
 * Configures the NestJS Express application:
 * 1. Mounts Better Auth on `/api/auth/*` before any body parser consumes the stream.
 * 2. Mounts a raw-body Buffer collector on `/webhooks/*` so webhook HMAC signature
 *    verification runs against the exact raw bytes before JSON parsing.
 * 3. Re-enables NestJS's built-in JSON and URL-encoded body parsers for all other routes.
 *
 * Callers MUST create the Nest application with `{ bodyParser: false }`.
 */
export function configureApp(app: INestApplication): void {
  const httpAdapter = app.getHttpAdapter();
  const expressApp = httpAdapter.getInstance() as Express;
  const identityService = app.get(IdentityService);

  // 1. Better Auth receives the raw unparsed request stream (Express 5 wildcard syntax)
  expressApp.all('/api/auth/{*splat}', identityService.getAuthHandler());

  // 2. Webhook routes receive exact raw bytes as Buffer before global JSON parsing
  expressApp.use('/webhooks', (req: Request, _res: Response, next: NextFunction) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer | string) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    req.on('end', () => {
      req.body = Buffer.concat(chunks);
      (req as Request & { _body?: boolean })._body = true;
      next();
    });
    req.on('error', next);
  });

  // 3. Re-enable NestJS's built-in body parsers for all remaining routes
  httpAdapter.registerParserMiddleware();
}
