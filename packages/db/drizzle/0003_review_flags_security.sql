-- Security for review_flags and the one cross-tenant read the recovery loop needs.
-- review_flags: tenant isolation under forced RLS, insert-only for the application role.
-- list_open_cases(): SECURITY DEFINER, worker role only. It lists non-terminal cases that no
-- person has been asked to look at, across tenants, so the recovery loop can find a case whose
-- current stage has no job. It returns ids and the stage, never case content.
ALTER TABLE public.review_flags FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.review_flags FOR ALL TO affidavit_app
  USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
--> statement-breakpoint
DO $$
BEGIN
  EXECUTE format('CREATE POLICY owner_read ON public.review_flags FOR SELECT TO %I USING (true)', current_user);
END
$$;
--> statement-breakpoint
GRANT SELECT, INSERT ON public.review_flags TO affidavit_app;
--> statement-breakpoint
CREATE TRIGGER review_flags_append_only BEFORE UPDATE OR DELETE ON public.review_flags
  FOR EACH ROW EXECUTE FUNCTION reject_mutation();
--> statement-breakpoint
CREATE TRIGGER review_flags_no_truncate BEFORE TRUNCATE ON public.review_flags
  FOR EACH STATEMENT EXECUTE FUNCTION reject_mutation();
--> statement-breakpoint
CREATE FUNCTION list_open_cases(p_limit integer) RETURNS TABLE (tenant_id text, case_id text, stage text)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
  AS $$
    SELECT c.tenant_id, c.id, c.stage
    FROM public.cases c
    WHERE c.stage NOT IN ('verdict', 'dismissed', 'escalated')
      AND NOT EXISTS (
        SELECT 1 FROM public.review_flags f
        WHERE f.tenant_id = c.tenant_id AND f.case_id = c.id AND f.stage = c.stage)
    ORDER BY c.updated_at, c.tenant_id, c.id
    LIMIT least(greatest(coalesce(p_limit, 100), 1), 1000)
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION list_open_cases(integer) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION list_open_cases(integer) TO affidavit_worker;
