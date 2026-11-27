ALTER TABLE "pricing"."price_lists" ADD COLUMN "created_txid" bigint DEFAULT txid_current() NOT NULL;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "pricing"."trg_fn_price_list_items_same_tx"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_created_txid bigint;
BEGIN
  SELECT created_txid
  INTO v_created_txid
  FROM pricing.price_lists
  WHERE id = NEW.price_list_id;

  IF v_created_txid IS NULL THEN
    RAISE EXCEPTION 'Price list % does not exist', NEW.price_list_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  IF v_created_txid <> txid_current() THEN
    RAISE EXCEPTION 'Cannot append price list items to committed price list % in a later transaction', NEW.price_list_id
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "trg_price_list_items_same_tx"
BEFORE INSERT ON "pricing"."price_list_items"
FOR EACH ROW
EXECUTE FUNCTION "pricing"."trg_fn_price_list_items_same_tx"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "pricing"."trg_fn_price_lists_require_adult"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pricing.price_list_items
    WHERE price_list_id = NEW.id
      AND pax_type = 'adult'
  ) THEN
    RAISE EXCEPTION 'Price list % must include an adult item', NEW.id
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "trg_price_lists_require_adult"
AFTER INSERT ON "pricing"."price_lists"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION "pricing"."trg_fn_price_lists_require_adult"();
