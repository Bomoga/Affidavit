-- Security for cost_releases (contracts v1.2, CR-T1: CaseStore.releaseCharge).
-- A release gives back the unspent part of one up-front charge. Charges (cost_rows) are never
-- updated or deleted: a release is its own insert-only row, keyed by the seq of the cost-charged
-- event it releases, and the budget is read net of releases (case_budgets below). cases keeps its
-- gross columns, so cases_guard ("budget only decreases", "exhaustion never clears") is unchanged.
--
-- cost_releases: tenant isolation under forced RLS, SELECT and INSERT only for the application role,
-- append-only triggers, and an insert guard that checks the row against the charge event and the
-- case-wide totals under a lock on the case row. PgCaseStore.releaseCharge makes the same checks
-- first (for a precise ReleaseRejectedError); the guard is the backstop for raw SQL.
ALTER TABLE public.cost_releases FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.cost_releases FOR ALL TO affidavit_app
  USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
--> statement-breakpoint
GRANT SELECT, INSERT ON public.cost_releases TO affidavit_app;
--> statement-breakpoint
CREATE TRIGGER cost_releases_append_only BEFORE UPDATE OR DELETE ON public.cost_releases
  FOR EACH ROW EXECUTE FUNCTION reject_mutation();
--> statement-breakpoint
CREATE TRIGGER cost_releases_no_truncate BEFORE TRUNCATE ON public.cost_releases
  FOR EACH STATEMENT EXECUTE FUNCTION reject_mutation();
--> statement-breakpoint
-- Runs as the inserting role, so RLS applies to every lookup. Every refusal message starts with
-- 'cost release rejected:' (the store maps it to ReleaseRejectedError).
CREATE FUNCTION cost_releases_insert_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public
  AS $$
DECLARE
  v_stage text;
  v_type text;
  v_cost jsonb;
  ch_in numeric;
  ch_out numeric;
  ch_usd numeric;
  rel_in numeric;
  rel_out numeric;
  rel_usd numeric;
BEGIN
  -- Serialise every release (and charge: chargeBudget takes the same lock) of this case.
  SELECT c.stage INTO v_stage FROM public.cases c
    WHERE c.tenant_id = NEW.tenant_id AND c.id = NEW.case_id
    FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'cost release rejected: unknown case' USING ERRCODE = 'foreign_key_violation';
  END IF;
  IF v_stage IN ('verdict', 'dismissed', 'escalated') OR EXISTS (
    SELECT 1 FROM public.verdicts v WHERE v.tenant_id = NEW.tenant_id AND v.case_id = NEW.case_id
  ) THEN
    RAISE EXCEPTION 'cost release rejected: the case is closed' USING ERRCODE = 'check_violation';
  END IF;
  SELECT e.type, e.event->'payload'->'cost' INTO v_type, v_cost FROM public.events e
    WHERE e.tenant_id = NEW.tenant_id AND e.case_id = NEW.case_id AND e.seq = NEW.reservation_seq;
  IF v_type IS DISTINCT FROM 'cost-charged' OR jsonb_typeof(v_cost) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'cost release rejected: no cost-charged event at seq %', NEW.reservation_seq
      USING ERRCODE = 'check_violation';
  END IF;
  IF v_cost->>'stage' IS DISTINCT FROM NEW.stage
     OR (v_cost->>'attempt')::integer IS DISTINCT FROM NEW.attempt THEN
    RAISE EXCEPTION 'cost release rejected: the refund names a different stage or attempt than the charge'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.input_tokens > (v_cost->>'inputTokens')::numeric
     OR NEW.output_tokens > (v_cost->>'outputTokens')::numeric
     OR round(NEW.usd, 6) > round((v_cost->>'usd')::numeric, 6)
     OR NEW.wall_ms > (v_cost->>'wallMs')::numeric THEN
    RAISE EXCEPTION 'cost release rejected: the refund exceeds the charge it releases'
      USING ERRCODE = 'check_violation';
  END IF;
  -- The ledger never goes negative: what a case has had released never exceeds what it was charged.
  SELECT coalesce(sum(r.input_tokens), 0), coalesce(sum(r.output_tokens), 0), coalesce(sum(r.usd), 0)
    INTO ch_in, ch_out, ch_usd
    FROM public.cost_rows r WHERE r.tenant_id = NEW.tenant_id AND r.case_id = NEW.case_id;
  SELECT coalesce(sum(r.input_tokens), 0), coalesce(sum(r.output_tokens), 0), coalesce(sum(r.usd), 0)
    INTO rel_in, rel_out, rel_usd
    FROM public.cost_releases r WHERE r.tenant_id = NEW.tenant_id AND r.case_id = NEW.case_id;
  IF rel_in + NEW.input_tokens > ch_in
     OR rel_out + NEW.output_tokens > ch_out
     OR round(rel_usd + NEW.usd, 6) > round(ch_usd, 6) THEN
    RAISE EXCEPTION 'cost release rejected: it would release more than the case was charged'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER cost_releases_insert_guard BEFORE INSERT ON public.cost_releases
  FOR EACH ROW EXECUTE FUNCTION cost_releases_insert_guard();
