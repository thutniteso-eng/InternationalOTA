import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { createDbClient, type DatabaseClient, sql } from '@internationalota/db';
import { resolveAppEnv } from '@internationalota/shared';
import { type DemoCatalogJson, resolveDemoCatalogPath } from './demo-loader.js';

export interface StagingCleanupResult {
  readonly appEnv: string;
  readonly archivedProductsCount: number;
  readonly archivedProductSlugs: readonly string[];
  readonly suspendedSuppliersCount: number;
  readonly remainingPublicProductsCount: number;
}

export function assertStagingCleanupEnvAllowed(): 'staging' {
  const appEnv = resolveAppEnv();
  if (appEnv === 'production') {
    throw new Error('Refusing to run staging cleanup in production (APP_ENV=production).');
  }
  if (appEnv !== 'staging') {
    throw new Error(
      `staging:cleanup-test-data requires APP_ENV=staging (got APP_ENV="${appEnv}").`,
    );
  }
  return appEnv;
}

/**
 * Archives non-demo test products on staging (without ever deleting bookings,
 * payments, or ledger rows) and suspends non-demo test suppliers that own no
 * remaining non-archived products.
 */
export async function runStagingCleanupTestData(
  db: DatabaseClient,
  catalogPath = resolveDemoCatalogPath(),
): Promise<StagingCleanupResult> {
  const appEnv = assertStagingCleanupEnvAllowed();

  const raw = await readFile(catalogPath, 'utf8');
  const catalog = JSON.parse(raw) as DemoCatalogJson;

  const canonicalSlugs = new Set<string>();
  for (const product of catalog.products) {
    if (product.translations.vi?.slug) {
      canonicalSlugs.add(product.translations.vi.slug);
    }
    if (product.translations.en?.slug) {
      canonicalSlugs.add(product.translations.en.slug);
    }
  }
  const canonicalSuppliers = new Set(catalog.suppliers.map((s) => s.name));

  const productRowsRes = await db.execute(sql`
    SELECT
      p.id AS "id",
      p.status AS "status",
      p.supplier_id AS "supplierId",
      s.name AS "supplierName",
      COALESCE(
        array_agg(pt.slug) FILTER (WHERE pt.slug IS NOT NULL),
        ARRAY[]::text[]
      ) AS "slugs"
    FROM catalog.products p
    INNER JOIN supply.suppliers s ON s.id = p.supplier_id
    LEFT JOIN catalog.product_translations pt ON pt.product_id = p.id
    GROUP BY p.id, p.status, p.supplier_id, s.name
  `);

  const archivedIds: string[] = [];
  const archivedSlugs: string[] = [];
  const touchedSupplierIds = new Set<string>();

  for (const row of productRowsRes.rows as Array<{
    id: string;
    status: string;
    supplierId: string;
    supplierName: string;
    slugs: string[];
  }>) {
    const slugs = Array.isArray(row.slugs) ? row.slugs : [];
    const isCanonicalDemo = slugs.some((slug) => canonicalSlugs.has(slug));
    if (!isCanonicalDemo && row.status !== 'archived') {
      archivedIds.push(row.id);
      archivedSlugs.push(slugs[0] ?? row.id);
      if (!canonicalSuppliers.has(row.supplierName)) {
        touchedSupplierIds.add(row.supplierId);
      }
    }
  }

  for (const id of archivedIds) {
    await db.execute(sql`
      UPDATE catalog.products
      SET status = 'archived', updated_at = now()
      WHERE id = ${id}::uuid AND status <> 'archived'
    `);
  }

  let suspendedSuppliersCount = 0;
  for (const supplierId of touchedSupplierIds) {
    const remainingRes = await db.execute(sql`
      SELECT COUNT(*)::int AS "cnt"
      FROM catalog.products
      WHERE supplier_id = ${supplierId}::uuid AND status <> 'archived'
    `);
    const cnt = Number((remainingRes.rows[0] as { cnt: number } | undefined)?.cnt ?? 0);
    if (cnt === 0) {
      await db.execute(sql`
        UPDATE supply.suppliers
        SET status = 'suspended', updated_at = now()
        WHERE id = ${supplierId}::uuid AND status <> 'suspended'
      `);
      suspendedSuppliersCount += 1;
    }
  }

  const publicCountRes = await db.execute(sql`
    SELECT COUNT(*)::int AS "cnt"
    FROM catalog.products p
    INNER JOIN supply.suppliers s ON s.id = p.supplier_id
    WHERE p.status = 'published' AND s.status = 'active'
  `);
  const remainingPublicProductsCount = Number(
    (publicCountRes.rows[0] as { cnt: number } | undefined)?.cnt ?? 0,
  );

  return {
    appEnv,
    archivedProductsCount: archivedIds.length,
    archivedProductSlugs: archivedSlugs,
    suspendedSuppliersCount,
    remainingPublicProductsCount,
  };
}

async function main(): Promise<void> {
  assertStagingCleanupEnvAllowed();
  const { db, pool } = createDbClient();
  try {
    const result = await runStagingCleanupTestData(db);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } finally {
    await pool.end();
  }
}

const isEntrypoint = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isEntrypoint) {
  main().catch((err: unknown) => {
    const detail = err instanceof Error ? (err.stack ?? err.message) : String(err);
    process.stderr.write(`[staging:cleanup-test-data] FAILED: ${detail}\n`);
    process.exit(1);
  });
}
