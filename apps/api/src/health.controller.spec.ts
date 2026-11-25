import type { INestApplication } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDbInstance } from '../test/test-db.js';
import { AppModule } from './app.module.js';
import { configureApp } from './app.setup.js';
import { DRIZZLE_DB } from './database/database.module.js';

const TEST_AUTH_SECRET = 'test-better-auth-secret-key-at-least-32-chars';

describe('HealthController (HTTP)', () => {
  let app: INestApplication;
  let baseUrl: string;
  let testDb: TestDbInstance;
  let previousDatabaseUrl: string | undefined;
  let previousAuthSecret: string | undefined;

  beforeAll(async () => {
    previousDatabaseUrl = process.env['DATABASE_URL'];
    previousAuthSecret = process.env['BETTER_AUTH_SECRET'];
    process.env['BETTER_AUTH_SECRET'] = TEST_AUTH_SECRET;

    testDb = await createTestDatabase();
    process.env['DATABASE_URL'] = testDb.testUrl;

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication({ bodyParser: false });
    configureApp(app);
    await app.listen(0);
    baseUrl = await app.getUrl();
  });

  afterAll(async () => {
    if (app) {
      await app.close();
    }
    if (previousDatabaseUrl === undefined) {
      delete process.env['DATABASE_URL'];
    } else {
      process.env['DATABASE_URL'] = previousDatabaseUrl;
    }
    if (previousAuthSecret === undefined) {
      delete process.env['BETTER_AUTH_SECRET'];
    } else {
      process.env['BETTER_AUTH_SECRET'] = previousAuthSecret;
    }
    if (testDb) {
      await testDb.teardown();
    }
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

  it('GET /health/ready returns 503 problem+json when database query fails', async () => {
    const mockDb = {
      execute: () => Promise.reject(new Error('Database connection failed')),
    };

    const failingFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(DRIZZLE_DB)
      .useValue(mockDb)
      .compile();

    const failingApp = failingFixture.createNestApplication({ bodyParser: false });
    configureApp(failingApp);
    await failingApp.listen(0);
    const failingUrl = await failingApp.getUrl();

    try {
      const response = await fetch(`${failingUrl}/health/ready`, {
        headers: { 'Accept-Language': 'en' },
      });
      expect(response.status).toBe(503);
      expect(response.headers.get('Content-Type')).toContain('application/problem+json');

      const body = (await response.json()) as {
        type: string;
        title: string;
        status: number;
        detail: string;
        requestId?: string;
      };
      expect(body.requestId).toBeTruthy();
      expect({
        type: body.type,
        title: body.title,
        status: body.status,
        detail: body.detail,
      }).toEqual({
        type: 'https://httpstatuses.com/503',
        title: 'Service Unavailable',
        status: 503,
        detail: 'An unexpected internal error occurred',
      });
    } finally {
      await failingApp.close();
    }
  });
});
