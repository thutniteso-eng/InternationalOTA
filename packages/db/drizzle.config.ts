import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/schema/index.ts',
  out: './migrations',
  dbCredentials: {
    url: process.env.DATABASE_URL || 'postgresql://ota_user:ota_password@localhost:55432/ota_dev',
  },
});
