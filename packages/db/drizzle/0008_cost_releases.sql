CREATE TABLE "cost_releases" (
	"tenant_id" text NOT NULL,
	"case_id" text NOT NULL,
	"reservation_seq" integer NOT NULL,
	"stage" text NOT NULL,
	"attempt" integer NOT NULL,
	"input_tokens" bigint NOT NULL,
	"output_tokens" bigint NOT NULL,
	"usd" numeric(24, 9) NOT NULL,
	"wall_ms" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cost_releases_tenant_id_case_id_reservation_seq_pk" PRIMARY KEY("tenant_id","case_id","reservation_seq"),
	CONSTRAINT "cost_releases_stage_valid" CHECK ("cost_releases"."stage" in ('intake', 'map', 'arraign', 'defense', 'prosecution', 'remedy', 'verify', 'jury', 'verdict', 'dismissed', 'escalated')),
	CONSTRAINT "cost_releases_values_valid" CHECK ("cost_releases"."reservation_seq" >= 0 and "cost_releases"."attempt" >= 1 and "cost_releases"."input_tokens" >= 0 and "cost_releases"."output_tokens" >= 0 and "cost_releases"."usd" >= 0 and "cost_releases"."usd" <> 'NaN'::numeric and "cost_releases"."wall_ms" >= 0)
);
--> statement-breakpoint
ALTER TABLE "cost_releases" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "cost_releases" ADD CONSTRAINT "cost_releases_tenant_id_case_id_cases_tenant_id_id_fk" FOREIGN KEY ("tenant_id","case_id") REFERENCES "public"."cases"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cost_releases" ADD CONSTRAINT "cost_releases_charge_event_fk" FOREIGN KEY ("tenant_id","case_id","reservation_seq") REFERENCES "public"."events"("tenant_id","case_id","seq") ON DELETE no action ON UPDATE no action;