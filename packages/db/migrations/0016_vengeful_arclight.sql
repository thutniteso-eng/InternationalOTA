CREATE TABLE "payments"."mock_psp_refunds" (
	"id" uuid PRIMARY KEY NOT NULL,
	"provider_refund_ref" text NOT NULL,
	"refund_id" uuid NOT NULL,
	"provider_ref" text NOT NULL,
	"amount_minor" bigint NOT NULL,
	"currency" char(3) NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"last_event_id" text,
	"occurred_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mock_psp_refunds_provider_ref_unique" UNIQUE("provider_refund_ref"),
	CONSTRAINT "mock_psp_refunds_refund_id_unique" UNIQUE("refund_id"),
	CONSTRAINT "mock_psp_refunds_amount_positive" CHECK (amount_minor > 0),
	CONSTRAINT "mock_psp_refunds_status_check" CHECK (status IN ('pending', 'succeeded', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "payments"."refunds" (
	"id" uuid PRIMARY KEY NOT NULL,
	"booking_id" uuid NOT NULL,
	"payment_attempt_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"amount_minor" bigint NOT NULL,
	"currency" char(3) NOT NULL,
	"reason" text NOT NULL,
	"status" text DEFAULT 'requested' NOT NULL,
	"provider_refund_ref" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_error" text,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "refunds_provider_ref_unique" UNIQUE("provider","provider_refund_ref"),
	CONSTRAINT "refunds_amount_positive" CHECK (amount_minor > 0),
	CONSTRAINT "refunds_reason_check" CHECK (reason IN ('customer_cancellation', 'departure_cancelled', 'late_payment', 'double_payment')),
	CONSTRAINT "refunds_status_check" CHECK (status IN ('requested', 'processing', 'succeeded', 'failed', 'manual_review')),
	CONSTRAINT "refunds_attempts_non_negative" CHECK (attempts >= 0),
	CONSTRAINT "refunds_version_check" CHECK (version > 0),
	CONSTRAINT "refunds_completed_consistency_check" CHECK ((status = 'succeeded' AND completed_at IS NOT NULL) OR (status <> 'succeeded' AND completed_at IS NULL))
);
--> statement-breakpoint
ALTER TABLE "payments"."mock_psp_transactions" ADD COLUMN "refund_mode" text DEFAULT 'auto_succeed' NOT NULL;--> statement-breakpoint
ALTER TABLE "payments"."mock_psp_refunds" ADD CONSTRAINT "mock_psp_refunds_currency_currencies_code_fk" FOREIGN KEY ("currency") REFERENCES "reference"."currencies"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments"."refunds" ADD CONSTRAINT "refunds_booking_id_bookings_id_fk" FOREIGN KEY ("booking_id") REFERENCES "booking"."bookings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments"."refunds" ADD CONSTRAINT "refunds_payment_attempt_id_payment_attempts_id_fk" FOREIGN KEY ("payment_attempt_id") REFERENCES "payments"."payment_attempts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments"."refunds" ADD CONSTRAINT "refunds_currency_currencies_code_fk" FOREIGN KEY ("currency") REFERENCES "reference"."currencies"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "refunds_booking_idx" ON "payments"."refunds" USING btree ("booking_id","created_at");--> statement-breakpoint
CREATE INDEX "refunds_attempt_idx" ON "payments"."refunds" USING btree ("payment_attempt_id");--> statement-breakpoint
CREATE INDEX "refunds_executor_idx" ON "payments"."refunds" USING btree ("status","next_attempt_at");--> statement-breakpoint
ALTER TABLE "payments"."mock_psp_transactions" ADD CONSTRAINT "mock_psp_transactions_refund_mode_check" CHECK (refund_mode IN ('auto_succeed', 'auto_fail', 'delay'));--> statement-breakpoint
CREATE OR REPLACE FUNCTION "booking"."trg_fn_bookings_transition"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
	IF NEW.version IS DISTINCT FROM OLD.version + 1 THEN
		RAISE EXCEPTION 'Booking version must increment strictly on update (expected %, got %)', OLD.version + 1, NEW.version
			USING ERRCODE = 'check_violation';
	END IF;

	IF NEW.id IS DISTINCT FROM OLD.id
		OR NEW.reference IS DISTINCT FROM OLD.reference
		OR NEW.customer_user_id IS DISTINCT FROM OLD.customer_user_id
		OR NEW.product_id IS DISTINCT FROM OLD.product_id
		OR NEW.departure_id IS DISTINCT FROM OLD.departure_id
		OR NEW.allocation_ref IS DISTINCT FROM OLD.allocation_ref
		OR NEW.currency IS DISTINCT FROM OLD.currency
		OR NEW.total_amount_minor IS DISTINCT FROM OLD.total_amount_minor
		OR NEW.snapshot_hash IS DISTINCT FROM OLD.snapshot_hash
		OR NEW.pax IS DISTINCT FROM OLD.pax
		OR NEW.seats IS DISTINCT FROM OLD.seats
		OR NEW.quote_snapshot IS DISTINCT FROM OLD.quote_snapshot
		OR NEW.hold_expires_at IS DISTINCT FROM OLD.hold_expires_at
		OR NEW.contact_name IS DISTINCT FROM OLD.contact_name
		OR NEW.contact_email IS DISTINCT FROM OLD.contact_email
		OR NEW.contact_phone IS DISTINCT FROM OLD.contact_phone
		OR NEW.contact_locale IS DISTINCT FROM OLD.contact_locale
		OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
		RAISE EXCEPTION 'Booking immutable core attributes cannot be modified'
			USING ERRCODE = 'restrict_violation';
	END IF;

	IF NOT (
		(OLD.status = 'held' AND NEW.status IN ('payment_pending', 'expired', 'cancelled'))
		OR (OLD.status = 'payment_pending' AND NEW.status IN ('confirmed', 'expired', 'cancelled'))
		OR (OLD.status = 'confirmed' AND NEW.status = 'cancelled')
	) THEN
		RAISE EXCEPTION 'Illegal booking status transition from "%" to "%"', OLD.status, NEW.status
			USING ERRCODE = 'check_violation';
	END IF;

	IF NEW.payment_ref IS DISTINCT FROM OLD.payment_ref
		AND NOT (NEW.status = 'confirmed' AND OLD.payment_ref IS NULL AND NEW.payment_ref IS NOT NULL) THEN
		RAISE EXCEPTION 'Booking payment_ref can only change from NULL to a value on transition to confirmed'
			USING ERRCODE = 'restrict_violation';
	END IF;

	IF OLD.status <> 'confirmed' AND NEW.status <> 'confirmed'
		AND (NEW.payment_ref IS NOT NULL OR NEW.confirmed_at IS NOT NULL) THEN
		RAISE EXCEPTION 'Booking payment_ref and confirmed_at can only be set on transition to confirmed'
			USING ERRCODE = 'restrict_violation';
	END IF;

	IF NEW.confirmed_at IS DISTINCT FROM OLD.confirmed_at
		AND NOT (NEW.status = 'confirmed' AND OLD.confirmed_at IS NULL AND NEW.confirmed_at IS NOT NULL) THEN
		RAISE EXCEPTION 'Booking confirmed_at can only be set on transition to confirmed'
			USING ERRCODE = 'restrict_violation';
	END IF;

	IF NEW.expired_at IS DISTINCT FROM OLD.expired_at
		AND NOT (NEW.status = 'expired' AND OLD.expired_at IS NULL AND NEW.expired_at IS NOT NULL) THEN
		RAISE EXCEPTION 'Booking expired_at can only be set on transition to expired'
			USING ERRCODE = 'restrict_violation';
	END IF;

	IF NEW.cancelled_at IS DISTINCT FROM OLD.cancelled_at
		AND NOT (NEW.status = 'cancelled' AND OLD.cancelled_at IS NULL AND NEW.cancelled_at IS NOT NULL) THEN
		RAISE EXCEPTION 'Booking cancelled_at can only be set on transition to cancelled'
			USING ERRCODE = 'restrict_violation';
	END IF;

	RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE OR REPLACE FUNCTION "payments"."trg_fn_refunds_transition"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
	IF NEW.version IS DISTINCT FROM OLD.version + 1 THEN
		RAISE EXCEPTION 'Refund version must increment strictly on update (expected %, got %)', OLD.version + 1, NEW.version
			USING ERRCODE = 'check_violation';
	END IF;

	IF NEW.id IS DISTINCT FROM OLD.id
		OR NEW.booking_id IS DISTINCT FROM OLD.booking_id
		OR NEW.payment_attempt_id IS DISTINCT FROM OLD.payment_attempt_id
		OR NEW.provider IS DISTINCT FROM OLD.provider
		OR NEW.amount_minor IS DISTINCT FROM OLD.amount_minor
		OR NEW.currency IS DISTINCT FROM OLD.currency
		OR NEW.reason IS DISTINCT FROM OLD.reason
		OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
		RAISE EXCEPTION 'Refund immutable core attributes cannot be modified'
			USING ERRCODE = 'restrict_violation';
	END IF;

	IF OLD.provider_refund_ref IS NOT NULL
		AND NEW.provider_refund_ref IS DISTINCT FROM OLD.provider_refund_ref THEN
		RAISE EXCEPTION 'Refund provider_refund_ref is immutable once set'
			USING ERRCODE = 'restrict_violation';
	END IF;

	IF OLD.status = 'processing' AND NEW.status = 'processing' THEN
		IF OLD.provider_refund_ref IS NOT NULL OR NEW.provider_refund_ref IS NULL THEN
			RAISE EXCEPTION 'Processing refund can only update in-place to record provider_refund_ref once'
				USING ERRCODE = 'restrict_violation';
		END IF;
		IF NEW.completed_at IS NOT NULL THEN
			RAISE EXCEPTION 'Processing refund cannot set completed_at'
				USING ERRCODE = 'check_violation';
		END IF;
		RETURN NEW;
	END IF;

	IF NOT (
		(OLD.status = 'requested' AND NEW.status = 'processing')
		OR (OLD.status = 'failed' AND NEW.status IN ('processing', 'manual_review'))
		OR (OLD.status = 'processing' AND NEW.status IN ('succeeded', 'failed', 'manual_review'))
		OR (OLD.status = 'manual_review' AND NEW.status = 'requested')
	) THEN
		RAISE EXCEPTION 'Illegal refund status transition from "%" to "%"', OLD.status, NEW.status
			USING ERRCODE = 'check_violation';
	END IF;

	IF NEW.status = 'succeeded' THEN
		IF OLD.completed_at IS NOT NULL OR NEW.completed_at IS NULL THEN
			RAISE EXCEPTION 'Succeeded refund must set completed_at'
				USING ERRCODE = 'check_violation';
		END IF;
	ELSIF NEW.completed_at IS NOT NULL THEN
		RAISE EXCEPTION 'Non-succeeded refund must keep completed_at NULL'
			USING ERRCODE = 'check_violation';
	END IF;

	RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "trg_refunds_transition"
BEFORE UPDATE ON "payments"."refunds"
FOR EACH ROW
EXECUTE FUNCTION "payments"."trg_fn_refunds_transition"();--> statement-breakpoint
CREATE OR REPLACE FUNCTION "payments"."trg_fn_refunds_over_refund_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
	v_attempt_amount bigint;
	v_attempt_currency char(3);
	v_existing_non_failed bigint;
BEGIN
	SELECT amount_minor, currency
	INTO v_attempt_amount, v_attempt_currency
	FROM "payments"."payment_attempts"
	WHERE id = NEW.payment_attempt_id
	FOR UPDATE;

	IF NOT FOUND THEN
		RAISE EXCEPTION 'Referenced payment attempt % not found', NEW.payment_attempt_id
			USING ERRCODE = 'foreign_key_violation';
	END IF;

	IF NEW.currency <> v_attempt_currency THEN
		RAISE EXCEPTION 'Refund currency % does not match payment attempt currency %', NEW.currency, v_attempt_currency
			USING ERRCODE = 'check_violation';
	END IF;

	IF NEW.status <> 'failed' THEN
		SELECT COALESCE(SUM(amount_minor), 0)::bigint
		INTO v_existing_non_failed
		FROM "payments"."refunds"
		WHERE payment_attempt_id = NEW.payment_attempt_id
			AND status <> 'failed'
			AND id <> NEW.id;

		IF v_existing_non_failed + NEW.amount_minor > v_attempt_amount THEN
			RAISE EXCEPTION 'Total non-failed refunds (% + %) exceed payment attempt amount (%)',
				v_existing_non_failed, NEW.amount_minor, v_attempt_amount
				USING ERRCODE = 'check_violation';
		END IF;
	END IF;

	RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "trg_refunds_over_refund_guard"
BEFORE INSERT OR UPDATE ON "payments"."refunds"
FOR EACH ROW
EXECUTE FUNCTION "payments"."trg_fn_refunds_over_refund_guard"();