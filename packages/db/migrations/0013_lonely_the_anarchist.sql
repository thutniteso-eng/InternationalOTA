CREATE SCHEMA "booking";
--> statement-breakpoint
CREATE TABLE "booking"."bookings" (
	"id" uuid PRIMARY KEY NOT NULL,
	"reference" text NOT NULL,
	"customer_user_id" text NOT NULL,
	"product_id" uuid NOT NULL,
	"departure_id" uuid NOT NULL,
	"status" text DEFAULT 'held' NOT NULL,
	"pax" jsonb NOT NULL,
	"seats" integer NOT NULL,
	"currency" char(3) NOT NULL,
	"total_amount_minor" bigint NOT NULL,
	"quote_snapshot" jsonb NOT NULL,
	"snapshot_hash" text NOT NULL,
	"contact_name" text NOT NULL,
	"contact_email" text NOT NULL,
	"contact_phone" text NOT NULL,
	"contact_locale" text NOT NULL,
	"allocation_ref" text NOT NULL,
	"hold_expires_at" timestamp with time zone NOT NULL,
	"payment_ref" text,
	"version" integer DEFAULT 1 NOT NULL,
	"confirmed_at" timestamp with time zone,
	"expired_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bookings_reference_unique" UNIQUE("reference"),
	CONSTRAINT "bookings_status_check" CHECK (status IN ('held', 'payment_pending', 'confirmed', 'expired', 'cancelled')),
	CONSTRAINT "bookings_seats_check" CHECK (seats > 0),
	CONSTRAINT "bookings_total_amount_check" CHECK (total_amount_minor >= 0),
	CONSTRAINT "bookings_version_check" CHECK (version > 0),
	CONSTRAINT "bookings_confirmed_consistency_check" CHECK (status <> 'confirmed' OR (payment_ref IS NOT NULL AND confirmed_at IS NOT NULL)),
	CONSTRAINT "bookings_expired_consistency_check" CHECK (status <> 'expired' OR expired_at IS NOT NULL),
	CONSTRAINT "bookings_cancelled_consistency_check" CHECK (status <> 'cancelled' OR cancelled_at IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "booking"."booking_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"booking_id" uuid NOT NULL,
	"from_status" text,
	"to_status" text NOT NULL,
	"actor" text NOT NULL,
	"reason" text,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "booking_events_from_status_check" CHECK (from_status IS NULL OR from_status IN ('held', 'payment_pending', 'confirmed', 'expired', 'cancelled')),
	CONSTRAINT "booking_events_to_status_check" CHECK (to_status IN ('held', 'payment_pending', 'confirmed', 'expired', 'cancelled'))
);
--> statement-breakpoint
ALTER TABLE "booking"."bookings" ADD CONSTRAINT "bookings_customer_user_id_user_id_fk" FOREIGN KEY ("customer_user_id") REFERENCES "identity"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booking"."bookings" ADD CONSTRAINT "bookings_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "catalog"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booking"."bookings" ADD CONSTRAINT "bookings_departure_id_departures_id_fk" FOREIGN KEY ("departure_id") REFERENCES "inventory"."departures"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booking"."bookings" ADD CONSTRAINT "bookings_currency_currencies_code_fk" FOREIGN KEY ("currency") REFERENCES "reference"."currencies"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booking"."booking_events" ADD CONSTRAINT "booking_events_booking_id_bookings_id_fk" FOREIGN KEY ("booking_id") REFERENCES "booking"."bookings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "bookings_due_expiry_idx" ON "booking"."bookings" USING btree ("status","hold_expires_at") WHERE status IN ('held', 'payment_pending');--> statement-breakpoint
CREATE INDEX "bookings_customer_created_idx" ON "booking"."bookings" USING btree ("customer_user_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "bookings_departure_idx" ON "booking"."bookings" USING btree ("departure_id");--> statement-breakpoint
CREATE INDEX "booking_events_booking_at_idx" ON "booking"."booking_events" USING btree ("booking_id","at");
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "booking"."trg_fn_bookings_transition"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
	IF NEW.version <> OLD.version + 1 THEN
		RAISE EXCEPTION 'Booking version must increment strictly on update (expected %, got %)', OLD.version + 1, NEW.version
			USING ERRCODE = 'check_violation';
	END IF;

	IF NEW.id <> OLD.id
		OR NEW.reference <> OLD.reference
		OR NEW.customer_user_id <> OLD.customer_user_id
		OR NEW.product_id <> OLD.product_id
		OR NEW.departure_id <> OLD.departure_id
		OR NEW.allocation_ref <> OLD.allocation_ref
		OR NEW.currency <> OLD.currency
		OR NEW.total_amount_minor <> OLD.total_amount_minor
		OR NEW.snapshot_hash <> OLD.snapshot_hash THEN
		RAISE EXCEPTION 'Booking immutable core attributes cannot be modified'
			USING ERRCODE = 'restrict_violation';
	END IF;

	IF NOT (
		(OLD.status = 'held' AND NEW.status IN ('payment_pending', 'expired', 'cancelled'))
		OR (OLD.status = 'payment_pending' AND NEW.status IN ('confirmed', 'expired', 'cancelled'))
	) THEN
		RAISE EXCEPTION 'Illegal booking status transition from "%" to "%"', OLD.status, NEW.status
			USING ERRCODE = 'check_violation';
	END IF;

	RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "trg_bookings_transition"
BEFORE UPDATE ON "booking"."bookings"
FOR EACH ROW
EXECUTE FUNCTION "booking"."trg_fn_bookings_transition"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "booking"."trg_fn_booking_events_audit"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
	v_actor text;
	v_reason text;
BEGIN
	v_actor := NULLIF(current_setting('booking.actor', true), '');
	v_reason := NULLIF(current_setting('booking.reason', true), '');

	IF TG_OP = 'INSERT' THEN
		INSERT INTO "booking"."booking_events" ("booking_id", "from_status", "to_status", "actor", "reason", "at")
		VALUES (
			NEW.id,
			NULL,
			NEW.status,
			COALESCE(v_actor, 'customer:' || NEW.customer_user_id),
			COALESCE(v_reason, 'hold_created'),
			now()
		);
	ELSIF TG_OP = 'UPDATE' AND NEW.status IS DISTINCT FROM OLD.status THEN
		INSERT INTO "booking"."booking_events" ("booking_id", "from_status", "to_status", "actor", "reason", "at")
		VALUES (
			NEW.id,
			OLD.status,
			NEW.status,
			COALESCE(
				v_actor,
				CASE NEW.status
					WHEN 'expired' THEN 'system:expiry'
					WHEN 'confirmed' THEN 'system:payment'
					ELSE 'customer:' || NEW.customer_user_id
				END
			),
			COALESCE(v_reason, NEW.status),
			now()
		);
	END IF;

	RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "trg_booking_events_audit"
AFTER INSERT OR UPDATE ON "booking"."bookings"
FOR EACH ROW
EXECUTE FUNCTION "booking"."trg_fn_booking_events_audit"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "booking"."trg_fn_prevent_booking_events_mutation"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
	RAISE EXCEPTION '%.% is insert-only and immutable (% is not allowed)', TG_TABLE_SCHEMA, TG_TABLE_NAME, TG_OP
		USING ERRCODE = 'restrict_violation';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "trg_booking_events_immutable"
BEFORE UPDATE OR DELETE ON "booking"."booking_events"
FOR EACH ROW
EXECUTE FUNCTION "booking"."trg_fn_prevent_booking_events_mutation"();
--> statement-breakpoint
CREATE TRIGGER "trg_booking_events_no_truncate"
BEFORE TRUNCATE ON "booking"."booking_events"
FOR EACH STATEMENT
EXECUTE FUNCTION "booking"."trg_fn_prevent_booking_events_mutation"();
