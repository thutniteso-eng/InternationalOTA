CREATE SCHEMA "reference";
--> statement-breakpoint
CREATE TABLE "reference"."countries" (
	"alpha2" char(2) PRIMARY KEY NOT NULL,
	"alpha3" char(3) NOT NULL,
	"numeric" char(3) NOT NULL,
	"name_en" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "countries_alpha3_unique" UNIQUE("alpha3"),
	CONSTRAINT "countries_numeric_unique" UNIQUE("numeric")
);
--> statement-breakpoint
CREATE TABLE "reference"."currencies" (
	"code" char(3) PRIMARY KEY NOT NULL,
	"numeric" char(3),
	"minor_units" smallint,
	"name_en" text NOT NULL,
	"enabled_for_sale" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reference"."languages" (
	"tag" text PRIMARY KEY NOT NULL,
	"name_en" text NOT NULL,
	"name_native" text NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reference"."time_zones" (
	"name" text PRIMARY KEY NOT NULL,
	"country_alpha2" char(2),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "reference"."time_zones" ADD CONSTRAINT "time_zones_country_alpha2_countries_alpha2_fk" FOREIGN KEY ("country_alpha2") REFERENCES "reference"."countries"("alpha2") ON DELETE no action ON UPDATE no action;