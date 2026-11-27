import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module.js';
import { CatalogService } from '../modules/catalog/index.js';
import { InventoryService } from '../modules/inventory/index.js';
import { PricingService } from '../modules/pricing/index.js';
import { SupplyService } from '../modules/supply/index.js';
import { assertDemoEnvAllowed, resolveDemoCatalogPath, runDemoLoader } from './demo-loader.js';

async function main(): Promise<void> {
  assertDemoEnvAllowed();

  if (process.env['PG_BOSS_DISABLED'] === undefined) {
    process.env['PG_BOSS_DISABLED'] = 'true';
  }

  const explicitPath = process.argv[2];
  const catalogPath = resolveDemoCatalogPath(explicitPath);

  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn'],
  });

  try {
    const result = await runDemoLoader(
      {
        supplyService: app.get(SupplyService),
        catalogService: app.get(CatalogService),
        inventoryService: app.get(InventoryService),
        pricingService: app.get(PricingService),
      },
      { catalogPath },
    );

    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } finally {
    await app.close();
  }
}

void main().catch((err: unknown) => {
  process.stderr.write(`demo:load failed: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
