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
	) THEN
		RAISE EXCEPTION 'Illegal booking status transition from "%" to "%"', OLD.status, NEW.status
			USING ERRCODE = 'check_violation';
	END IF;

	IF NEW.payment_ref IS DISTINCT FROM OLD.payment_ref
		AND NOT (NEW.status = 'confirmed' AND OLD.payment_ref IS NULL AND NEW.payment_ref IS NOT NULL) THEN
		RAISE EXCEPTION 'Booking payment_ref can only change from NULL to a value on transition to confirmed'
			USING ERRCODE = 'restrict_violation';
	END IF;

	IF NEW.status <> 'confirmed' AND (NEW.payment_ref IS NOT NULL OR NEW.confirmed_at IS NOT NULL) THEN
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
$$;
