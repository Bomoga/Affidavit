-- Follow-ups from the L1-09 and L1-10 reviews (security objects). Nothing here edits an applied
-- migration: the functions below are replaced with CREATE OR REPLACE (grants are kept) and the
-- list_open_cases signature is dropped and recreated.
--
-- 1. Shared helpers: the advisory-lock key for a case stage and the queue job key, so enqueue and
--    claim cannot drift apart.
-- 2. Lease checks use clock_timestamp() (wall clock now), not now() (the start of the transaction),
--    so a transaction that began before the lease expired cannot act as if it still held it.
-- 3. lock_timeout on every lease function, as enqueue_stage and claim_stage_run already had.
-- 4. record_stage_entry also stores the case's event counter at entry (stages.entry_seq).
-- 5. stage_attempt_handled(): which failed jobs recovery has nothing left to do for.
-- 6. list_open_cases(): only cases whose current visit has no live job, keyset paged.

CREATE FUNCTION stage_lock_key(p_tenant text, p_case_id text, p_stage text) RETURNS bigint
  LANGUAGE sql STABLE
  SET search_path = pg_catalog, public
  AS $$ SELECT hashtextextended(json_build_array(p_tenant, p_case_id, p_stage)::text, 0) $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION stage_lock_key(text, text, text) FROM PUBLIC;
--> statement-breakpoint
-- Must equal stageJobKey() in queue.ts (a test keeps the two equal).
CREATE FUNCTION stage_job_key(p_tenant text, p_case_id text, p_stage text, p_attempt integer) RETURNS text
  LANGUAGE sql STABLE
  SET search_path = pg_catalog, public
  AS $$ SELECT '[' || to_json(p_tenant)::text || ',' || to_json(p_case_id)::text || ',' ||
               to_json(p_stage)::text || ',' || p_attempt::text || ']' $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION stage_job_key(text, text, text, integer) FROM PUBLIC;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION enqueue_stage(p_case_id text, p_stage text, p_attempt integer) RETURNS boolean
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
  SET lock_timeout = '5s'
  AS $$
DECLARE
  v_tenant text := public.app_tenant_id();
  v_key text;
  v_existed boolean;
  v_current text;
  v_visit integer;
  v_old_visit integer;
BEGIN
  IF v_tenant IS NULL THEN
    RAISE EXCEPTION 'no tenant set' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_case_id IS NULL OR p_case_id = '' OR p_attempt IS NULL OR p_attempt < 1 OR p_attempt > 100 THEN
    RAISE EXCEPTION 'invalid stage job' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_stage IS NULL OR p_stage NOT IN ('intake', 'map', 'arraign', 'defense', 'prosecution', 'remedy',
                                       'verify', 'jury', 'verdict', 'dismissed', 'escalated') THEN
    RAISE EXCEPTION 'invalid stage' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  -- Serialise enqueue and claim for one case and stage (stage_lock_key, shared with claim_stage_run),
  -- so the existence check, the record and the queue insert cannot interleave with another caller.
  PERFORM pg_advisory_xact_lock(public.stage_lock_key(v_tenant, p_case_id, p_stage));
  SELECT stage INTO v_current FROM public.cases WHERE tenant_id = v_tenant AND id = p_case_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'unknown case %', p_case_id USING ERRCODE = 'no_data_found';
  END IF;
  IF v_current <> p_stage THEN
    RAISE EXCEPTION 'case % is at stage %, not %', p_case_id, v_current, p_stage USING ERRCODE = 'check_violation';
  END IF;
  SELECT coalesce(max(ordinal), 0) INTO v_visit FROM public.stages WHERE tenant_id = v_tenant AND case_id = p_case_id;
  SELECT visit INTO v_old_visit FROM public.stage_jobs
    WHERE tenant_id = v_tenant AND case_id = p_case_id AND stage = p_stage AND attempt = p_attempt;
  IF FOUND AND v_old_visit <> v_visit THEN
    RAISE EXCEPTION 'attempt % of stage % was used for an earlier visit; use a new attempt number', p_attempt, p_stage
      USING ERRCODE = 'check_violation';
  END IF;
  INSERT INTO public.stage_jobs (tenant_id, case_id, stage, attempt, visit)
    VALUES (v_tenant, p_case_id, p_stage, p_attempt, v_visit)
    ON CONFLICT DO NOTHING;
  v_key := public.stage_job_key(v_tenant, p_case_id, p_stage, p_attempt);
  -- add_job with unsafe_dedupe returns the existing job on a repeat, so look first.
  SELECT EXISTS (SELECT 1 FROM graphile_worker._private_jobs WHERE key = v_key) INTO v_existed;
  PERFORM graphile_worker.add_job(
    identifier => 'case-stage:' || p_stage,
    payload => json_build_object('tenantId', v_tenant, 'caseId', p_case_id, 'stage', p_stage, 'attempt', p_attempt),
    max_attempts => 1,
    job_key => v_key,
    job_key_mode => 'unsafe_dedupe');
  RETURN NOT v_existed;
