CREATE SCHEMA "notifications";
--> statement-breakpoint
CREATE TABLE "notifications"."email_messages" (
	"id" uuid PRIMARY KEY NOT NULL,
	"event_id" uuid NOT NULL,
	"template" text NOT NULL,
	"recipient_hash" char(64) NOT NULL,
	"locale" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_error" text,
	"provider_message_id" text,
	"sent_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "email_messages_event_template_unique" UNIQUE("event_id","template"),
	CONSTRAINT "email_messages_status_check" CHECK (status IN ('queued', 'sent', 'failed', 'dead')),
	CONSTRAINT "email_messages_template_check" CHECK (template IN ('booking_held', 'booking_confirmed', 'booking_expired', 'booking_cancelled', 'refund_succeeded')),
	CONSTRAINT "email_messages_recipient_hash_check" CHECK (recipient_hash ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "email_messages_attempts_non_negative_check" CHECK (attempts >= 0),
	CONSTRAINT "email_messages_version_positive_check" CHECK (version > 0),
	CONSTRAINT "email_messages_sent_at_consistency_check" CHECK ((status = 'sent' AND sent_at IS NOT NULL) OR (status <> 'sent' AND sent_at IS NULL))
);
--> statement-breakpoint
ALTER TABLE "notifications"."email_messages" ADD CONSTRAINT "email_messages_event_id_outbox_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "platform"."outbox_events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "email_messages_status_next_attempt_idx" ON "notifications"."email_messages" USING btree ("status","next_attempt_at");--> statement-breakpoint
CREATE OR REPLACE FUNCTION "notifications"."trg_fn_email_messages_transition"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
	IF NEW.version IS DISTINCT FROM OLD.version + 1 THEN
		RAISE EXCEPTION 'Email message version must increment strictly on update (expected %, got %)', OLD.version + 1, NEW.version
			USING ERRCODE = 'check_violation';
	END IF;

	IF NEW.id IS DISTINCT FROM OLD.id
		OR NEW.event_id IS DISTINCT FROM OLD.event_id
		OR NEW.template IS DISTINCT FROM OLD.template
		OR NEW.recipient_hash IS DISTINCT FROM OLD.recipient_hash
		OR NEW.locale IS DISTINCT FROM OLD.locale
		OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
		RAISE EXCEPTION 'Email message immutable core attributes cannot be modified'
			USING ERRCODE = 'restrict_violation';
	END IF;

	IF NOT (
		(OLD.status = 'queued' AND NEW.status IN ('queued', 'sent', 'failed', 'dead'))
		OR (OLD.status = 'failed' AND NEW.status IN ('failed', 'sent', 'dead'))
	) THEN
		RAISE EXCEPTION 'Illegal email message status transition from "%" to "%"', OLD.status, NEW.status
			USING ERRCODE = 'check_violation';
	END IF;

	IF NEW.provider_message_id IS DISTINCT FROM OLD.provider_message_id
		AND NOT (NEW.status = 'sent' AND OLD.provider_message_id IS NULL) THEN
		RAISE EXCEPTION 'Email message provider_message_id can only be set on transition to sent'
			USING ERRCODE = 'restrict_violation';
	END IF;

	RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "trg_email_messages_transition"
BEFORE UPDATE ON "notifications"."email_messages"
FOR EACH ROW
EXECUTE FUNCTION "notifications"."trg_fn_email_messages_transition"();
