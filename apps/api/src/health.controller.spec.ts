import type { INestApplication } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from './app.module.js';
import { DRIZZLE_DB } from './database/database.module.js';

describe('HealthController (HTTP)', () => {
  let app: INestApplication;
  let baseUrl: string;

  beforeAll(async () => {
    process.env.DATABASE_URL =
      process.env.DATABASE_URL || 'postgresql://ota_user:ota_password@localhost:55432/ota_dev';

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.listen(0);
    baseUrl = await app.getUrl();
  });

  afterAll(async () => {
    await app.close();
  });

  it('GET /health returns 200 with { status: "ok" }', async () => {
    const response = await fetch(`${baseUrl}/health`);
    expect(response.status).toBe(200);

    const body = (await response.json()) as { status: string };
    expect(body).toEqual({ status: 'ok' });
  });

  it('GET /health/ready returns 200 with { status: "ok", database: "connected" } when DB is up', async () => {
    const response = await fetch(`${baseUrl}/health/ready`);
    expect(response.status).toBe(200);

    const body = (await response.json()) as { status: string; database: string };
    expect(body).toEqual({ status: 'ok', database: 'connected' });
  });

  it('GET /health/ready returns 503 when database query fails', async () => {
    // Create a standalone app where DRIZZLE_DB throws on execute
    const mockDb = {
      execute: () => Promise.reject(new Error('Database connection failed')),
    };

    const failingFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(DRIZZLE_DB)
      .useValue(mockDb)
      .compile();

    const failingApp = failingFixture.createNestApplication();
    await failingApp.listen(0);
    const failingUrl = await failingApp.getUrl();

    try {
      const response = await fetch(`${failingUrl}/health/ready`);
      expect(response.status).toBe(503);

      const body = (await response.json()) as {
        status: string;
        database: string;
      };
      expect(body).toEqual({ status: 'error', database: 'disconnected' });
    } finally {
      await failingApp.close();
    }
  });
});