--> statement-breakpoint
-- The live budget, net of releases. security_invoker: the caller's RLS applies to every table read.
-- `exhausted` is recomputed from the net amounts, as FakeCaseStore does after a release;
-- cases.exhausted stays the gross, sticky flag.
CREATE VIEW public.case_budgets WITH (security_invoker = true) AS
  SELECT c.tenant_id, c.id AS case_id,
    c.remaining_input_tokens + coalesce(r.input_tokens, 0) AS remaining_input_tokens,
    c.remaining_output_tokens + coalesce(r.output_tokens, 0) AS remaining_output_tokens,
    round(c.remaining_usd + coalesce(r.usd, 0), 6) AS remaining_usd,
    (c.remaining_input_tokens + coalesce(r.input_tokens, 0) <= 0
      OR c.remaining_output_tokens + coalesce(r.output_tokens, 0) <= 0
      OR round(c.remaining_usd + coalesce(r.usd, 0), 6) <= 0) AS exhausted
  FROM public.cases c
  LEFT JOIN (
    SELECT x.tenant_id, x.case_id, sum(x.input_tokens) AS input_tokens,
      sum(x.output_tokens) AS output_tokens, sum(x.usd) AS usd
    FROM public.cost_releases x GROUP BY x.tenant_id, x.case_id
  ) r ON r.tenant_id = c.tenant_id AND r.case_id = c.id;
--> statement-breakpoint
-- Operator report: what each stage attempt was charged, what was released, and the net. Use this,
-- not a bare sum of cost_rows, which counts up-front charges in full.
CREATE VIEW public.case_cost_ledger WITH (security_invoker = true) AS
  WITH charged AS (
    SELECT tenant_id, case_id, stage, attempt, sum(input_tokens) AS input_tokens,
      sum(output_tokens) AS output_tokens, sum(usd) AS usd, sum(wall_ms) AS wall_ms
    FROM public.cost_rows GROUP BY tenant_id, case_id, stage, attempt
  ), released AS (
    SELECT tenant_id, case_id, stage, attempt, sum(input_tokens) AS input_tokens,
      sum(output_tokens) AS output_tokens, sum(usd) AS usd, sum(wall_ms) AS wall_ms
    FROM public.cost_releases GROUP BY tenant_id, case_id, stage, attempt
  )
  SELECT coalesce(c.tenant_id, r.tenant_id) AS tenant_id,
    coalesce(c.case_id, r.case_id) AS case_id,
    coalesce(c.stage, r.stage) AS stage,
    coalesce(c.attempt, r.attempt) AS attempt,
    coalesce(c.input_tokens, 0) AS charged_input_tokens,
    coalesce(c.output_tokens, 0) AS charged_output_tokens,
    coalesce(c.usd, 0) AS charged_usd,
    coalesce(r.input_tokens, 0) AS released_input_tokens,
    coalesce(r.output_tokens, 0) AS released_output_tokens,
    coalesce(r.usd, 0) AS released_usd,
    coalesce(c.input_tokens, 0) - coalesce(r.input_tokens, 0) AS net_input_tokens,
    coalesce(c.output_tokens, 0) - coalesce(r.output_tokens, 0) AS net_output_tokens,
    coalesce(c.usd, 0) - coalesce(r.usd, 0) AS net_usd,
    coalesce(c.wall_ms, 0) - coalesce(r.wall_ms, 0) AS net_wall_ms
  FROM charged c
  FULL JOIN released r
    ON r.tenant_id = c.tenant_id AND r.case_id = c.case_id AND r.stage = c.stage AND r.attempt = c.attempt;
--> statement-breakpoint
GRANT SELECT ON public.case_budgets, public.case_cost_ledger TO affidavit_app;
