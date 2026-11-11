import { createDbClient, type DatabaseClient } from '@internationalota/db';
import { Global, Inject, Module, type OnApplicationShutdown } from '@nestjs/common';
import pg from 'pg';

export const DRIZZLE_DB = 'DRIZZLE_DB';
export const DATABASE_POOL = 'DATABASE_POOL';

@Global()
@Module({
  providers: [
    {
      provide: DATABASE_POOL,
      useFactory: () => {
        const { pool } = createDbClient();
        return pool;
      },
    },
    {
      provide: DRIZZLE_DB,
      useFactory: (pool: pg.Pool): DatabaseClient => {
        const { db } = createDbClient({ pool });
        return db;
      },
      inject: [DATABASE_POOL],
    },
  ],
  exports: [DRIZZLE_DB, DATABASE_POOL],
})
export class DatabaseModule implements OnApplicationShutdown {
  constructor(@Inject(DATABASE_POOL) private readonly pool: pg.Pool) {}

  async onApplicationShutdown(): Promise<void> {
    await this.pool.end();
  }
}
