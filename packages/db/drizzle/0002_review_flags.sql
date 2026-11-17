CREATE TABLE "review_flags" (
	"tenant_id" text NOT NULL,
	"case_id" text NOT NULL,
	"stage" text NOT NULL,
	"attempt" integer NOT NULL,
	"reason" text NOT NULL,
	"detail" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "review_flags_tenant_id_case_id_stage_attempt_pk" PRIMARY KEY("tenant_id","case_id","stage","attempt"),
	CONSTRAINT "review_flags_stage_valid" CHECK ("review_flags"."stage" in ('intake', 'map', 'arraign', 'defense', 'prosecution', 'remedy', 'verify', 'jury', 'verdict', 'dismissed', 'escalated')),
	CONSTRAINT "review_flags_reason_valid" CHECK ("review_flags"."reason" in ('attempts-exhausted', 'budget-exhausted'))
);
--> statement-breakpoint
ALTER TABLE "review_flags" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "review_flags" ADD CONSTRAINT "review_flags_tenant_id_case_id_cases_tenant_id_id_fk" FOREIGN KEY ("tenant_id","case_id") REFERENCES "public"."cases"("tenant_id","id") ON DELETE no action ON UPDATE no action;