END
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION claim_stage_run(p_tenant text, p_case_id text, p_stage text, p_attempt integer,
                                           p_worker_id text, p_lease_seconds integer) RETURNS text
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
  SET lock_timeout = '5s'
  AS $$
DECLARE
  v_job_visit integer;
  v_current text;
  v_visit integer;
  v_token text;
BEGIN
  IF p_worker_id IS NULL OR p_worker_id = '' OR p_lease_seconds IS NULL
     OR p_lease_seconds < 1 OR p_lease_seconds > 3600 THEN
    RAISE EXCEPTION 'invalid claim' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  PERFORM pg_advisory_xact_lock(public.stage_lock_key(p_tenant, p_case_id, p_stage));
  SELECT visit INTO v_job_visit FROM public.stage_jobs
    WHERE tenant_id = p_tenant AND case_id = p_case_id AND stage = p_stage AND attempt = p_attempt;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no enqueued stage job matches this payload' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF EXISTS (SELECT 1 FROM public.stage_runs
             WHERE tenant_id = p_tenant AND case_id = p_case_id AND stage = p_stage AND attempt = p_attempt) THEN
    RETURN NULL;
  END IF;
  SELECT stage INTO v_current FROM public.cases WHERE tenant_id = p_tenant AND id = p_case_id;
  IF v_current IS DISTINCT FROM p_stage THEN
    RAISE EXCEPTION 'case % is at stage %, not %', p_case_id, v_current, p_stage USING ERRCODE = 'check_violation';
  END IF;
  SELECT coalesce(max(ordinal), 0) INTO v_visit FROM public.stages WHERE tenant_id = p_tenant AND case_id = p_case_id;
  IF v_visit <> v_job_visit THEN
    RAISE EXCEPTION 'attempt % of stage % is for an earlier visit of the case', p_attempt, p_stage USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM public.stage_jobs
             WHERE tenant_id = p_tenant AND case_id = p_case_id AND stage = p_stage
               AND visit = v_job_visit AND attempt > p_attempt) THEN
    RAISE EXCEPTION 'attempt % of stage % was superseded by a later attempt', p_attempt, p_stage USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM public.stage_runs
             WHERE tenant_id = p_tenant AND case_id = p_case_id AND stage = p_stage
               AND visit = v_job_visit AND attempt <> p_attempt
               AND completed_at IS NULL AND failed_at IS NULL) THEN
    RAISE EXCEPTION 'another attempt of stage % is still open', p_stage USING ERRCODE = 'check_violation';
  END IF;
  INSERT INTO public.stage_runs (tenant_id, case_id, stage, attempt, visit, worker_id, claimed_at, heartbeat_at, lease_expires_at)
    VALUES (p_tenant, p_case_id, p_stage, p_attempt, v_job_visit, p_worker_id,
            clock_timestamp(), clock_timestamp(), clock_timestamp() + make_interval(secs => p_lease_seconds))
    RETURNING lease_token INTO v_token;
  RETURN v_token;
END
$$;
--> statement-breakpoint

-- The lease guard compares against the wall clock, not the start of the transaction.
CREATE OR REPLACE FUNCTION stage_runs_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public
  AS $$
BEGIN
  IF (NEW.tenant_id, NEW.case_id, NEW.stage, NEW.attempt, NEW.visit, NEW.lease_token, NEW.worker_id, NEW.claimed_at)
     IS DISTINCT FROM
     (OLD.tenant_id, OLD.case_id, OLD.stage, OLD.attempt, OLD.visit, OLD.lease_token, OLD.worker_id, OLD.claimed_at) THEN
    RAISE EXCEPTION 'stage run identity is immutable' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD.completed_at IS NOT NULL OR OLD.failed_at IS NOT NULL THEN
    RAISE EXCEPTION 'a finished stage run is immutable' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.completed_at IS NOT NULL AND NEW.failed_at IS NOT NULL THEN
    RAISE EXCEPTION 'a stage run completes or fails, not both' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.error IS NOT NULL AND NEW.failed_at IS NULL THEN
    RAISE EXCEPTION 'an error is recorded only with failed_at' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.lease_expires_at < OLD.lease_expires_at OR NEW.heartbeat_at < OLD.heartbeat_at THEN
    RAISE EXCEPTION 'a lease only moves forward' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.lease_expires_at > clock_timestamp() + interval '1 hour 1 minute'
     OR NEW.heartbeat_at > clock_timestamp() + interval '1 minute' THEN
    RAISE EXCEPTION 'lease or heartbeat is beyond the allowed bound' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.lease_expires_at > OLD.lease_expires_at AND OLD.lease_expires_at <= clock_timestamp() THEN
    RAISE EXCEPTION 'an expired lease cannot be extended' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION stage_run_heartbeat(p_case_id text, p_stage text, p_attempt integer, p_token text,
                                               p_lease_seconds integer) RETURNS boolean
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
  SET lock_timeout = '5s'
  AS $$
