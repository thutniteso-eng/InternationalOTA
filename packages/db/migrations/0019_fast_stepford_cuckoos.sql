CREATE SCHEMA "ops";
--> statement-breakpoint
CREATE TABLE "ops"."admin_audit" (
	"id" uuid PRIMARY KEY NOT NULL,
	"actor_user_id" text NOT NULL,
	"action" text NOT NULL,
	"target_type" text NOT NULL,
	"target_id" text NOT NULL,
	"reason" text,
	"request_id" text,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ops"."reconciliation_findings" (
	"id" uuid PRIMARY KEY NOT NULL,
	"run_id" uuid NOT NULL,
	"code" text NOT NULL,
	"severity" text NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" text NOT NULL,
	"details" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reconciliation_findings_severity_check" CHECK (severity IN ('error', 'warning'))
);
--> statement-breakpoint
CREATE TABLE "ops"."reconciliation_runs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"as_of" timestamp with time zone NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"counts" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"triggered_by" text NOT NULL,
	CONSTRAINT "reconciliation_runs_status_check" CHECK (status IN ('running', 'ok', 'warnings', 'errors', 'failed')),
	CONSTRAINT "reconciliation_runs_finished_consistency_check" CHECK ((status = 'running' AND finished_at IS NULL) OR (status <> 'running' AND finished_at IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "ops"."reconciliation_findings" ADD CONSTRAINT "reconciliation_findings_run_id_reconciliation_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "ops"."reconciliation_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "admin_audit_at_idx" ON "ops"."admin_audit" USING btree ("at","id");--> statement-breakpoint
CREATE INDEX "admin_audit_target_idx" ON "ops"."admin_audit" USING btree ("target_type","target_id","at");--> statement-breakpoint
CREATE INDEX "reconciliation_findings_run_idx" ON "ops"."reconciliation_findings" USING btree ("run_id","severity","code");--> statement-breakpoint
CREATE INDEX "reconciliation_runs_started_idx" ON "ops"."reconciliation_runs" USING btree ("started_at","id");