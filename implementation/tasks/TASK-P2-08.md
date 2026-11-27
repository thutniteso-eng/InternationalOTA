# TASK P2-08 — Notifications: transactional email via SMTP adapter + Mailpit (D-020, D-023)

## OBJECTIVE
Customers receive correct, localized (vi/en) emails for every booking milestone:
- email verification and password reset (replacing the log-only sender);
- hold created, booking confirmed, hold expired, booking cancelled (with refund amount), refund completed.

Every email is sent **exactly once per event**, survives SMTP outages through retries, and never leaks PII into logs. Locally and on staging, all mail lands in **Mailpit** (no real delivery).

## BACKGROUND
Read:
- D-020 (adapters + local simulators; Mailpit for email), **D-023** (nodemailer approved as the SMTP client);
- identity `EmailSender` interface + the log-only sender (production must refuse to start with it);
- P1-08 outbox (`OutboxEventHandler`), P1-10 redaction, P1-11 i18n (`t`, `formatMoney`, `formatLocalDate`);
- events emitted by P2-04/P2-05/P2-07: `booking.held`, `booking.confirmed`, `booking.expired`, `booking.cancelled` (if missing, add it in the cancel paths), `refund.succeeded`, `payment.refund_required`.

## SCOPE
### A. Module `notifications`
- **Port** `EmailTransport.send({ to, subject, text, html, headers }) → { messageId }`.
  - `SmtpEmailTransport` (nodemailer, exact version pin; config `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS`, `MAIL_FROM`).
  - `LogEmailTransport` for tests only.
  - Production boot fails if the transport is the log one or SMTP config is incomplete.
- Identity's `EmailSender` is implemented on top of the transport, so verification and reset emails go through Mailpit. The identity public API is unchanged.
- **Table `notifications.email_messages`:**
  - columns: `id`, `event_id` (outbox event id), `template`, `recipient_hash` (SHA-256 of the lower-cased email; never store the plaintext address outside the booking row), `locale`, `status` (`queued`, `sent`, `failed`, `dead`), `attempts`, `last_error` (redacted), `provider_message_id`, timestamps;
  - `UNIQUE (event_id, template)` is the exactly-once key.
  - Transitions are DB-guarded, with a version, as in earlier tasks.
- **Outbox consumers** (one per event type): resolve the booking via the booking public API (owner contact and locale), render the template, insert `queued`, then a pg-boss sender job delivers it.
  - Retries: exponential backoff, up to 5 attempts, then `dead` + error log.
  - A duplicate event is a no-op because of the unique key.
- **Templates** (`packages/i18n` messages, vi and en):
  - Plain text plus simple inline-styled HTML. Every email carries the DEMO footer while `APP_ENV` ≠ production.
  - Content per template:
    - **held:** reference, tour title, local date and time with the product time zone, pax, total, hold expiry time, link to the booking;
    - **confirmed:** the above plus the meeting point and the cancellation policy sentences (reuse the U1 wording below);
    - **expired:** short notice and a link to rebook;
    - **cancelled:** refund amount/percent or "no refund under the policy";
    - **refund_succeeded:** amount and the "may take N business days" text (configurable N).
  - Amounts and dates are formatted only via P1-11, and nothing is hard-coded.
  - Policy sentences fix polish item **U1**: "Hủy từ 48 giờ trở lên trước giờ khởi hành: hoàn 100%" / "Cancel 48+ hours before start: 100% refund". Share the formatter between web and email.
- Links use `PUBLIC_WEB_BASE_URL` (staging = the tunnel URL, set by `staging-up.sh`).

### B. Infra
- `docker-compose` (dev) and staging compose add `mailpit` (pinned image; SMTP 1025, UI 8025).
- Staging Caddy exposes the Mailpit UI at `/mailpit/*` **behind basic auth** (Mailpit `--webroot /mailpit/`).
- `staging-up.sh` wires the `SMTP_*` and `PUBLIC_WEB_BASE_URL` env.

## OUT OF SCOPE
SMS/Zalo, push, real email provider (SES/SendGrid etc.), marketing emails, unsubscribe management, attachments/ICS, a supplier notification email (later).

## ACCEPTANCE CRITERIA (integration tests, isolated temp DB, a Mailpit container **or** a local SMTP test server started by the test)
1. **Happy path:** hold → pay → confirm produces exactly 2 emails (held, confirmed) to the contact address, in the booking's locale. Subjects and bodies contain the reference, the correctly formatted total (`2.550.000 ₫` vi / `₫2,550,000` en for the 2/1/1 demo case) and the local start time.
2. **Exactly once:**
   - the same outbox event delivered 3× concurrently → 1 row and 1 SMTP send;
   - SMTP down for the first 2 attempts → sent on attempt 3 with no duplicate;
   - SMTP permanently down → `dead` after 5 attempts.
3. **Cancellation:** a confirmed booking cancelled at 30h → the cancelled email shows the 50% refund amount; after the refund succeeds, the refund email shows the same amount.
4. **Identity:** sign-up → verification email arrives via SMTP with a working link, and the token flow still passes the existing identity tests.
5. **PII:** logs for the whole flow contain no email address, phone or name (extend the redaction test); `email_messages` has no plaintext address.
6. **Production guard:** `APP_ENV=production` with the log transport or missing SMTP config → boot fails with a clear message (test).
7. **i18n:** there are no missing keys in vi/en for all templates, and the U1 wording is used on the web detail page too (snapshot test).
8. **Staging:** a full flow via the tunnel, and the report includes screenshots of Mailpit showing the vi and en confirmed emails.
9. **Mutation evidence** (each kills ≥ 1 test):
    - (a) drop the `(event_id, template)` unique key;
    - (b) send before inserting the row;
    - (c) remove the production guard;
    - (d) log the recipient address.
    Also a `lint:boundaries` violation demo, and fresh clone + CI green.

## DELIVERABLES
Branch `task/P2-08-notifications`, PR `[P2-08] Email notifications (SMTP + Mailpit)`, report `reports/TASK-P2-08-report.md` with screenshots, verbatim test output, the mutation table and `git ls-remote` proof.
