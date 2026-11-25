CREATE TABLE "platform"."idempotency_keys" (
	"scope" text NOT NULL,
	"key" text NOT NULL,
	"request_hash" char(64) NOT NULL,
	"state" text NOT NULL,
	"response_status" smallint,
	"response_body" jsonb,
	"locked_until" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "idempotency_keys_scope_key_pk" PRIMARY KEY("scope","key"),
	CONSTRAINT "idempotency_keys_state_check" CHECK (state IN ('in_progress', 'completed'))
);
