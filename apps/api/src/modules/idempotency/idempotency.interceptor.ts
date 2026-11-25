import { and, type DatabaseClient, eq, idempotencyKeys, sql } from '@internationalota/db';
import {
  BadRequestException,
  type CallHandler,
  ConflictException,
  type ExecutionContext,
  Inject,
  Injectable,
  Logger,
  type NestInterceptor,
  UnprocessableEntityException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request, Response } from 'express';
import { type Observable, of } from 'rxjs';
import { catchError, switchMap } from 'rxjs/operators';
import { DRIZZLE_DB } from '../../database/database.module.js';
import { computeRequestHash, computeScope, isValidIdempotencyKey } from './hash.js';
import { IDEMPOTENT_METADATA_KEY } from './idempotent.decorator.js';

interface EvaluatedRow {
  scope: string;
  key: string;
  requestHash: string;
  state: string;
  responseStatus: number | null;
  responseBody: unknown;
  lockedUntilText: string;
  isExpired: boolean;
  isStale: boolean;
}

type ConflictDecision =
  | { action: 'execute'; lockedUntilText: string }
  | { action: 'error_422' }
  | { action: 'error_409' }
  | { action: 'replay'; status: number; body: unknown };

/**
 * Interceptor implementing the IETF HTTPAPI Idempotency-Key specification.
 *
 * Prevents double-execution of mutating operations across concurrent and retry requests.
 *
 * Handlers decorated with `@Idempotent()` MUST finish well within the 60-second lock window.
 * If an execution exceeds the lock window and is taken over by a newer request, completion
 * fencing ensures the stale execution will not overwrite the newer execution's stored result.
 */
@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  private readonly logger = new Logger(IdempotencyInterceptor.name);

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
      .returning({
        lockedUntilText: sql<string>`${idempotencyKeys.lockedUntil}::text`,
      });

    let ownedLockedUntilText: string;

    if (inserted) {
      ownedLockedUntilText = inserted.lockedUntilText;
    } else {
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

      ownedLockedUntilText = decision.lockedUntilText;
    }

    const ownershipWhere = and(
      eq(idempotencyKeys.scope, scope),
      eq(idempotencyKeys.key, key),
      eq(idempotencyKeys.state, 'in_progress'),
      eq(idempotencyKeys.requestHash, requestHash),
      sql`${idempotencyKeys.lockedUntil} = ${ownedLockedUntilText}::timestamptz`,
    );

    // Step 3: Run handler and store response or clean up on failure (fenced by ownership)
    return next.handle().pipe(
      switchMap(async (responseBody: unknown) => {
        const statusCode = res.statusCode || 200;
        if (statusCode < 500) {
          const updated = await this.db
            .update(idempotencyKeys)
            .set({
              responseStatus: statusCode,
              responseBody: responseBody !== undefined ? responseBody : null,
              state: 'completed',
              updatedAt: sql`now()`,
            })
            .where(ownershipWhere)
            .returning({ key: idempotencyKeys.key });

          if (updated.length === 0) {
            this.logger.warn(
              JSON.stringify({
                level: 'warn',
                event: 'idempotency_fencing_lost',
                scope,
                key,
              }),
            );
          }
        } else {
          const deleted = await this.db
            .delete(idempotencyKeys)
            .where(ownershipWhere)
            .returning({ key: idempotencyKeys.key });

          if (deleted.length === 0) {
            this.logger.warn(
              JSON.stringify({
                level: 'warn',
                event: 'idempotency_fencing_lost_on_5xx',
                scope,
                key,
              }),
            );
          }
        }
        return responseBody;
      }),
      catchError(async (err: unknown) => {
        const deleted = await this.db
          .delete(idempotencyKeys)
          .where(ownershipWhere)
          .returning({ key: idempotencyKeys.key });

        if (deleted.length === 0) {
          this.logger.warn(
            JSON.stringify({
              level: 'warn',
              event: 'idempotency_fencing_lost_on_error',
              scope,
              key,
            }),
          );
        }
        throw err;
      }),
    );
  }

  private async selectForUpdate(
    tx: DatabaseClient,
    scope: string,
    key: string,
  ): Promise<EvaluatedRow | undefined> {
    const [row] = await tx
      .select({
        scope: idempotencyKeys.scope,
        key: idempotencyKeys.key,
        requestHash: idempotencyKeys.requestHash,
        state: idempotencyKeys.state,
        responseStatus: idempotencyKeys.responseStatus,
        responseBody: idempotencyKeys.responseBody,
        lockedUntilText: sql<string>`${idempotencyKeys.lockedUntil}::text`,
        isExpired: sql<boolean>`${idempotencyKeys.expiresAt} < now()`,
        isStale: sql<boolean>`${idempotencyKeys.lockedUntil} < now()`,
      })
      .from(idempotencyKeys)
      .where(and(eq(idempotencyKeys.scope, scope), eq(idempotencyKeys.key, key)))
      .for('update');

    return row;
  }

  private async resolveConflict(
    scope: string,
    key: string,
    requestHash: string,
  ): Promise<ConflictDecision> {
    return await this.db.transaction(async (tx) => {
      const existing = await this.selectForUpdate(tx, scope, key);

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
          .returning({
            lockedUntilText: sql<string>`${idempotencyKeys.lockedUntil}::text`,
          });

        if (reinserted) {
          return { action: 'execute', lockedUntilText: reinserted.lockedUntilText };
        }

        const retryRow = await this.selectForUpdate(tx, scope, key);
        if (!retryRow) {
          return { action: 'error_409' };
        }
        return this.evaluateRow(retryRow, requestHash, scope, key, tx);
      }

      return this.evaluateRow(existing, requestHash, scope, key, tx);
    });
  }

  private async evaluateRow(
    existing: EvaluatedRow,
    requestHash: string,
    scope: string,
    key: string,
    tx: DatabaseClient,
  ): Promise<ConflictDecision> {
    const isExpired = existing.isExpired;
    const isStaleInProgress = existing.state === 'in_progress' && existing.isStale;

    if (isExpired || isStaleInProgress) {
      // Take over: reset row to in_progress with new hash/lock, run handler
      const [takenOver] = await tx
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
        .where(and(eq(idempotencyKeys.scope, scope), eq(idempotencyKeys.key, key)))
        .returning({
          lockedUntilText: sql<string>`${idempotencyKeys.lockedUntil}::text`,
        });

      if (!takenOver) {
        return { action: 'error_409' };
      }

      return { action: 'execute', lockedUntilText: takenOver.lockedUntilText };
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
