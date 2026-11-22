-- Review fix to cost_releases_insert_guard (0009), additive: the charge event's cost must carry
-- every amount as a JSON number, the stage as a string and the attempt as a number. A missing or
-- non-numeric field used to compare as NULL and let the refund through.
--
-- The case row stays locked FOR UPDATE, deliberately. FOR NO KEY UPDATE would not conflict with
-- the FOR KEY SHARE that the verdicts foreign key check takes, and appendVerdict takes no other
-- lock on the case, so a release could see no verdict, wait for nothing, and commit after a
-- verdict on the same case: a release on a closed case. FOR UPDATE makes the verdict insert wait
-- for an open release (cost-releases.pg.test.ts, "a verdict and a release racing").
CREATE OR REPLACE FUNCTION cost_releases_insert_guard() RETURNS trigger
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
  -- Serialise every release (and charge: chargeBudget takes the same lock) of this case, and make
  -- a verdict insert (its foreign key check takes FOR KEY SHARE on this row) wait for it.
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
  -- Every field the comparisons below read must be present and of the right JSON type; JSON has
  -- no NaN or Infinity, so a JSON number is finite.
  IF jsonb_typeof(v_cost->'stage') IS DISTINCT FROM 'string'
     OR jsonb_typeof(v_cost->'attempt') IS DISTINCT FROM 'number'
     OR jsonb_typeof(v_cost->'inputTokens') IS DISTINCT FROM 'number'
     OR jsonb_typeof(v_cost->'outputTokens') IS DISTINCT FROM 'number'
     OR jsonb_typeof(v_cost->'usd') IS DISTINCT FROM 'number'
     OR jsonb_typeof(v_cost->'wallMs') IS DISTINCT FROM 'number' THEN
    RAISE EXCEPTION 'cost release rejected: the cost-charged event at seq % has no valid cost',
      NEW.reservation_seq USING ERRCODE = 'check_violation';
  END IF;
  IF v_cost->>'stage' IS DISTINCT FROM NEW.stage
     OR (v_cost->>'attempt')::numeric IS DISTINCT FROM NEW.attempt::numeric THEN
    RAISE EXCEPTION 'cost release rejected: the refund names a different stage or attempt than the charge'
      USING ERRCODE = 'check_violation';
  END IF;
  -- IS NOT FALSE: a NULL comparison refuses rather than passes.
  IF (NEW.input_tokens > (v_cost->>'inputTokens')::numeric) IS NOT FALSE
     OR (NEW.output_tokens > (v_cost->>'outputTokens')::numeric) IS NOT FALSE
     OR (round(NEW.usd, 6) > round((v_cost->>'usd')::numeric, 6)) IS NOT FALSE
     OR (NEW.wall_ms > (v_cost->>'wallMs')::numeric) IS NOT FALSE THEN
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
