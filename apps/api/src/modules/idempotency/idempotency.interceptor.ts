import { type DatabaseClient, idempotencyKeys, type IdempotencyKey } from '@internationalota/db';
import {
  BadRequestException,
  type CallHandler,
  ConflictException,
  type ExecutionContext,
  Inject,
  Injectable,
  type NestInterceptor,
  UnprocessableEntityException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { and, eq, sql } from 'drizzle-orm';
import type { Request, Response } from 'express';
import { type Observable, of } from 'rxjs';
import { catchError, switchMap } from 'rxjs/operators';
import { DRIZZLE_DB } from '../../database/database.module.js';
import { computeRequestHash, computeScope, isValidIdempotencyKey } from './hash.js';
import { IDEMPOTENT_METADATA_KEY } from './idempotent.decorator.js';

type ConflictDecision =
  | { action: 'execute' }
  | { action: 'error_422' }
  | { action: 'error_409' }
  | { action: 'replay'; status: number; body: unknown };

/**
 * Interceptor implementing the IETF HTTPAPI Idempotency-Key specification.
 *
 * Prevents double-execution of mutating operations across concurrent and retry requests.
 */
@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  constructor(
    @Inject(DRIZZLE_DB) private readonly db: DatabaseClient,
    private readonly reflector: Reflector,
  ) {}

  async intercept(context: ExecutionContext, next: CallHandler): Promise<Observable<unknown>> {
    const isIdempotent = this.reflector.getAllAndOverride<boolean>(IDEMPOTENT_METADATA_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (!isIdempotent) {
      return next.handle();
    }

    const http = context.switchToHttp();
    const req = http.getRequest<Request>();
    const res = http.getResponse<Response>();

    // 1. Validate Idempotency-Key header: 1-255 printable ASCII characters without spaces
    const rawKey = req.headers['idempotency-key'];
    if (!isValidIdempotencyKey(rawKey)) {
      throw new BadRequestException(
        'Idempotency-Key header is required and must be 1-255 printable ASCII characters without spaces',
      );
    }
    const key = rawKey;

    const scope = computeScope(req);
    const requestHash = computeRequestHash(scope, req.body);

    // Step 1: Attempt initial insert
    const [inserted] = await this.db
      .insert(idempotencyKeys)
      .values({
        scope,
        key,
        requestHash,
        state: 'in_progress',
        lockedUntil: sql`now() + interval '60 seconds'`,
        expiresAt: sql`now() + interval '24 hours'`,
      })
      .onConflictDoNothing()
      .returning();

    if (!inserted) {
      // Step 2: Key already exists -> lock row FOR UPDATE in a transaction and resolve conflict
      const decision = await this.resolveConflict(scope, key, requestHash);

      if (decision.action === 'error_422') {
        throw new UnprocessableEntityException(
          'Idempotency key was previously used with a different request payload',
        );
      }

      if (decision.action === 'error_409') {
        res.setHeader('Retry-After', '1');
        throw new ConflictException('A request with this idempotency key is currently in progress');
      }

      if (decision.action === 'replay') {
        res.setHeader('Idempotent-Replayed', 'true');
        res.status(decision.status);
        return of(decision.body);
      }
    }

    // Step 3: Run handler and store response or clean up on failure
    return next.handle().pipe(
      switchMap(async (responseBody: unknown) => {
        const statusCode = res.statusCode || 200;
        if (statusCode < 500) {
          await this.db
            .update(idempotencyKeys)
            .set({
              responseStatus: statusCode,
              responseBody: responseBody !== undefined ? responseBody : null,
              state: 'completed',
              updatedAt: sql`now()`,
            })
            .where(and(eq(idempotencyKeys.scope, scope), eq(idempotencyKeys.key, key)));
        } else {
          await this.db
            .delete(idempotencyKeys)
            .where(and(eq(idempotencyKeys.scope, scope), eq(idempotencyKeys.key, key)));
        }
        return responseBody;
      }),
      catchError(async (err: unknown) => {
        await this.db
          .delete(idempotencyKeys)
          .where(and(eq(idempotencyKeys.scope, scope), eq(idempotencyKeys.key, key)));
        throw err;
      }),
    );
  }

  private async resolveConflict(
    scope: string,
    key: string,
    requestHash: string,
  ): Promise<ConflictDecision> {
    return await this.db.transaction(async (tx) => {
      const [existing] = await tx
        .select()
        .from(idempotencyKeys)
        .where(and(eq(idempotencyKeys.scope, scope), eq(idempotencyKeys.key, key)))
        .for('update');

      if (!existing) {
        // Row was deleted between initial insert and select for update (e.g. failed attempt was cleared)
        const [reinserted] = await tx
          .insert(idempotencyKeys)
          .values({
            scope,
            key,
            requestHash,
            state: 'in_progress',
            lockedUntil: sql`now() + interval '60 seconds'`,
            expiresAt: sql`now() + interval '24 hours'`,
          })
          .onConflictDoNothing()
          .returning();

        if (reinserted) {
          return { action: 'execute' };
        }

        const [retryRow] = await tx
          .select()
          .from(idempotencyKeys)
          .where(and(eq(idempotencyKeys.scope, scope), eq(idempotencyKeys.key, key)))
          .for('update');

        if (!retryRow) {
          return { action: 'execute' };
        }
        return this.evaluateRow(retryRow, requestHash, scope, key, tx);
      }

      return this.evaluateRow(existing, requestHash, scope, key, tx);
    });
  }

  private async evaluateRow(
    existing: IdempotencyKey,
    requestHash: string,
    scope: string,
    key: string,
    tx: DatabaseClient,
  ): Promise<ConflictDecision> {
    const now = new Date();
    const isExpired = existing.expiresAt < now;
    const isStaleInProgress = existing.state === 'in_progress' && existing.lockedUntil < now;

    if (isExpired || isStaleInProgress) {
      // Take over: reset row to in_progress with new hash/lock, run handler
      await tx
        .update(idempotencyKeys)
        .set({
          requestHash,
          state: 'in_progress',
          responseStatus: null,
          responseBody: null,
          lockedUntil: sql`now() + interval '60 seconds'`,
          expiresAt: sql`now() + interval '24 hours'`,
          updatedAt: sql`now()`,
        })
        .where(and(eq(idempotencyKeys.scope, scope), eq(idempotencyKeys.key, key)));

      return { action: 'execute' };
    }

    if (existing.requestHash !== requestHash) {
      return { action: 'error_422' };
    }

    if (existing.state === 'in_progress') {
      return { action: 'error_409' };
    }

    if (existing.state === 'completed') {
      return {
        action: 'replay',
        status: existing.responseStatus ?? 200,
        body: existing.responseBody,
      };
    }

    return { action: 'error_409' };
  }
}
