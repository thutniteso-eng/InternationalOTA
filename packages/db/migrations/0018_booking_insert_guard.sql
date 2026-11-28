CREATE OR REPLACE FUNCTION "booking"."trg_fn_bookings_insert_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
	IF NEW.status IS DISTINCT FROM 'held' THEN
		RAISE EXCEPTION 'New bookings must be inserted with status "held" (got "%")', NEW.status
			USING ERRCODE = 'check_violation';
	END IF;

	IF NEW.version IS DISTINCT FROM 1 THEN
		RAISE EXCEPTION 'New bookings must start at version 1 (got %)', NEW.version
			USING ERRCODE = 'check_violation';
	END IF;

	IF NEW.payment_ref IS NOT NULL
		OR NEW.confirmed_at IS NOT NULL
		OR NEW.expired_at IS NOT NULL
		OR NEW.cancelled_at IS NOT NULL THEN
		RAISE EXCEPTION 'New bookings cannot pre-populate payment_ref or terminal timestamps'
			USING ERRCODE = 'restrict_violation';
	END IF;

	IF NEW.hold_expires_at IS NULL OR NEW.hold_expires_at <= now() THEN
		RAISE EXCEPTION 'New booking hold_expires_at must be strictly in the future (now())'
			USING ERRCODE = 'check_violation';
	END IF;

	RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "trg_bookings_insert_guard"
BEFORE INSERT ON "booking"."bookings"
FOR EACH ROW
EXECUTE FUNCTION "booking"."trg_fn_bookings_insert_guard"();
