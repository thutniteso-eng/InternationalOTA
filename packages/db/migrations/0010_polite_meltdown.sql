CREATE SCHEMA "inventory";
--> statement-breakpoint
CREATE TABLE "inventory"."allocations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"departure_id" uuid NOT NULL,
	"quantity" integer NOT NULL,
	"ref_type" text NOT NULL,
	"ref_id" text NOT NULL,
	"state" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"released_at" timestamp with time zone,
	CONSTRAINT "allocations_departure_ref_unique" UNIQUE("departure_id","ref_type","ref_id"),
	CONSTRAINT "allocations_quantity_check" CHECK (quantity > 0),
	CONSTRAINT "allocations_ref_type_non_empty_check" CHECK (length(trim(ref_type)) > 0),
	CONSTRAINT "allocations_ref_id_non_empty_check" CHECK (length(trim(ref_id)) > 0),
	CONSTRAINT "allocations_state_check" CHECK (state IN ('active', 'released')),
	CONSTRAINT "allocations_released_at_consistency_check" CHECK ((state = 'active' AND released_at IS NULL) OR (state = 'released' AND released_at IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "inventory"."departures" (
	"id" uuid PRIMARY KEY NOT NULL,
	"product_id" uuid NOT NULL,
	"local_date" date NOT NULL,
	"local_time" time NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"capacity" integer NOT NULL,
	"allocated" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"booking_cutoff_minutes" integer DEFAULT 60 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "departures_product_starts_at_unique" UNIQUE("product_id","starts_at"),
	CONSTRAINT "departures_capacity_check" CHECK (capacity > 0),
	CONSTRAINT "departures_allocated_check" CHECK (allocated >= 0 AND allocated <= capacity),
	CONSTRAINT "departures_status_check" CHECK (status IN ('open', 'closed', 'cancelled')),
	CONSTRAINT "departures_cutoff_check" CHECK (booking_cutoff_minutes >= 0)
);
--> statement-breakpoint
ALTER TABLE "inventory"."allocations" ADD CONSTRAINT "allocations_departure_id_departures_id_fk" FOREIGN KEY ("departure_id") REFERENCES "inventory"."departures"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory"."departures" ADD CONSTRAINT "departures_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "catalog"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "allocations_departure_state_idx" ON "inventory"."allocations" USING btree ("departure_id","state");--> statement-breakpoint
CREATE INDEX "departures_product_local_date_idx" ON "inventory"."departures" USING btree ("product_id","local_date","local_time");--> statement-breakpoint
CREATE OR REPLACE FUNCTION "inventory"."verify_allocated"()
RETURNS TABLE (
	"departure_id" uuid,
	"recorded_allocated" integer,
	"actual_active_allocated" bigint
)
LANGUAGE sql
STABLE
AS $$
	SELECT
		d."id" AS "departure_id",
		d."allocated" AS "recorded_allocated",
		COALESCE(SUM(a."quantity") FILTER (WHERE a."state" = 'active'), 0)::bigint AS "actual_active_allocated"
	FROM "inventory"."departures" d
	LEFT JOIN "inventory"."allocations" a ON a."departure_id" = d."id"
	GROUP BY d."id", d."allocated"
	HAVING d."allocated" <> COALESCE(SUM(a."quantity") FILTER (WHERE a."state" = 'active'), 0);
$$;
