CREATE EXTENSION IF NOT EXISTS postgis;
--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS unaccent;
--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS pg_trgm;
--> statement-breakpoint
CREATE SCHEMA "catalog";
--> statement-breakpoint
CREATE SCHEMA "supply";
--> statement-breakpoint
CREATE TABLE "catalog"."product_images" (
	"id" uuid PRIMARY KEY NOT NULL,
	"product_id" uuid NOT NULL,
	"url" text NOT NULL,
	"sort" smallint DEFAULT 0 NOT NULL,
	"alt" jsonb NOT NULL,
	CONSTRAINT "product_images_https_url_check" CHECK (url ~ '^https://'),
	CONSTRAINT "product_images_sort_check" CHECK (sort >= 0 AND sort < 20),
	CONSTRAINT "product_images_alt_object_check" CHECK (jsonb_typeof(alt) = 'object')
);
--> statement-breakpoint
CREATE TABLE "catalog"."product_translations" (
	"product_id" uuid NOT NULL,
	"locale" text NOT NULL,
	"title" text NOT NULL,
	"slug" text NOT NULL,
	"summary" text NOT NULL,
	"description" text NOT NULL,
	"highlights" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"inclusions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"exclusions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	CONSTRAINT "product_translations_product_id_locale_pk" PRIMARY KEY("product_id","locale"),
	CONSTRAINT "product_translations_locale_slug_unique" UNIQUE("locale","slug"),
	CONSTRAINT "product_translations_slug_format_check" CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
	CONSTRAINT "product_translations_arrays_check" CHECK (jsonb_typeof(highlights) = 'array' AND jsonb_typeof(inclusions) = 'array' AND jsonb_typeof(exclusions) = 'array')
);
--> statement-breakpoint
CREATE TABLE "catalog"."products" (
	"id" uuid PRIMARY KEY NOT NULL,
	"supplier_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"country_alpha2" char(2) NOT NULL,
	"region" text NOT NULL,
	"location" geography(Point,4326),
	"meeting_point_note" text,
	"time_zone" text DEFAULT 'Asia/Ho_Chi_Minh' NOT NULL,
	"duration_minutes" integer,
	"published_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "products_kind_check" CHECK (kind IN ('tour', 'activity', 'transfer')),
	CONSTRAINT "products_status_check" CHECK (status IN ('draft', 'published', 'archived')),
	CONSTRAINT "products_duration_minutes_check" CHECK (duration_minutes IS NULL OR duration_minutes > 0),
	CONSTRAINT "products_time_zone_non_empty_check" CHECK (length(trim(time_zone)) > 0)
);
--> statement-breakpoint
CREATE TABLE "supply"."suppliers" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"legal_name" text,
	"country_alpha2" char(2) NOT NULL,
	"contact_email" text,
	"contact_phone" text,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "suppliers_status_check" CHECK (status IN ('active', 'suspended'))
);
--> statement-breakpoint
ALTER TABLE "catalog"."product_images" ADD CONSTRAINT "product_images_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "catalog"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog"."product_translations" ADD CONSTRAINT "product_translations_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "catalog"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog"."product_translations" ADD CONSTRAINT "product_translations_locale_languages_tag_fk" FOREIGN KEY ("locale") REFERENCES "reference"."languages"("tag") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog"."products" ADD CONSTRAINT "products_supplier_id_suppliers_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "supply"."suppliers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog"."products" ADD CONSTRAINT "products_country_alpha2_countries_alpha2_fk" FOREIGN KEY ("country_alpha2") REFERENCES "reference"."countries"("alpha2") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supply"."suppliers" ADD CONSTRAINT "suppliers_country_alpha2_countries_alpha2_fk" FOREIGN KEY ("country_alpha2") REFERENCES "reference"."countries"("alpha2") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "product_images_product_sort_idx" ON "catalog"."product_images" USING btree ("product_id","sort");--> statement-breakpoint
CREATE INDEX "products_published_listing_idx" ON "catalog"."products" USING btree ("status","published_at","id");--> statement-breakpoint
CREATE INDEX "products_supplier_idx" ON "catalog"."products" USING btree ("supplier_id");
--> statement-breakpoint
CREATE INDEX "products_location_gist_idx" ON "catalog"."products" USING gist ("location");
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "catalog"."immutable_unaccent"(text)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
STRICT
AS $$
  SELECT public.unaccent('public.unaccent'::regdictionary, $1);
$$;
--> statement-breakpoint
CREATE INDEX "product_translations_search_trgm_idx" ON "catalog"."product_translations" USING gin ("catalog"."immutable_unaccent"(lower("title" || ' ' || "summary")) gin_trgm_ops);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "catalog"."trg_fn_product_images_max_20"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_count integer;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext(NEW.product_id::text));
  SELECT COUNT(*) INTO v_count FROM "catalog"."product_images" WHERE "product_id" = NEW.product_id;
  IF v_count >= 20 THEN
    RAISE EXCEPTION 'Product % already has maximum 20 images', NEW.product_id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "trg_product_images_max_20"
BEFORE INSERT ON "catalog"."product_images"
FOR EACH ROW
EXECUTE FUNCTION "catalog"."trg_fn_product_images_max_20"();