CREATE SCHEMA "pricing";
--> statement-breakpoint
CREATE TABLE "pricing"."cancellation_policies" (
	"id" uuid PRIMARY KEY NOT NULL,
	"product_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"rules" jsonb NOT NULL,
	"weather_clause" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cancellation_policies_product_version_unique" UNIQUE("product_id","version"),
	CONSTRAINT "cancellation_policies_version_check" CHECK (version > 0),
	CONSTRAINT "cancellation_policies_rules_array_check" CHECK (jsonb_typeof(rules) = 'array')
);
--> statement-breakpoint
CREATE TABLE "pricing"."price_list_items" (
	"price_list_id" uuid NOT NULL,
	"pax_type" text NOT NULL,
	"amount_minor" bigint NOT NULL,
	"min_age" smallint NOT NULL,
	"max_age" smallint,
	"occupies_seat" boolean NOT NULL,
	CONSTRAINT "price_list_items_price_list_id_pax_type_pk" PRIMARY KEY("price_list_id","pax_type"),
	CONSTRAINT "price_list_items_pax_type_check" CHECK (pax_type IN ('adult', 'child', 'infant')),
	CONSTRAINT "price_list_items_amount_check" CHECK (amount_minor >= 0),
	CONSTRAINT "price_list_items_age_check" CHECK (min_age >= 0 AND (max_age IS NULL OR max_age >= min_age))
);
--> statement-breakpoint
CREATE TABLE "pricing"."price_lists" (
	"id" uuid PRIMARY KEY NOT NULL,
	"product_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"currency" char(3) NOT NULL,
	"valid_from" date NOT NULL,
	"valid_to" date,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "price_lists_product_version_unique" UNIQUE("product_id","version"),
	CONSTRAINT "price_lists_version_check" CHECK (version > 0),
	CONSTRAINT "price_lists_valid_range_check" CHECK (valid_to IS NULL OR valid_to >= valid_from)
);
--> statement-breakpoint
ALTER TABLE "pricing"."cancellation_policies" ADD CONSTRAINT "cancellation_policies_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "catalog"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pricing"."price_list_items" ADD CONSTRAINT "price_list_items_price_list_id_price_lists_id_fk" FOREIGN KEY ("price_list_id") REFERENCES "pricing"."price_lists"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pricing"."price_lists" ADD CONSTRAINT "price_lists_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "catalog"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pricing"."price_lists" ADD CONSTRAINT "price_lists_currency_currencies_code_fk" FOREIGN KEY ("currency") REFERENCES "reference"."currencies"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "price_lists_product_dates_idx" ON "pricing"."price_lists" USING btree ("product_id","valid_from","valid_to");--> statement-breakpoint
CREATE OR REPLACE FUNCTION "pricing"."trg_fn_price_lists_single_currency"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
	v_existing_currency char(3);
BEGIN
	PERFORM pg_advisory_xact_lock(hashtext('pricing_currency:' || NEW."product_id"::text));
	SELECT "currency"
	INTO v_existing_currency
	FROM "pricing"."price_lists"
	WHERE "product_id" = NEW."product_id"
	LIMIT 1;

	IF v_existing_currency IS NOT NULL AND v_existing_currency <> NEW."currency" THEN
		RAISE EXCEPTION 'Product % currency is locked to % (cannot insert %)', NEW."product_id", v_existing_currency, NEW."currency"
			USING ERRCODE = 'check_violation';
	END IF;

	RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "trg_price_lists_single_currency"
BEFORE INSERT ON "pricing"."price_lists"
FOR EACH ROW
EXECUTE FUNCTION "pricing"."trg_fn_price_lists_single_currency"();--> statement-breakpoint
CREATE OR REPLACE FUNCTION "pricing"."trg_fn_prevent_pricing_mutation"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
	RAISE EXCEPTION '%.% is insert-only and immutable (% is not allowed)', TG_TABLE_SCHEMA, TG_TABLE_NAME, TG_OP
		USING ERRCODE = 'restrict_violation';
END;
$$;--> statement-breakpoint
CREATE TRIGGER "trg_price_lists_immutable"
BEFORE UPDATE OR DELETE ON "pricing"."price_lists"
FOR EACH ROW
EXECUTE FUNCTION "pricing"."trg_fn_prevent_pricing_mutation"();--> statement-breakpoint
CREATE TRIGGER "trg_price_lists_no_truncate"
BEFORE TRUNCATE ON "pricing"."price_lists"
FOR EACH STATEMENT
EXECUTE FUNCTION "pricing"."trg_fn_prevent_pricing_mutation"();--> statement-breakpoint
CREATE TRIGGER "trg_price_list_items_immutable"
BEFORE UPDATE OR DELETE ON "pricing"."price_list_items"
FOR EACH ROW
EXECUTE FUNCTION "pricing"."trg_fn_prevent_pricing_mutation"();--> statement-breakpoint
CREATE TRIGGER "trg_price_list_items_no_truncate"
BEFORE TRUNCATE ON "pricing"."price_list_items"
FOR EACH STATEMENT
EXECUTE FUNCTION "pricing"."trg_fn_prevent_pricing_mutation"();--> statement-breakpoint
CREATE TRIGGER "trg_cancellation_policies_immutable"
BEFORE UPDATE OR DELETE ON "pricing"."cancellation_policies"
FOR EACH ROW
EXECUTE FUNCTION "pricing"."trg_fn_prevent_pricing_mutation"();--> statement-breakpoint
CREATE TRIGGER "trg_cancellation_policies_no_truncate"
BEFORE TRUNCATE ON "pricing"."cancellation_policies"
FOR EACH STATEMENT
EXECUTE FUNCTION "pricing"."trg_fn_prevent_pricing_mutation"();