DECLARE
  v_tenant text := public.app_tenant_id();
  v_rows integer;
BEGIN
  IF v_tenant IS NULL THEN
    RAISE EXCEPTION 'no tenant set' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_token IS NULL OR p_lease_seconds IS NULL OR p_lease_seconds < 1 OR p_lease_seconds > 3600 THEN
    RAISE EXCEPTION 'invalid heartbeat' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  UPDATE public.stage_runs
    SET heartbeat_at = clock_timestamp(),
        lease_expires_at = greatest(lease_expires_at, clock_timestamp() + make_interval(secs => p_lease_seconds))
    WHERE tenant_id = v_tenant AND case_id = p_case_id AND stage = p_stage AND attempt = p_attempt
      AND lease_token = p_token AND completed_at IS NULL AND failed_at IS NULL
      AND lease_expires_at > clock_timestamp();
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN v_rows = 1;
END
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION stage_run_complete(p_case_id text, p_stage text, p_attempt integer, p_token text DEFAULT NULL)
  RETURNS boolean
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
  SET lock_timeout = '5s'
  AS $$
DECLARE
  v_tenant text := public.app_tenant_id();
  v_rows integer;
  v_run_visit integer;
  v_current text;
  v_case_visit integer;
BEGIN
  IF v_tenant IS NULL THEN
    RAISE EXCEPTION 'no tenant set' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_token IS NULL THEN
    -- Adoption: only an attempt whose case has left its stage visit may be adopted.
    SELECT visit INTO v_run_visit FROM public.stage_runs
      WHERE tenant_id = v_tenant AND case_id = p_case_id AND stage = p_stage AND attempt = p_attempt;
    IF NOT FOUND THEN
      RETURN false;
    END IF;
    SELECT stage INTO v_current FROM public.cases WHERE tenant_id = v_tenant AND id = p_case_id;
    SELECT coalesce(max(ordinal), 0) INTO v_case_visit FROM public.stages
      WHERE tenant_id = v_tenant AND case_id = p_case_id;
    IF v_current IS NOT DISTINCT FROM p_stage AND v_case_visit = v_run_visit THEN
      RETURN false;
    END IF;
  END IF;
  UPDATE public.stage_runs SET completed_at = clock_timestamp()
    WHERE tenant_id = v_tenant AND case_id = p_case_id AND stage = p_stage AND attempt = p_attempt
      AND completed_at IS NULL AND failed_at IS NULL
      AND CASE WHEN p_token IS NULL THEN lease_expires_at <= clock_timestamp()
               ELSE lease_token = p_token AND lease_expires_at > clock_timestamp() END;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN v_rows = 1;
END
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION stage_run_fail(p_case_id text, p_stage text, p_attempt integer, p_error text, p_token text DEFAULT NULL)
  RETURNS boolean
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
  SET lock_timeout = '5s'
  AS $$
DECLARE
  v_tenant text := public.app_tenant_id();
  v_rows integer;
BEGIN
  IF v_tenant IS NULL THEN
    RAISE EXCEPTION 'no tenant set' USING ERRCODE = 'insufficient_privilege';
  END IF;
  UPDATE public.stage_runs SET failed_at = clock_timestamp(), error = left(coalesce(p_error, 'unknown error'), 2000)
    WHERE tenant_id = v_tenant AND case_id = p_case_id AND stage = p_stage AND attempt = p_attempt
      AND completed_at IS NULL AND failed_at IS NULL
      AND CASE WHEN p_token IS NULL THEN lease_expires_at <= clock_timestamp() ELSE lease_token = p_token END;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN v_rows = 1;
END
$$;
--> statement-breakpoint

-- Not STABLE any more: it reads the wall clock.
CREATE OR REPLACE FUNCTION stage_run_job_alive(p_tenant text, p_case_id text, p_stage text, p_attempt integer)
  RETURNS boolean
  LANGUAGE sql SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
  AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.stage_runs
    WHERE tenant_id = p_tenant AND case_id = p_case_id AND stage = p_stage AND attempt = p_attempt
      AND (completed_at IS NOT NULL OR (failed_at IS NULL AND lease_expires_at > clock_timestamp()))
  )
$$;
--> statement-breakpoint

-- Stage history also records the case's event counter at entry.
CREATE OR REPLACE FUNCTION record_stage_entry() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
  AS $$
