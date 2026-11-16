CREATE TABLE "ballots" (
	"tenant_id" text NOT NULL,
	"case_id" text NOT NULL,
	"seq" integer NOT NULL,
	"juror_id" text NOT NULL,
	"question" text NOT NULL,
	"ballot" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ballots_tenant_id_case_id_seq_pk" PRIMARY KEY("tenant_id","case_id","seq"),
	CONSTRAINT "ballots_blob_matches" CHECK ("ballots"."ballot"->>'jurorId' = "ballots"."juror_id" and "ballots"."ballot"->>'question' = "ballots"."question")
);
--> statement-breakpoint
ALTER TABLE "ballots" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "cases" (
	"tenant_id" text NOT NULL,
	"id" text NOT NULL,
	"repo_id" text NOT NULL,
	"case_file" jsonb NOT NULL,
	"stage" text DEFAULT 'intake' NOT NULL,
	"candidate_score" double precision NOT NULL,
	"escalation_floor" double precision NOT NULL,
	"remaining_input_tokens" bigint NOT NULL,
	"remaining_output_tokens" bigint NOT NULL,
	"remaining_usd" numeric(24, 6) NOT NULL,
	"exhausted" boolean DEFAULT false NOT NULL,
	"appeals" integer DEFAULT 0 NOT NULL,
	"seq" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cases_tenant_id_id_pk" PRIMARY KEY("tenant_id","id"),
	CONSTRAINT "cases_stage_valid" CHECK ("cases"."stage" in ('intake', 'map', 'arraign', 'defense', 'prosecution', 'remedy', 'verify', 'jury', 'verdict', 'dismissed', 'escalated')),
	CONSTRAINT "cases_file_matches" CHECK ("cases"."case_file"->>'id' = "cases"."id"
        and "cases"."case_file"->>'tenantId' = "cases"."tenant_id"
        and ("cases"."case_file"->'candidate'->>'score')::double precision = "cases"."candidate_score"
        and ("cases"."case_file"->>'escalationFloor')::double precision = "cases"."escalation_floor"),
	CONSTRAINT "cases_budget_finite" CHECK ("cases"."remaining_usd" <> 'NaN'::numeric)
);
--> statement-breakpoint
ALTER TABLE "cases" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "cost_rows" (
	"tenant_id" text NOT NULL,
	"case_id" text NOT NULL,
	"id" bigint GENERATED ALWAYS AS IDENTITY (sequence name "cost_rows_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"stage" text NOT NULL,
	"attempt" integer NOT NULL,
	"input_tokens" bigint NOT NULL,
	"output_tokens" bigint NOT NULL,
	"usd" numeric(24, 9) NOT NULL,
	"wall_ms" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cost_rows_tenant_id_case_id_id_pk" PRIMARY KEY("tenant_id","case_id","id"),
	CONSTRAINT "cost_rows_stage_valid" CHECK ("cost_rows"."stage" in ('intake', 'map', 'arraign', 'defense', 'prosecution', 'remedy', 'verify', 'jury', 'verdict', 'dismissed', 'escalated')),
	CONSTRAINT "cost_rows_values_valid" CHECK ("cost_rows"."attempt" >= 1 and "cost_rows"."input_tokens" >= 0 and "cost_rows"."output_tokens" >= 0 and "cost_rows"."usd" >= 0 and "cost_rows"."usd" <> 'NaN'::numeric and "cost_rows"."wall_ms" >= 0)
);
--> statement-breakpoint
ALTER TABLE "cost_rows" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "escalations" (
	"tenant_id" text NOT NULL,
	"case_id" text NOT NULL,
	"seq" integer NOT NULL,
	"reason" text NOT NULL,
	"detail" text NOT NULL,
	"escalation" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "escalations_tenant_id_case_id_seq_pk" PRIMARY KEY("tenant_id","case_id","seq"),
	CONSTRAINT "escalations_blob_matches" CHECK ("escalations"."escalation"->>'caseId' = "escalations"."case_id" and "escalations"."escalation"->>'reason' = "escalations"."reason")
);
--> statement-breakpoint
ALTER TABLE "escalations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "events" (
	"tenant_id" text NOT NULL,
	"case_id" text NOT NULL,
	"seq" integer NOT NULL,
	"type" text NOT NULL,
	"event" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "events_tenant_id_case_id_seq_pk" PRIMARY KEY("tenant_id","case_id","seq"),
	CONSTRAINT "events_blob_matches" CHECK ("events"."event"->>'type' = "events"."type" and "events"."event"->>'caseId' = "events"."case_id"
        and ("events"."event"->>'seq')::int = "events"."seq")
);
--> statement-breakpoint
ALTER TABLE "events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "exhibits" (
	"tenant_id" text NOT NULL,
	"case_id" text NOT NULL,
	"id" text NOT NULL,
	"kind" text NOT NULL,
	"author" text NOT NULL,
	"sha256" text NOT NULL,
	"exhibit" jsonb NOT NULL,
	"result" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "exhibits_tenant_id_case_id_id_pk" PRIMARY KEY("tenant_id","case_id","id"),
	CONSTRAINT "exhibits_kind_valid" CHECK ("exhibits"."kind" in ('witness', 'counterexample', 'patch')),
	CONSTRAINT "exhibits_blob_matches" CHECK ("exhibits"."exhibit"->>'id' = "exhibits"."id" and "exhibits"."exhibit"->>'caseId' = "exhibits"."case_id"
        and "exhibits"."exhibit"->>'kind' = "exhibits"."kind" and "exhibits"."exhibit"->>'author' = "exhibits"."author"
        and "exhibits"."exhibit"->>'sha256' = "exhibits"."sha256"),
	CONSTRAINT "exhibits_result_valid" CHECK ("exhibits"."result" is null or (jsonb_typeof("exhibits"."result") = 'object' and "exhibits"."result"->>'exhibitId' = "exhibits"."id"))
);
--> statement-breakpoint
ALTER TABLE "exhibits" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "repos" (
	"tenant_id" text NOT NULL,
	"id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "repos_tenant_id_id_pk" PRIMARY KEY("tenant_id","id")
);
--> statement-breakpoint
ALTER TABLE "repos" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "stage_jobs" (
	"tenant_id" text NOT NULL,
	"case_id" text NOT NULL,
	"stage" text NOT NULL,
	"attempt" integer NOT NULL,
	"visit" integer NOT NULL,
	"enqueued_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stage_jobs_tenant_id_case_id_stage_attempt_pk" PRIMARY KEY("tenant_id","case_id","stage","attempt"),
	CONSTRAINT "stage_jobs_stage_valid" CHECK ("stage_jobs"."stage" in ('intake', 'map', 'arraign', 'defense', 'prosecution', 'remedy', 'verify', 'jury', 'verdict', 'dismissed', 'escalated')),
	CONSTRAINT "stage_jobs_attempt_valid" CHECK ("stage_jobs"."attempt" >= 1)
);
--> statement-breakpoint
ALTER TABLE "stage_jobs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "stage_runs" (
	"tenant_id" text NOT NULL,
	"case_id" text NOT NULL,
	"stage" text NOT NULL,
	"attempt" integer NOT NULL,
	"visit" integer NOT NULL,
	"worker_id" text NOT NULL,
	"lease_token" text DEFAULT gen_random_uuid()::text NOT NULL,
	"claimed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"heartbeat_at" timestamp with time zone DEFAULT now() NOT NULL,
	"lease_expires_at" timestamp with time zone NOT NULL,
	"completed_at" timestamp with time zone,
	"failed_at" timestamp with time zone,
	"error" text,
	CONSTRAINT "stage_runs_tenant_id_case_id_stage_attempt_pk" PRIMARY KEY("tenant_id","case_id","stage","attempt"),
	CONSTRAINT "stage_runs_stage_valid" CHECK ("stage_runs"."stage" in ('intake', 'map', 'arraign', 'defense', 'prosecution', 'remedy', 'verify', 'jury', 'verdict', 'dismissed', 'escalated')),
	CONSTRAINT "stage_runs_attempt_valid" CHECK ("stage_runs"."attempt" >= 1)
);
--> statement-breakpoint
ALTER TABLE "stage_runs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "stages" (
	"tenant_id" text NOT NULL,
	"case_id" text NOT NULL,
	"ordinal" integer NOT NULL,
	"stage" text NOT NULL,
	"entered_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stages_tenant_id_case_id_ordinal_pk" PRIMARY KEY("tenant_id","case_id","ordinal"),
	CONSTRAINT "stages_stage_valid" CHECK ("stages"."stage" in ('intake', 'map', 'arraign', 'defense', 'prosecution', 'remedy', 'verify', 'jury', 'verdict', 'dismissed', 'escalated'))
);
--> statement-breakpoint
ALTER TABLE "stages" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "tenants" (
	"tenant_id" text PRIMARY KEY NOT NULL,
	"name" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "tenants" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "verdicts" (
	"tenant_id" text NOT NULL,
	"case_id" text NOT NULL,
	"outcome" text NOT NULL,
	"verdict" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "verdicts_tenant_id_case_id_pk" PRIMARY KEY("tenant_id","case_id"),
	CONSTRAINT "verdicts_blob_matches" CHECK ("verdicts"."verdict"->>'caseId' = "verdicts"."case_id" and "verdicts"."verdict"->>'outcome' = "verdicts"."outcome")
);
--> statement-breakpoint
ALTER TABLE "verdicts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "ballots" ADD CONSTRAINT "ballots_tenant_id_case_id_cases_tenant_id_id_fk" FOREIGN KEY ("tenant_id","case_id") REFERENCES "public"."cases"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cases" ADD CONSTRAINT "cases_tenant_id_repo_id_repos_tenant_id_id_fk" FOREIGN KEY ("tenant_id","repo_id") REFERENCES "public"."repos"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cost_rows" ADD CONSTRAINT "cost_rows_tenant_id_case_id_cases_tenant_id_id_fk" FOREIGN KEY ("tenant_id","case_id") REFERENCES "public"."cases"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "escalations" ADD CONSTRAINT "escalations_tenant_id_case_id_cases_tenant_id_id_fk" FOREIGN KEY ("tenant_id","case_id") REFERENCES "public"."cases"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_tenant_id_case_id_cases_tenant_id_id_fk" FOREIGN KEY ("tenant_id","case_id") REFERENCES "public"."cases"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exhibits" ADD CONSTRAINT "exhibits_tenant_id_case_id_cases_tenant_id_id_fk" FOREIGN KEY ("tenant_id","case_id") REFERENCES "public"."cases"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repos" ADD CONSTRAINT "repos_tenant_id_tenants_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("tenant_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stage_jobs" ADD CONSTRAINT "stage_jobs_tenant_id_case_id_cases_tenant_id_id_fk" FOREIGN KEY ("tenant_id","case_id") REFERENCES "public"."cases"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stage_runs" ADD CONSTRAINT "stage_runs_tenant_id_case_id_cases_tenant_id_id_fk" FOREIGN KEY ("tenant_id","case_id") REFERENCES "public"."cases"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stages" ADD CONSTRAINT "stages_tenant_id_case_id_cases_tenant_id_id_fk" FOREIGN KEY ("tenant_id","case_id") REFERENCES "public"."cases"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verdicts" ADD CONSTRAINT "verdicts_tenant_id_case_id_cases_tenant_id_id_fk" FOREIGN KEY ("tenant_id","case_id") REFERENCES "public"."cases"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "events_case_idx" ON "events" USING btree ("tenant_id","case_id");