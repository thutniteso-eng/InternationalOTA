CREATE TABLE "platform"."inbox_messages" (
	"provider" text NOT NULL,
	"provider_event_id" text NOT NULL,
	"payload" jsonb NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_error" text,
	"dead_lettered_at" timestamp with time zone,
	CONSTRAINT "inbox_messages_provider_provider_event_id_pk" PRIMARY KEY("provider","provider_event_id")
);
--> statement-breakpoint
CREATE TABLE "platform"."outbox_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"aggregate_type" text NOT NULL,
	"aggregate_id" text NOT NULL,
	"event_type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"published_at" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_error" text,
	"dead_lettered_at" timestamp with time zone
);
--> statement-breakpoint
CREATE INDEX "inbox_messages_pending_idx" ON "platform"."inbox_messages" USING btree ("next_attempt_at","received_at") WHERE processed_at IS NULL AND dead_lettered_at IS NULL;--> statement-breakpoint
CREATE INDEX "outbox_events_pending_idx" ON "platform"."outbox_events" USING btree ("next_attempt_at","occurred_at") WHERE published_at IS NULL AND dead_lettered_at IS NULL;