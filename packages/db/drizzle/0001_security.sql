-- Hand-written security migration (drizzle-kit generate --custom). Statements are split by the
-- breakpoint markers because the migrator runs them one at a time.
--
-- Model: migrations run as the database owner. Two login roles exist, both created NOLOGIN here
-- (a password is set at provisioning, never in a migration):
--   affidavit_app     tenant-facing. Tenant tables only, under row-level security. No access to the
--                     queue schema except the SECURITY DEFINER wrapper enqueue_stage().
--   affidavit_worker  runs the Graphile Worker runner. Queue schema only; no tenant tables.
-- Neither role is a superuser, bypasses RLS, owns anything, or may create temp objects.

DO $$
DECLARE
  r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['affidavit_app', 'affidavit_worker'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('CREATE ROLE %I NOLOGIN', r);
    END IF;
    -- Always re-assert the flags, so a pre-existing role cannot stay privileged.
    EXECUTE format('ALTER ROLE %I NOSUPERUSER NOBYPASSRLS NOINHERIT NOCREATEROLE NOCREATEDB NOREPLICATION', r);
    EXECUTE format('ALTER ROLE %I IN DATABASE %I SET search_path = pg_catalog, public, pg_temp', r, current_database());
    IF EXISTS (SELECT 1 FROM pg_auth_members m JOIN pg_roles x ON x.oid = m.member WHERE x.rolname = r) THEN
      RAISE EXCEPTION 'role % must not be a member of any other role', r;
    END IF;
  END LOOP;
  -- No temporary tables for anyone: unqualified names resolve to pg_temp first by default, and a
  -- temp table named like a tenant table would sit in front of it on a pooled connection.
  EXECUTE format('REVOKE TEMPORARY ON DATABASE %I FROM PUBLIC', current_database());
  EXECUTE format('REVOKE TEMPORARY ON DATABASE %I FROM affidavit_app, affidavit_worker', current_database());
END
$$;
--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO affidavit_app;
--> statement-breakpoint

-- The tenant for the current transaction. Unset or empty yields NULL, and `tenant_id = NULL` is
-- never true, so a missing setting returns no rows rather than all rows.
CREATE FUNCTION app_tenant_id() RETURNS text
  LANGUAGE sql STABLE
  SET search_path = pg_catalog, public
  AS $$ SELECT nullif(current_setting('app.tenant_id', true), '') $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app_tenant_id() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_tenant_id() TO affidavit_app;
--> statement-breakpoint

-- RLS on every tenant table: enabled (by the schema migration), forced so the owner is subject to
-- it too, and one policy for the application role.
ALTER TABLE public.tenants FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.tenants FOR ALL TO affidavit_app
  USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
--> statement-breakpoint
ALTER TABLE public.repos FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.repos FOR ALL TO affidavit_app
  USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
--> statement-breakpoint
ALTER TABLE public.cases FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.cases FOR ALL TO affidavit_app
  USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
--> statement-breakpoint
ALTER TABLE public.stages FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.stages FOR ALL TO affidavit_app
  USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
--> statement-breakpoint
ALTER TABLE public.stage_runs FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.stage_runs FOR ALL TO affidavit_app
  USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
--> statement-breakpoint
ALTER TABLE public.exhibits FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.exhibits FOR ALL TO affidavit_app
  USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
--> statement-breakpoint
ALTER TABLE public.ballots FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.ballots FOR ALL TO affidavit_app
  USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
--> statement-breakpoint
ALTER TABLE public.verdicts FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.verdicts FOR ALL TO affidavit_app
  USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
--> statement-breakpoint
ALTER TABLE public.cost_rows FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.cost_rows FOR ALL TO affidavit_app
  USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
--> statement-breakpoint
ALTER TABLE public.escalations FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.escalations FOR ALL TO affidavit_app
  USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
--> statement-breakpoint
ALTER TABLE public.events FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.events FOR ALL TO affidavit_app
  USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
--> statement-breakpoint

-- Tenant provisioning is an owner operation, not an application one. FORCE RLS applies to a
-- non-superuser owner too, so the migrating role gets an explicit policy on this one table.
DO $$
BEGIN
  EXECUTE format(
    'CREATE POLICY tenant_admin ON public.tenants FOR ALL TO %I USING (true) WITH CHECK (true)',
    current_user);
END
$$;
--> statement-breakpoint

-- Grants. No DELETE or TRUNCATE anywhere. Append-only tables are insert-only. The application
-- role cannot create tenants (select only). Mutable tables get column-level UPDATE grants.
GRANT SELECT ON public.tenants TO affidavit_app;
--> statement-breakpoint
GRANT SELECT, INSERT ON public.repos, public.stages, public.ballots, public.verdicts,
  public.cost_rows, public.escalations, public.events TO affidavit_app;
--> statement-breakpoint
GRANT SELECT, INSERT ON public.cases TO affidavit_app;
--> statement-breakpoint
GRANT UPDATE (stage, appeals, seq, remaining_input_tokens, remaining_output_tokens, remaining_usd,
  exhausted, updated_at) ON public.cases TO affidavit_app;
--> statement-breakpoint
GRANT SELECT, INSERT ON public.exhibits TO affidavit_app;
--> statement-breakpoint
GRANT UPDATE (result) ON public.exhibits TO affidavit_app;
--> statement-breakpoint
GRANT SELECT, INSERT ON public.stage_runs TO affidavit_app;
--> statement-breakpoint
GRANT UPDATE (completed_at) ON public.stage_runs TO affidavit_app;
--> statement-breakpoint

-- Owner-proof append-only: stops the owner and superusers too. Every function pins search_path.
CREATE FUNCTION reject_mutation() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public
  AS $$
BEGIN
  RAISE EXCEPTION '% is append-only: % rejected', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'insufficient_privilege';
END
$$;
--> statement-breakpoint
CREATE TRIGGER verdicts_append_only BEFORE UPDATE OR DELETE ON public.verdicts
  FOR EACH ROW EXECUTE FUNCTION reject_mutation();
--> statement-breakpoint
CREATE TRIGGER verdicts_no_truncate BEFORE TRUNCATE ON public.verdicts
  FOR EACH STATEMENT EXECUTE FUNCTION reject_mutation();
--> statement-breakpoint
CREATE TRIGGER events_append_only BEFORE UPDATE OR DELETE ON public.events
  FOR EACH ROW EXECUTE FUNCTION reject_mutation();
--> statement-breakpoint
CREATE TRIGGER events_no_truncate BEFORE TRUNCATE ON public.events
  FOR EACH STATEMENT EXECUTE FUNCTION reject_mutation();
--> statement-breakpoint
CREATE TRIGGER ballots_append_only BEFORE UPDATE OR DELETE ON public.ballots
  FOR EACH ROW EXECUTE FUNCTION reject_mutation();
--> statement-breakpoint
CREATE TRIGGER ballots_no_truncate BEFORE TRUNCATE ON public.ballots
  FOR EACH STATEMENT EXECUTE FUNCTION reject_mutation();
--> statement-breakpoint
CREATE TRIGGER stages_append_only BEFORE UPDATE OR DELETE ON public.stages
  FOR EACH ROW EXECUTE FUNCTION reject_mutation();
--> statement-breakpoint
CREATE TRIGGER stages_no_truncate BEFORE TRUNCATE ON public.stages
  FOR EACH STATEMENT EXECUTE FUNCTION reject_mutation();
--> statement-breakpoint
CREATE TRIGGER cost_rows_append_only BEFORE UPDATE OR DELETE ON public.cost_rows
  FOR EACH ROW EXECUTE FUNCTION reject_mutation();
--> statement-breakpoint
CREATE TRIGGER cost_rows_no_truncate BEFORE TRUNCATE ON public.cost_rows
  FOR EACH STATEMENT EXECUTE FUNCTION reject_mutation();
--> statement-breakpoint
CREATE TRIGGER escalations_append_only BEFORE UPDATE OR DELETE ON public.escalations
  FOR EACH ROW EXECUTE FUNCTION reject_mutation();
--> statement-breakpoint
CREATE TRIGGER escalations_no_truncate BEFORE TRUNCATE ON public.escalations
  FOR EACH STATEMENT EXECUTE FUNCTION reject_mutation();
--> statement-breakpoint
-- Exhibits and stage runs allow one write-once column; deleting or truncating them is never allowed.
CREATE FUNCTION reject_delete() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public
  AS $$
BEGIN
  RAISE EXCEPTION '% rows are never deleted: % rejected', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'insufficient_privilege';
END
$$;
--> statement-breakpoint
CREATE TRIGGER exhibits_no_delete BEFORE DELETE ON public.exhibits
  FOR EACH ROW EXECUTE FUNCTION reject_delete();
--> statement-breakpoint
CREATE TRIGGER exhibits_no_truncate BEFORE TRUNCATE ON public.exhibits
  FOR EACH STATEMENT EXECUTE FUNCTION reject_delete();
--> statement-breakpoint
CREATE TRIGGER stage_runs_no_delete BEFORE DELETE ON public.stage_runs
  FOR EACH ROW EXECUTE FUNCTION reject_delete();
--> statement-breakpoint
CREATE TRIGGER stage_runs_no_truncate BEFORE TRUNCATE ON public.stage_runs
  FOR EACH STATEMENT EXECUTE FUNCTION reject_delete();
--> statement-breakpoint

-- Exhibit result: write-once, and nothing else about an exhibit may change.
CREATE FUNCTION exhibits_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public
  AS $$
BEGIN
  IF (NEW.tenant_id, NEW.case_id, NEW.id, NEW.kind, NEW.author, NEW.sha256, NEW.exhibit, NEW.created_at)
     IS DISTINCT FROM
     (OLD.tenant_id, OLD.case_id, OLD.id, OLD.kind, OLD.author, OLD.sha256, OLD.exhibit, OLD.created_at) THEN
    RAISE EXCEPTION 'exhibits are immutable except for a first result' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD.result IS NOT NULL THEN
    RAISE EXCEPTION 'exhibit result is write-once' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER exhibits_guard BEFORE UPDATE ON public.exhibits
  FOR EACH ROW EXECUTE FUNCTION exhibits_guard();
--> statement-breakpoint

-- Stage run: only completed_at may be set, once.
CREATE FUNCTION stage_runs_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public
  AS $$
BEGIN
  IF (NEW.tenant_id, NEW.case_id, NEW.stage, NEW.attempt, NEW.claimed_at)
     IS DISTINCT FROM
     (OLD.tenant_id, OLD.case_id, OLD.stage, OLD.attempt, OLD.claimed_at) THEN
    RAISE EXCEPTION 'stage runs are immutable except for completed_at' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD.completed_at IS NOT NULL THEN
    RAISE EXCEPTION 'stage run completed_at is write-once' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER stage_runs_guard BEFORE UPDATE ON public.stage_runs
  FOR EACH ROW EXECUTE FUNCTION stage_runs_guard();
--> statement-breakpoint

-- Cases: identity, case file, score and floor are immutable; counters only move forward; budgets
-- only shrink; stage changes follow the transition table, F3 and the appeal rule, in SQL as well
-- as in the store. (The jury-enabled rule is store configuration and is not enforced here.)
CREATE FUNCTION cases_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public
  AS $$
BEGIN
  IF (NEW.tenant_id, NEW.id, NEW.repo_id, NEW.case_file, NEW.candidate_score, NEW.escalation_floor, NEW.created_at)
     IS DISTINCT FROM
     (OLD.tenant_id, OLD.id, OLD.repo_id, OLD.case_file, OLD.candidate_score, OLD.escalation_floor, OLD.created_at) THEN
    RAISE EXCEPTION 'case identity, file, score and floor are immutable' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.appeals < OLD.appeals OR NEW.seq < OLD.seq THEN
    RAISE EXCEPTION 'case counters only increase' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.remaining_input_tokens > OLD.remaining_input_tokens
     OR NEW.remaining_output_tokens > OLD.remaining_output_tokens
     OR NEW.remaining_usd > OLD.remaining_usd THEN
    RAISE EXCEPTION 'case budget only decreases' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.stage = OLD.stage THEN
    IF NEW.appeals <> OLD.appeals THEN
      RAISE EXCEPTION 'appeals change only on an appeal transition' USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN NEW;
  END IF;
  -- Keep this list identical to STAGE_TRANSITIONS in @affidavit/contracts (a unit test checks it).
  IF (OLD.stage, NEW.stage) NOT IN (
    ('intake', 'map'),
    ('map', 'arraign'),
    ('arraign', 'defense'), ('arraign', 'dismissed'),
    ('defense', 'prosecution'), ('defense', 'dismissed'), ('defense', 'escalated'),
    ('prosecution', 'remedy'), ('prosecution', 'dismissed'), ('prosecution', 'escalated'),
    ('remedy', 'verify'), ('remedy', 'escalated'),
    ('verify', 'remedy'), ('verify', 'jury'), ('verify', 'verdict'), ('verify', 'escalated'),
    ('jury', 'verdict'), ('jury', 'escalated')
  ) THEN
    RAISE EXCEPTION 'illegal stage transition % -> %', OLD.stage, NEW.stage USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.stage = 'defense' AND NEW.stage = 'dismissed' AND OLD.candidate_score >= OLD.escalation_floor THEN
    RAISE EXCEPTION 'score at or above the escalation floor cannot be dismissed (F3)' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.stage = 'verify' AND NEW.stage = 'remedy' THEN
    IF OLD.appeals >= 2 OR NEW.appeals <> OLD.appeals + 1 THEN
      RAISE EXCEPTION 'appeal limit or counter violated' USING ERRCODE = 'check_violation';
    END IF;
  ELSIF NEW.appeals <> OLD.appeals THEN
    RAISE EXCEPTION 'appeals change only on an appeal transition' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER cases_guard BEFORE UPDATE ON public.cases
  FOR EACH ROW EXECUTE FUNCTION cases_guard();
--> statement-breakpoint

-- Stage history rows can only record the case's current stage, in order, once each. Runs as the
-- inserting role, so RLS applies to the lookups.
CREATE FUNCTION stages_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public
  AS $$
DECLARE
  v_current text;
  v_last_stage text;
  v_last_ordinal integer;
BEGIN
  SELECT stage INTO v_current FROM public.cases WHERE tenant_id = NEW.tenant_id AND id = NEW.case_id;
  SELECT stage, ordinal INTO v_last_stage, v_last_ordinal FROM public.stages
    WHERE tenant_id = NEW.tenant_id AND case_id = NEW.case_id ORDER BY ordinal DESC LIMIT 1;
  IF v_current IS DISTINCT FROM NEW.stage
     OR NEW.ordinal <> coalesce(v_last_ordinal, 0) + 1
     OR v_last_stage IS NOT DISTINCT FROM NEW.stage THEN
    RAISE EXCEPTION 'stage history must record the current stage once, in order' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER stages_guard BEFORE INSERT ON public.stages
  FOR EACH ROW EXECUTE FUNCTION stages_guard();
--> statement-breakpoint

-- The only way the application role can enqueue work. SECURITY DEFINER, search_path pinned, and
-- the tenant in the payload is forced to the transaction's tenant, so a tenant cannot enqueue
-- (or see, or remove) another tenant's jobs. Idempotent on tenant, case, stage and attempt.
-- The job key format matches stageJobKey() in queue.ts.
CREATE FUNCTION enqueue_stage(p_case_id text, p_stage text, p_attempt integer) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, public
  AS $$
DECLARE
  v_tenant text := public.app_tenant_id();
BEGIN
  IF v_tenant IS NULL THEN
    RAISE EXCEPTION 'no tenant set' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_case_id IS NULL OR p_case_id = '' OR p_attempt IS NULL OR p_attempt < 1 THEN
    RAISE EXCEPTION 'invalid stage job' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_stage IS NULL OR p_stage NOT IN ('intake', 'map', 'arraign', 'defense', 'prosecution', 'remedy',
                                       'verify', 'jury', 'verdict', 'dismissed', 'escalated') THEN
    RAISE EXCEPTION 'invalid stage' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  PERFORM graphile_worker.add_job(
    identifier => 'case-stage:' || p_stage,
    payload => json_build_object('tenantId', v_tenant, 'caseId', p_case_id, 'stage', p_stage, 'attempt', p_attempt),
    max_attempts => 1,
    job_key => '[' || to_json(v_tenant)::text || ',' || to_json(p_case_id)::text || ',' ||
               to_json(p_stage)::text || ',' || p_attempt::text || ']',
    job_key_mode => 'unsafe_dedupe');
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION enqueue_stage(text, text, integer) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION enqueue_stage(text, text, integer) TO affidavit_app;
