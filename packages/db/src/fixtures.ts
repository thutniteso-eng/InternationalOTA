import { resolveAppEnv } from '@internationalota/shared';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { eq, sql } from 'drizzle-orm';
import { createDbClient, type DatabaseClient } from './client.ts';
import {
  catalogProductImages,
  catalogProducts,
  catalogProductTranslations,
} from './schema/catalog.ts';
import { supplySuppliers } from './schema/supply.ts';

// Fixed deterministic UUIDv7 constants so `pnpm catalog:fixtures` is idempotent across re-runs.
const FAKE_SUPPLIER_ID = '01950000-0000-7000-8000-000000000101';

const FAKE_PRODUCTS = [
  {
    id: '01950000-0000-7000-8000-000000000201',
    kind: 'tour',
    region: 'Phú Quốc',
    lat: 10.0256,
    lng: 104.0128,
    meetingPointNote: 'Cảng An Thới, Phú Quốc',
    durationMinutes: 420,
    translations: [
      {
        locale: 'vi',
        slug: 'fake-tour-4-dao-phu-quoc',
        title: '[FAKE] Tour Đảo Ngọc 4 Đảo Nam Phú Quốc',
        summary: '[FAKE] Hành trình cano khám phá 4 hòn đảo đẹp nhất Nam Phú Quốc.',
        description:
          '[FAKE] Dữ liệu mẫu phục vụ phát triển nội bộ. Bao gồm cano cao tốc, lặn ngắm san hô và ăn trưa hải sản.',
        highlights: ['Cano Nam đảo', 'Lặn ngắm san hô'],
        inclusions: ['Xe đưa đón trung tâm Dương Đông', 'Bữa trưa'],
        exclusions: ['Chi phí cá nhân'],
      },
      {
        locale: 'en',
        slug: 'fake-phu-quoc-4-island-tour',
        title: '[FAKE] Pearl Island 4-Island Boat Tour in South Phu Quoc',
        summary: '[FAKE] Speedboat excursion across four scenic islands in southern Phu Quoc.',
        description:
          '[FAKE] Local development fixture product. Includes speedboat transfers, snorkeling gear, and island lunch.',
        highlights: ['Southern islands speedboat', 'Coral snorkeling'],
        inclusions: ['Duong Dong hotel pickup', 'Lunch'],
        exclusions: ['Personal expenses'],
      },
    ],
    images: [
      {
        url: 'https://example.com/fixtures/phu-quoc-4-island.jpg',
        sort: 0,
        alt: {
          vi: '[FAKE] Cảnh biển Nam đảo Phú Quốc',
          en: '[FAKE] South Phu Quoc island seascape',
        },
      },
    ],
  },
  {
    id: '01950000-0000-7000-8000-000000000202',
    kind: 'activity',
    region: 'Phú Quốc',
    lat: 10.227,
    lng: 103.957,
    meetingPointNote: 'Bến Dinh Cậu, Dương Đông, Phú Quốc',
    durationMinutes: 180,
    translations: [
      {
        locale: 'vi',
        slug: 'fake-cau-muc-dem-phu-quoc',
        title: '[FAKE] Trải Nghiệm Câu Mực Đêm & Ngắm Hoàng Hôn Dương Đông',
        summary: '[FAKE] Hoạt động buổi tối câu mực và thưởng thức cháo mực trên tàu.',
        description:
          '[FAKE] Dữ liệu mẫu phục vụ phát triển nội bộ. Khởi hành từ bến Dinh Cậu lúc 17:00 hàng ngày.',
        highlights: ['Ngắm hoàng hôn trên biển', 'Cháo mực nóng'],
        inclusions: ['Dụng cụ câu mực', 'Áo phao'],
        exclusions: ['Đồ uống có cồn'],
      },
      {
        locale: 'en',
        slug: 'fake-phu-quoc-night-squid-fishing',
        title: '[FAKE] Sunset & Night Squid Fishing Activity in Duong Dong',
        summary: '[FAKE] Evening boat trip with sunset views and onboard squid fishing.',
        description: '[FAKE] Local development fixture activity departing Dinh Cau Pier at 17:00.',
        highlights: ['Ocean sunset', 'Fresh squid supper'],
        inclusions: ['Fishing tackle', 'Life jackets'],
        exclusions: ['Alcoholic beverages'],
      },
    ],
    images: [
      {
        url: 'https://example.com/fixtures/phu-quoc-squid.jpg',
        sort: 0,
        alt: {
          vi: '[FAKE] Hoàng hôn biển Dương Đông',
          en: '[FAKE] Duong Dong coastal sunset',
        },
      },
    ],
  },
  {
    id: '01950000-0000-7000-8000-000000000203',
    kind: 'transfer',
    region: 'Phú Quốc',
    lat: 10.1717,
    lng: 103.9912,
    meetingPointNote: 'Sân bay Quốc tế Phú Quốc (PQC)',
    durationMinutes: 35,
    translations: [
      {
        locale: 'vi',
        slug: 'fake-xe-don-san-bay-phu-quoc',
        title: '[FAKE] Xe Riêng Đón Tiễn Sân Bay Phú Quốc — Dương Đông',
        summary: '[FAKE] Dịch vụ đưa đón riêng 4–7 chỗ từ sân bay PQC về khách sạn.',
        description:
          '[FAKE] Dữ liệu mẫu phục vụ phát triển nội bộ. Tài xế chờ sẵn tại cổng ga đến theo mã chuyến bay.',
        highlights: ['Xe đời mới', 'Đón tận ga đến'],
        inclusions: ['Phí sân bay', 'Nước suối'],
        exclusions: ['Phí chờ ngoài giờ'],
      },
      {
        locale: 'en',
        slug: 'fake-phu-quoc-airport-private-transfer',
        title: '[FAKE] Phu Quoc Airport (PQC) Private Transfer to Duong Dong',
        summary: '[FAKE] Private 4–7 seat car transfer between PQC airport and hotels.',
        description:
          '[FAKE] Local development fixture transfer with flight-tracked meet-and-greet at arrivals.',
        highlights: ['Modern private car', 'Meet and greet'],
        inclusions: ['Airport toll fees', 'Bottled water'],
        exclusions: ['Extended waiting fee'],
      },
    ],
    images: [
      {
        url: 'https://example.com/fixtures/phu-quoc-transfer.jpg',
        sort: 0,
        alt: {
          vi: '[FAKE] Xe đưa đón sân bay Phú Quốc',
          en: '[FAKE] Phu Quoc airport private car',
        },
      },
    ],
  },
] as const;

