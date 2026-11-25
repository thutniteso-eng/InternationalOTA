# Demo data: Phú Quốc catalog

`phu-quoc-demo-catalog.json` contains realistic **demo** data (vi/en) for the catalog module (TASK-P2-01 and later).

- 3 fictional suppliers with the "(Demo)" suffix and `.demo.invalid` emails. They do not impersonate any real company.
- 9 products: tour / activity / transfer. Places are real (An Thới, Hòn Thơm, Gành Dầu, Bãi Sao, Rạch Tràm, PQC). Coordinates are approximate.
- Prices are integer VND (ISO 4217, minor unit = 0). They are indicative, based on market ranges in Nov 2026.
- `capacityPerDeparture`, `departureTimes` (Asia/Ho_Chi_Minh) and `cancellationPolicy` are included in preparation for P2-02 (dated inventory) and P2-05 (cancellation).

Rules:
1. Load only when `APP_ENV` ≠ `production`.
2. Do not use for marketing or real sales.
3. Fields the current schema does not support yet (pricing, policy, capacity) are kept in the JSON. The loader ignores them until the corresponding task is approved.
