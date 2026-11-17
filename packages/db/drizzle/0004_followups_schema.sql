-- Rows written before visits were stored get 0, which matches every visit of their stage.
ALTER TABLE "review_flags" ADD COLUMN "visit" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "review_flags" ALTER COLUMN "visit" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "stages" ADD COLUMN "entry_seq" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "cases" ADD CONSTRAINT "cases_repo_matches" CHECK ("cases"."case_file"->'target'->>'repo' is not distinct from "cases"."repo_id");--> statement-breakpoint
ALTER TABLE "escalations" ADD CONSTRAINT "escalations_detail_matches" CHECK ("escalations"."escalation"->>'detail' is not distinct from "escalations"."detail");--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_verdict_case_matches" CHECK ("events"."type" <> 'verdict-written'
        or "events"."event"->'payload'->'verdict'->>'caseId' is not distinct from "events"."case_id");--> statement-breakpoint
ALTER TABLE "review_flags" ADD CONSTRAINT "review_flags_visit_valid" CHECK ("review_flags"."visit" >= 0);