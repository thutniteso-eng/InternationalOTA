CREATE SCHEMA "payments";
--> statement-breakpoint
CREATE TABLE "payments"."mock_psp_transactions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"provider_ref" text NOT NULL,
	"attempt_id" uuid NOT NULL,
	"booking_reference" text NOT NULL,
	"amount_minor" bigint NOT NULL,
	"currency" char(3) NOT NULL,
	"locale" text NOT NULL,
	"return_url" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"last_event_id" text,
	"occurred_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mock_psp_transactions_provider_ref_unique" UNIQUE("provider_ref"),
	CONSTRAINT "mock_psp_transactions_attempt_unique" UNIQUE("attempt_id"),
	CONSTRAINT "mock_psp_transactions_amount_positive" CHECK (amount_minor > 0),
	CONSTRAINT "mock_psp_transactions_status_check" CHECK (status IN ('pending', 'succeeded', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "payments"."payment_attempts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"booking_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"provider_ref" text,
	"amount_minor" bigint NOT NULL,
	"currency" char(3) NOT NULL,
	"provider_config_snapshot" jsonb NOT NULL,
	"status" text DEFAULT 'initiated' NOT NULL,
	"failure_reason" text,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "payment_attempts_provider_ref_unique" UNIQUE("provider","provider_ref"),
	CONSTRAINT "payment_attempts_amount_positive" CHECK (amount_minor > 0),
	CONSTRAINT "payment_attempts_status_check" CHECK (status IN ('initiated', 'succeeded', 'failed', 'refund_required', 'expired')),
	CONSTRAINT "payment_attempts_version_check" CHECK (version > 0),
	CONSTRAINT "payment_attempts_completed_consistency_check" CHECK ((status = 'initiated' AND completed_at IS NULL) OR (status <> 'initiated' AND completed_at IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "payments"."mock_psp_transactions" ADD CONSTRAINT "mock_psp_transactions_currency_currencies_code_fk" FOREIGN KEY ("currency") REFERENCES "reference"."currencies"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments"."payment_attempts" ADD CONSTRAINT "payment_attempts_booking_id_bookings_id_fk" FOREIGN KEY ("booking_id") REFERENCES "booking"."bookings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments"."payment_attempts" ADD CONSTRAINT "payment_attempts_currency_currencies_code_fk" FOREIGN KEY ("currency") REFERENCES "reference"."currencies"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "payment_attempts_one_succeeded_per_booking_idx" ON "payments"."payment_attempts" USING btree ("booking_id") WHERE status = 'succeeded';--> statement-breakpoint
CREATE INDEX "payment_attempts_booking_created_idx" ON "payments"."payment_attempts" USING btree ("booking_id","created_at");--> statement-breakpoint
CREATE INDEX "payment_attempts_status_created_idx" ON "payments"."payment_attempts" USING btree ("status","created_at");--> statement-breakpoint
CREATE OR REPLACE FUNCTION "payments"."trg_fn_payment_attempts_transition"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
	IF NEW.version IS DISTINCT FROM OLD.version + 1 THEN
		RAISE EXCEPTION 'Payment attempt version must increment strictly on update (expected %, got %)', OLD.version + 1, NEW.version
			USING ERRCODE = 'check_violation';
	END IF;

	IF NEW.id IS DISTINCT FROM OLD.id
		OR NEW.booking_id IS DISTINCT FROM OLD.booking_id
		OR NEW.provider IS DISTINCT FROM OLD.provider
		OR NEW.amount_minor IS DISTINCT FROM OLD.amount_minor
		OR NEW.currency IS DISTINCT FROM OLD.currency
		OR NEW.provider_config_snapshot IS DISTINCT FROM OLD.provider_config_snapshot
		OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
		RAISE EXCEPTION 'Payment attempt immutable core attributes cannot be modified'
			USING ERRCODE = 'restrict_violation';
	END IF;

	IF OLD.status = 'initiated' AND NEW.status = 'initiated' THEN
		IF OLD.provider_ref IS NOT NULL OR NEW.provider_ref IS NULL THEN
			RAISE EXCEPTION 'Payment attempt provider_ref can only be set once while initiated'
				USING ERRCODE = 'restrict_violation';
		END IF;
		IF NEW.completed_at IS NOT NULL OR NEW.failure_reason IS NOT NULL THEN
			RAISE EXCEPTION 'Initiated payment attempt cannot set completed_at or failure_reason'
				USING ERRCODE = 'check_violation';
		END IF;
		RETURN NEW;
	END IF;

	IF NOT (
		OLD.status = 'initiated'
		AND NEW.status IN ('succeeded', 'failed', 'refund_required', 'expired')
	) THEN
		RAISE EXCEPTION 'Illegal payment attempt status transition from "%" to "%"', OLD.status, NEW.status
			USING ERRCODE = 'check_violation';
	END IF;

	IF NEW.provider_ref IS DISTINCT FROM OLD.provider_ref THEN
		RAISE EXCEPTION 'Payment attempt provider_ref cannot be modified during status transition'
			USING ERRCODE = 'restrict_violation';
	END IF;

	IF OLD.completed_at IS NOT NULL OR NEW.completed_at IS NULL THEN
		RAISE EXCEPTION 'Payment attempt completed_at must be set on terminal transition'
			USING ERRCODE = 'check_violation';
	END IF;

	IF NEW.status NOT IN ('failed', 'refund_required') AND NEW.failure_reason IS NOT NULL THEN
		RAISE EXCEPTION 'Payment attempt failure_reason may only be set on failed or refund_required'
			USING ERRCODE = 'check_violation';
	END IF;

	RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "trg_payment_attempts_transition"
BEFORE UPDATE ON "payments"."payment_attempts"
FOR EACH ROW
EXECUTE FUNCTION "payments"."trg_fn_payment_attempts_transition"();