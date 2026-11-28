import { createIsolatedTestDatabase, type TestDbInstance } from '../src/test-database.ts';

export type { TestDbInstance };

export async function createTestDatabase(): Promise<TestDbInstance> {
  return createIsolatedTestDatabase();
}
