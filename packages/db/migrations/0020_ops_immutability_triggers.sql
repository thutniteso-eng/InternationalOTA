CREATE OR REPLACE FUNCTION "ops"."trg_fn_append_only"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
	RAISE EXCEPTION 'Table %.% is append-only: % is forbidden', TG_TABLE_SCHEMA, TG_TABLE_NAME, TG_OP
		USING ERRCODE = 'restrict_violation';
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "ops"."trg_fn_reconciliation_runs_update_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
	IF OLD.status IS DISTINCT FROM 'running' THEN
		RAISE EXCEPTION 'Completed reconciliation run (%) cannot be modified from status "%"', OLD.id, OLD.status
			USING ERRCODE = 'restrict_violation';
	END IF;

	IF NEW.status NOT IN ('ok', 'warnings', 'errors', 'failed') THEN
		RAISE EXCEPTION 'Invalid reconciliation run transition: % -> %', OLD.status, NEW.status
			USING ERRCODE = 'check_violation';
	END IF;

	IF NEW.finished_at IS NULL THEN
		RAISE EXCEPTION 'Finished reconciliation run must set finished_at'
			USING ERRCODE = 'check_violation';
	END IF;

	IF NEW.id IS DISTINCT FROM OLD.id
		OR NEW.started_at IS DISTINCT FROM OLD.started_at
		OR NEW.as_of IS DISTINCT FROM OLD.as_of
		OR NEW.triggered_by IS DISTINCT FROM OLD.triggered_by THEN
		RAISE EXCEPTION 'Immutable columns on ops.reconciliation_runs cannot be modified'
			USING ERRCODE = 'restrict_violation';
	END IF;

	RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "trg_reconciliation_runs_no_delete"
BEFORE DELETE ON "ops"."reconciliation_runs"
FOR EACH ROW
EXECUTE FUNCTION "ops"."trg_fn_append_only"();
--> statement-breakpoint
CREATE TRIGGER "trg_reconciliation_runs_update_guard"
BEFORE UPDATE ON "ops"."reconciliation_runs"
FOR EACH ROW
EXECUTE FUNCTION "ops"."trg_fn_reconciliation_runs_update_guard"();
--> statement-breakpoint
CREATE TRIGGER "trg_reconciliation_findings_append_only"
BEFORE UPDATE OR DELETE ON "ops"."reconciliation_findings"
FOR EACH ROW
EXECUTE FUNCTION "ops"."trg_fn_append_only"();
--> statement-breakpoint
CREATE TRIGGER "trg_admin_audit_append_only"
BEFORE UPDATE OR DELETE ON "ops"."admin_audit"
FOR EACH ROW
EXECUTE FUNCTION "ops"."trg_fn_append_only"();
