-- Follow-ups from the L1-09 and L1-10 review minors. Nothing here edits an applied migration.
--
-- 1. review_flags.visit: new rows must name a real visit (>= 1). The legacy value 0 ("written before
--    visits were stored", matches every visit) stays valid for rows that already exist, so the
--    constraint is NOT VALID: it is checked for every insert and update from now on, and existing
--    rows are not scanned. The older review_flags_visit_valid (visit >= 0) stays as it is.
-- 2. stage_attempt_handled() also takes the Graphile job key and is false unless it equals
--    stage_job_key() of the payload, so a job whose key was rewritten (its payload then names an
--    attempt it does not stand for) is never counted as handled and stays visible.

ALTER TABLE public.review_flags
  ADD CONSTRAINT review_flags_visit_positive CHECK (visit >= 1) NOT VALID;
--> statement-breakpoint

DROP FUNCTION public.stage_attempt_handled(text, text, text, integer);
--> statement-breakpoint
CREATE FUNCTION public.stage_attempt_handled(p_tenant text, p_case_id text, p_stage text, p_attempt integer,
                                             p_job_key text)
  RETURNS boolean
  LANGUAGE plpgsql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
  AS $$
DECLARE
  v_visit integer;
  v_current text;
  v_case_visit integer;
BEGIN
  IF p_attempt IS NULL OR p_job_key IS DISTINCT FROM public.stage_job_key(p_tenant, p_case_id, p_stage, p_attempt) THEN
    RETURN false;
  END IF;
  SELECT visit INTO v_visit FROM public.stage_jobs
    WHERE tenant_id = p_tenant AND case_id = p_case_id AND stage = p_stage AND attempt = p_attempt;
  IF NOT FOUND THEN
    RETURN false;
  END IF;
  IF EXISTS (SELECT 1 FROM public.stage_jobs
             WHERE tenant_id = p_tenant AND case_id = p_case_id AND stage = p_stage
               AND visit = v_visit AND attempt > p_attempt) THEN
    RETURN true;
  END IF;
  IF EXISTS (SELECT 1 FROM public.review_flags f
             WHERE f.tenant_id = p_tenant AND f.case_id = p_case_id AND f.stage = p_stage
               AND (f.visit = v_visit OR f.visit = 0)) THEN
    RETURN true;
  END IF;
  SELECT stage INTO v_current FROM public.cases WHERE tenant_id = p_tenant AND id = p_case_id;
  SELECT coalesce(max(ordinal), 0) INTO v_case_visit FROM public.stages
    WHERE tenant_id = p_tenant AND case_id = p_case_id;
  IF v_current IS DISTINCT FROM p_stage OR v_case_visit <> v_visit THEN
    RETURN NOT EXISTS (SELECT 1 FROM public.stage_runs
                       WHERE tenant_id = p_tenant AND case_id = p_case_id AND stage = p_stage
                         AND attempt = p_attempt AND completed_at IS NULL AND failed_at IS NULL);
  END IF;
  RETURN false;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.stage_attempt_handled(text, text, text, integer, text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.stage_attempt_handled(text, text, text, integer, text) TO affidavit_worker;
