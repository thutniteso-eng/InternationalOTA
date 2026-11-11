import { Controller, Get, HttpException, HttpStatus, Inject } from '@nestjs/common';
import type { DatabaseClient } from '@internationalota/db';
import { sql } from 'drizzle-orm';
import { DRIZZLE_DB } from './database/database.module.js';

export interface HealthStatusResponse {
  status: 'ok';
}

export interface ReadyStatusResponse {
  status: 'ok';
  database: 'connected';
}

@Controller('health')
export class HealthController {
  constructor(@Inject(DRIZZLE_DB) private readonly db: DatabaseClient) {}

  @Get()
  getHealth(): HealthStatusResponse {
    return { status: 'ok' };
  }

  @Get('ready')
  async getReady(): Promise<ReadyStatusResponse> {
    try {
      await this.db.execute(sql`SELECT 1`);
      return { status: 'ok', database: 'connected' };
    } catch {
      throw new HttpException(
        { status: 'error', database: 'disconnected' },
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
  }
}