export function assertFixturesAllowed(): void {
  const appEnv = resolveAppEnv();
  if (appEnv === 'staging' || appEnv === 'production') {
    throw new Error(
      `Refusing to load dev catalog fixtures in APP_ENV=${appEnv}. Only local/test environments are permitted.`,
    );
  }
}

export async function seedCatalogDevFixtures(
  db: DatabaseClient,
): Promise<{ supplierId: string; productIds: string[] }> {
  assertFixturesAllowed();

  return db.transaction(async (tx) => {
    await tx
      .insert(supplySuppliers)
      .values({
        id: FAKE_SUPPLIER_ID,
        name: 'Phú Quốc Explorer [FAKE]',
        legalName: 'Phu Quoc Explorer Fixture Co., Ltd.',
        countryAlpha2: 'VN',
        contactEmail: 'fixtures-noreply@example.invalid',
        contactPhone: '+84000000000',
        status: 'active',
      })
      .onConflictDoUpdate({
        target: supplySuppliers.id,
        set: {
          name: 'Phú Quốc Explorer [FAKE]',
          status: 'active',
          updatedAt: sql`now()`,
        },
      });

    const productIds: string[] = [];

    for (const p of FAKE_PRODUCTS) {
      await tx
        .insert(catalogProducts)
        .values({
          id: p.id,
          supplierId: FAKE_SUPPLIER_ID,
          kind: p.kind,
          status: 'published',
          countryAlpha2: 'VN',
          region: p.region,
          location: sql`ST_SetSRID(ST_MakePoint(${p.lng}, ${p.lat}), 4326)::geography`,
          meetingPointNote: p.meetingPointNote,
          timeZone: 'Asia/Ho_Chi_Minh',
          durationMinutes: p.durationMinutes,
          publishedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: catalogProducts.id,
          set: {
            status: 'published',
            updatedAt: sql`now()`,
          },
        });

      for (const tr of p.translations) {
        await tx
          .insert(catalogProductTranslations)
          .values({
            productId: p.id,
            locale: tr.locale,
            slug: tr.slug,
            title: tr.title,
            summary: tr.summary,
            description: tr.description,
            highlights: [...tr.highlights],
            inclusions: [...tr.inclusions],
            exclusions: [...tr.exclusions],
          })
          .onConflictDoUpdate({
            target: [catalogProductTranslations.productId, catalogProductTranslations.locale],
            set: {
              title: tr.title,
              slug: tr.slug,
              summary: tr.summary,
              description: tr.description,
              highlights: [...tr.highlights],
              inclusions: [...tr.inclusions],
              exclusions: [...tr.exclusions],
            },
          });
      }

      await tx.delete(catalogProductImages).where(eq(catalogProductImages.productId, p.id));
      for (const img of p.images) {
        await tx.insert(catalogProductImages).values({
          productId: p.id,
          url: img.url,
          sort: img.sort,
          alt: img.alt,
        });
      }

      productIds.push(p.id);
    }

    return { supplierId: FAKE_SUPPLIER_ID, productIds };
  });
}

export async function runCatalogFixturesCli(): Promise<void> {
  try {
    assertFixturesAllowed();
    const { db, pool } = createDbClient();
    try {
      const result = await seedCatalogDevFixtures(db);
      process.stdout.write(
        `Loaded catalog dev fixtures: supplier=${result.supplierId}, products=${result.productIds.length}\n`,
      );
    } finally {
      await pool.end();
    }
  } catch (err) {
    process.stderr.write(
      `Failed to load catalog dev fixtures: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exit(1);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  void runCatalogFixturesCli();
}