BEGIN
  INSERT INTO public.stages (tenant_id, case_id, ordinal, stage, entry_seq)
    SELECT NEW.tenant_id, NEW.id, coalesce(max(s.ordinal), 0) + 1, NEW.stage, NEW.seq
    FROM public.stages s WHERE s.tenant_id = NEW.tenant_id AND s.case_id = NEW.id;
  RETURN NULL;
END
$$;
--> statement-breakpoint

-- For the worker role's failed-job list (it cannot read tenant tables): is there nothing left for
-- recovery to do for this attempt? True only when a stage_jobs record exists for it and the attempt
-- was superseded by a later attempt of its visit, or a person was already asked to look at its
-- visit, or the case left the visit and no open run is waiting to be adopted. A job with no
-- stage_jobs record (forged, rewritten, unreadable) is never "handled": it stays visible.
CREATE FUNCTION stage_attempt_handled(p_tenant text, p_case_id text, p_stage text, p_attempt integer)
  RETURNS boolean
  LANGUAGE plpgsql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
  AS $$
DECLARE
  v_visit integer;
  v_current text;
  v_case_visit integer;
BEGIN
  IF p_attempt IS NULL THEN
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
REVOKE ALL ON FUNCTION stage_attempt_handled(text, text, text, integer) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION stage_attempt_handled(text, text, text, integer) TO affidavit_worker;
--> statement-breakpoint

-- The recovery sweep's candidates: open cases (not terminal, not flagged for review at their
-- current visit) whose latest attempt of the current visit is not live, across tenants, in
-- (tenant, case) order after the given key (keyset paging, so a pass can continue where the last
-- one stopped). A live attempt is an open run under a live lease, or an unclaimed attempt whose
-- queue job is queued or locked more recently than p_stale_seconds. Ids and the stage only.
DROP FUNCTION list_open_cases(integer);
--> statement-breakpoint
CREATE FUNCTION list_open_cases(p_limit integer, p_after_tenant text DEFAULT NULL,
                                p_after_case text DEFAULT NULL, p_stale_seconds integer DEFAULT 600)
  RETURNS TABLE (tenant_id text, case_id text, stage text)
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
  AS $$
#variable_conflict use_column
BEGIN
  -- plpgsql, not sql: the Graphile Worker schema does not exist yet when this migration runs, and
  -- a sql function body is checked at creation.
  RETURN QUERY
    SELECT c.tenant_id, c.id, c.stage
    FROM public.cases c
    CROSS JOIN LATERAL (
      SELECT coalesce(max(s.ordinal), 0) AS visit FROM public.stages s
      WHERE s.tenant_id = c.tenant_id AND s.case_id = c.id) v
    WHERE c.stage NOT IN ('verdict', 'dismissed', 'escalated')
      AND (p_after_tenant IS NULL OR (c.tenant_id, c.id) > (p_after_tenant, coalesce(p_after_case, '')))
      AND NOT EXISTS (
        SELECT 1 FROM public.review_flags f
        WHERE f.tenant_id = c.tenant_id AND f.case_id = c.id AND f.stage = c.stage
          AND (f.visit = v.visit OR f.visit = 0))
      AND NOT EXISTS (
        SELECT 1 FROM public.stage_jobs sj
        WHERE sj.tenant_id = c.tenant_id AND sj.case_id = c.id AND sj.stage = c.stage AND sj.visit = v.visit
          AND sj.attempt = (SELECT max(x.attempt) FROM public.stage_jobs x
                            WHERE x.tenant_id = sj.tenant_id AND x.case_id = sj.case_id
                              AND x.stage = sj.stage AND x.visit = sj.visit)
          AND (
            EXISTS (SELECT 1 FROM public.stage_runs r
                    WHERE r.tenant_id = sj.tenant_id AND r.case_id = sj.case_id AND r.stage = sj.stage
                      AND r.attempt = sj.attempt AND r.completed_at IS NULL AND r.failed_at IS NULL
                      AND r.lease_expires_at > clock_timestamp())
            OR (NOT EXISTS (SELECT 1 FROM public.stage_runs r2
                            WHERE r2.tenant_id = sj.tenant_id AND r2.case_id = sj.case_id
                              AND r2.stage = sj.stage AND r2.attempt = sj.attempt)
                AND EXISTS (SELECT 1 FROM graphile_worker._private_jobs j
                            WHERE j.key = public.stage_job_key(sj.tenant_id, sj.case_id, sj.stage, sj.attempt)
                              AND ((j.locked_at IS NULL AND j.attempts < j.max_attempts)
                                OR (j.locked_at IS NOT NULL
                                    AND j.locked_at >= clock_timestamp() - make_interval(secs => greatest(coalesce(p_stale_seconds, 600), 0))))))))
    ORDER BY c.tenant_id, c.id
    LIMIT least(greatest(coalesce(p_limit, 100), 1), 1000);
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION list_open_cases(integer, text, text, integer) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION list_open_cases(integer, text, text, integer) TO affidavit_worker;
