# TASK P2-08 Report — Transactional Email Notifications via SMTP + Mailpit (D-020, D-023)

## 1. Summary of Changes

Implemented transactional emails across the full booking & identity lifecycle using a `nodemailer`-backed SMTP transport (`D-023`, pinned at `"nodemailer": "10.6.1"`, `"@types/nodemailer": "8.0.2"`, restricted strictly to `apps/api/src/modules/notifications/`), localized (`vi`/`en`) P1-11 formatted templates, SHA-256 recipient hashing, Mailpit capture locally and on staging, and polish item **U1**.

### Dependencies (`D-023`) & Boundaries

- [package.json](file:///home/iteso/projects/InternationalOTA/apps/api/package.json): added exact pinned `"nodemailer": "10.6.1"` (plus dev `"@types/nodemailer": "8.0.2"`), added `"nodemailer"` (`MIT-0`) exception entry in [license-exceptions.json](file:///home/iteso/projects/InternationalOTA/tools/license-exceptions.json).
- [.dependency-cruiser.cjs](file:///home/iteso/projects/InternationalOTA/.dependency-cruiser.cjs): added `no-nodemailer-outside-notifications` forbidding importing `nodemailer` outside `apps/api/src/modules/notifications/`.

### Database & Migrations (Forward-Only)

- [notifications.ts](file:///home/iteso/projects/InternationalOTA/packages/db/src/schema/notifications.ts) & [0017_broken_zaran.sql](file:///home/iteso/projects/InternationalOTA/packages/db/migrations/0017_broken_zaran.sql):
  - Created schema `notifications` and table `notifications.email_messages` (`id`, `event_id`, `template`, `recipient_hash` SHA-256, `locale`, `status` `queued|sent|failed|dead`, `attempts`, `next_attempt_at`, `last_error`, `provider_message_id`, `sent_at`, `version`, timestamps).
  - Enforced `CONSTRAINT "email_messages_event_template_unique" UNIQUE ("event_id", "template")` as the exactly-once delivery key, status/hash/sent_at checks, and `BEFORE UPDATE` trigger `notifications.trg_fn_email_messages_transition()` locking immutable columns, strict `version = OLD.version + 1`, and terminal `sent`/`dead` states.
- [roles.ts](file:///home/iteso/projects/InternationalOTA/packages/db/src/roles.ts): granted `USAGE` on `notifications` and least-privilege `SELECT, INSERT, UPDATE` on `notifications.email_messages` to `ota_app` (verified `DELETE` denied).

### Notifications Module, Identity Bridge & U1 i18n

- **`apps/api/src/modules/notifications/`**:
  - [email-transport.ts](file:///home/iteso/projects/InternationalOTA/apps/api/src/modules/notifications/email-transport.ts): `EmailTransport` port, `SmtpEmailTransport` (via `nodemailer`), `LogEmailTransport` (for tests when `SMTP_HOST` is unset), `resolveSmtpConfigFromEnv()`, `hashRecipientEmail()`, and `redactEmailAddresses()`.
  - [email-renderer.service.ts](file:///home/iteso/projects/InternationalOTA/apps/api/src/modules/notifications/email-renderer.service.ts): renders HTML-escaped inline-styled HTML and plain-text emails with DEMO footer when `APP_ENV !== 'production'` (`booking_held`, `booking_confirmed`, `booking_expired`, `booking_cancelled`, `refund_succeeded`, plus verification & reset-password), formatting all amounts & timestamps exclusively via `@internationalota/i18n` + `@internationalota/money`.
  - [notifications-email-sender.service.ts](file:///home/iteso/projects/InternationalOTA/apps/api/src/modules/notifications/notifications-email-sender.service.ts) & [email-sender.interface.ts](file:///home/iteso/projects/InternationalOTA/apps/api/src/modules/identity/email-sender.interface.ts): routes Identity verification & password-reset emails over `EmailTransport` while preserving Identity's public API unchanged.
  - [notifications.service.ts](file:///home/iteso/projects/InternationalOTA/apps/api/src/modules/notifications/notifications.service.ts): subscribes to `booking.held`, `booking.confirmed`, `booking.expired`, `booking.cancelled`, `refund.succeeded` outbox events; inserts idempotent `(event_id, template)` rows inside the outbox transaction (`tx ?? db`, avoiding FK lock contention); dispatches due messages via pg-boss queue `notification-email-send` (`FOR UPDATE SKIP LOCKED` + lease without holding DB locks across SMTP); retries failures with exponential backoff up to 5 attempts before marking `dead` with email-redacted `last_error`.
  - **Production guard:** refuses boot in `APP_ENV=production` when `LogEmailTransport` is active or `SMTP_HOST`/`SMTP_PORT`/`MAIL_FROM` config is incomplete.
- **Cross-module read APIs & Outbox/PG-Boss:**
  - Added read-only helpers `BookingService.getNotificationBookingById` and `CatalogService.getProductSummaryForNotification`; updated `OutboxService.registerHandler` to allow multiple handlers per `eventType` with optional `tx`; added `QUEUE_NOTIFICATION_EMAIL_SEND` & outbox/sender wake-ups in `JobQueueService`.
- **Shared U1 Policy Formatter (`packages/i18n`, `apps/web`):**
  - Added [policy.ts](file:///home/iteso/projects/InternationalOTA/packages/i18n/src/policy.ts) (`formatCancellationPolicySentences`), updated [en.json](file:///home/iteso/projects/InternationalOTA/packages/i18n/messages/en.json) & [vi.json](file:///home/iteso/projects/InternationalOTA/packages/i18n/messages/vi.json) (`"Cancel {hours}+ hours before start: 100% refund."` / `"Hủy từ {hours} giờ trở lên trước giờ khởi hành: hoàn 100%."`), and shared the formatter across both [catalog-api.ts](file:///home/iteso/projects/InternationalOTA/apps/web/src/lib/catalog-api.ts) and [email-renderer.service.ts](file:///home/iteso/projects/InternationalOTA/apps/api/src/modules/notifications/email-renderer.service.ts), verified by inline snapshot assertions in [browse.spec.tsx](file:///home/iteso/projects/InternationalOTA/apps/web/src/app/browse.spec.tsx).
- **Redaction:** Extended `SENSITIVE_KEYS` in [logger.ts](file:///home/iteso/projects/InternationalOTA/apps/api/src/common/observability/logger.ts) and [observability.spec.ts](file:///home/iteso/projects/InternationalOTA/apps/api/src/common/observability/observability.spec.ts).

### Infrastructure (`docker-compose.yml` & Staging)

- Added pinned `axllent/mailpit:v1.24.1` (`1025` SMTP / `8025` UI) to [docker-compose.yml](file:///home/iteso/projects/InternationalOTA/docker-compose.yml) and [compose.yml](file:///home/iteso/projects/InternationalOTA/deploy/staging/compose.yml) (`--webroot /mailpit/`).
- Protected `/mailpit*` behind Caddy Basic Auth in [Caddyfile](file:///home/iteso/projects/InternationalOTA/deploy/staging/Caddyfile) and wired `SMTP_*` + `PUBLIC_WEB_BASE_URL` in [staging-up.sh](file:///home/iteso/projects/InternationalOTA/scripts/staging-up.sh).

---

## 2. Mutation Testing Evidence (a–d) & Boundary Violation Demo

Each mutation was applied temporarily in-place, run against its targeted test in [notifications.spec.ts](file:///home/iteso/projects/InternationalOTA/apps/api/src/modules/notifications/notifications.spec.ts), verified to exit non-zero (`exit 1`), and immediately restored:

| #     | Mutation Applied                                                                                                | Target File                                                                                                                          | Targeted Test                         | Observed Failure Output                                                                                                                   | Status                |
| ----- | --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | --------------------- |
| **a** | Drop `CONSTRAINT "email_messages_event_template_unique" UNIQUE("event_id","template")`                          | [0017_broken_zaran.sql](file:///home/iteso/projects/InternationalOTA/packages/db/migrations/0017_broken_zaran.sql)                   | `notifications.spec.ts -t "AC2"`      | `PostgreSQL error 42P10: there is no unique or exclusion constraint matching the ON CONFLICT specification`                               | **Killed (`exit 1`)** |
| **b** | Call `this.transport.send(...)` before inserting the `notifications.email_messages` row in `handleBookingEvent` | [notifications.service.ts](file:///home/iteso/projects/InternationalOTA/apps/api/src/modules/notifications/notifications.service.ts) | `notifications.spec.ts -t "AC2"`      | `AssertionError: expected [ ...4 items ] to have a length of 1` (`+4` vs `-1`, `notifications.spec.ts:822`)                               | **Killed (`exit 1`)** |
| **c** | Bypass `LogEmailTransport` production check in `NotificationsService.onModuleInit`                              | [notifications.service.ts](file:///home/iteso/projects/InternationalOTA/apps/api/src/modules/notifications/notifications.service.ts) | `notifications.spec.ts -t "AC6"`      | `expect(prodApp.init()).rejects.toThrow(/LogEmailTransport cannot be used/i)` resolved instead of throwing (`notifications.spec.ts:1190`) | **Killed (`exit 1`)** |
| **d** | Log plaintext recipient address in `NotificationsService.processDueEmails`                                      | [notifications.service.ts](file:///home/iteso/projects/InternationalOTA/apps/api/src/modules/notifications/notifications.service.ts) | `notifications.spec.ts -t "AC1\|AC5"` | `AssertionError: expected raw log buffer not to contain 'ac1-vi-pii@example.com'` (`notifications.spec.ts:1127`)                          | **Killed (`exit 1`)** |

### Boundary Violation Demo (`pnpm lint:boundaries`)

- Temporarily added `import nodemailer from 'nodemailer';` inside [booking.service.ts](file:///home/iteso/projects/InternationalOTA/apps/api/src/modules/booking/booking.service.ts):
  ```text
  error no-nodemailer-outside-notifications: apps/api/src/modules/booking/booking.service.ts → node_modules/.pnpm/nodemailer@10.6.1/node_modules/nodemailer/dist/cjs/nodemailer.js
  x 1 dependency violations (1 errors, 0 warnings). 156 modules, 746 dependencies cruised.
  ```
- After restoring clean separation (`nodemailer` isolated in `notifications`):
  ```text
  ✔ no dependency violations found (156 modules, 746 dependencies cruised)
  ```

---

## 3. Verbatim Test & Verification Output

- `pnpm format:check` — all workspace packages & `tools` pass Prettier.
- `pnpm lint` — all packages, `apps/api`, `apps/web`, and `tools` pass ESLint.
- `pnpm lint:boundaries` — `✔ no dependency violations found (156 modules, 746 dependencies cruised)`.
- `pnpm typecheck` & `pnpm build` — clean exit 0 across all packages and apps.
- `pnpm db:generate` — `No schema changes, nothing to migrate`.
- `DATABASE_URL="postgresql://ota_user:ota_password@localhost:55432/ota_dev" pnpm test`:
  - `@internationalota/api`: `18 passed (18)` test files / `139 passed (139)` tests (including `6/6` tests AC1–AC6 in [notifications.spec.ts](file:///home/iteso/projects/InternationalOTA/apps/api/src/modules/notifications/notifications.spec.ts) and extended redaction assertions in [observability.spec.ts](file:///home/iteso/projects/InternationalOTA/apps/api/src/common/observability/observability.spec.ts)).
  - `@internationalota/i18n`: `2 passed (2)` files / `21 passed (21)` tests (`catalog-parity.spec.ts` + `i18n.spec.ts`).
  - `@internationalota/web`: `2 passed (2)` files / `8 passed (8)` tests (including U1 inline snapshots in [browse.spec.tsx](file:///home/iteso/projects/InternationalOTA/apps/web/src/app/browse.spec.tsx)).
  - `tools/check-licenses.spec.ts`: `16 passed (16)` tests.
- `pnpm licenses:check` — `✅ All 473 package licenses verified successfully.`
- `pnpm audit --prod --audit-level high` — exit 0 (`0` high/critical vulnerabilities; 1 moderate).

---

## 4. Staging E2E Verification & Mailpit Screenshots

Executed over live staging tunnel `https://characterized-knowledgestorm-median-executed.trycloudflare.com` (Mailpit protected under Basic Auth at `/mailpit/`):

```text
1. Mailpit /mailpit/ without Basic Auth -> 401
2. Mailpit /mailpit/api/v1/info with Basic Auth -> 200
3. VI confirmed: PQ-4Y3Z02YY (2550000 VND)
4. EN confirmed: PQ-25SR1WT6 (2550000 VND)
5. Mailpit VI Confirmed ID=o7v2yaR6DYXA5bWiGttkEV Subject="[Xác nhận] Đơn PQ-4Y3Z02YY — Tour 4 Đảo Nam Phú Quốc (a77bf7f6)"
   Contains "2.550.000": true
   Contains U1 VI: true
6. Mailpit EN Confirmed ID=XxjMhG2PuhfebVHjqi7NQ2 Subject="[Confirmed] Booking PQ-25SR1WT6 — South Phu Quoc 4-Island Boat Tour (a77bf7f6)"
   Contains "₫2,550,000": true
   Contains U1 EN: true
7. ota_app privileges: notifications.email_messages|INSERT,SELECT,UPDATE
8. notifications.email_messages statuses:
   booking_confirmed|en|sent
   booking_cancelled|en|sent
   booking_held|en|sent
   booking_confirmed|vi|sent
   booking_held|vi|sent
```

### Mailpit Screenshots (`PQ-4Y3Z02YY` vi & `PQ-25SR1WT6` en)

| Confirmed Email (`vi`) — `2.550.000 ₫` + U1                         | Confirmed Email (`en`) — `₫2,550,000` + U1                          |
| ------------------------------------------------------------------- | ------------------------------------------------------------------- |
| ![Mailpit Confirmed VI](screenshots/p2-08/mailpit-confirmed-vi.png) | ![Mailpit Confirmed EN](screenshots/p2-08/mailpit-confirmed-en.png) |
