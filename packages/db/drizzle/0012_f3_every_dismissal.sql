-- CR-3: F3 (a case at or above its escalation floor cannot be dismissed) now covers every
-- transition into `dismissed` (arraign, defense and prosecution), not only defense. Before this,
-- arraign -> dismissed and prosecution -> dismissed skipped the floor in SQL as well as in the
-- stores. Mirrors rejectTransition in src/transition-rules.ts and FakeCaseStore in
-- packages/testing.
--
-- The function is replaced whole and is identical to 0001_security.sql except for the F3 line
-- (the stage condition is gone). The trigger is unchanged and keeps pointing at this function by
-- name. The function stays SECURITY INVOKER with the same pinned search_path.
CREATE OR REPLACE FUNCTION cases_guard() RETURNS trigger
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
  IF NEW.seq <> OLD.seq AND NEW.seq <> OLD.seq + 1 THEN
    RAISE EXCEPTION 'seq advances by one per update' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.remaining_usd = 'NaN'::numeric THEN
    RAISE EXCEPTION 'budget must be a number' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.remaining_input_tokens > OLD.remaining_input_tokens
     OR NEW.remaining_output_tokens > OLD.remaining_output_tokens
     OR NEW.remaining_usd > OLD.remaining_usd THEN
    RAISE EXCEPTION 'case budget only decreases' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD.exhausted AND NOT NEW.exhausted THEN
    RAISE EXCEPTION 'case exhaustion never clears' USING ERRCODE = 'insufficient_privilege';
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
  IF NEW.stage = 'dismissed' AND OLD.candidate_score >= OLD.escalation_floor THEN
    RAISE EXCEPTION 'score at or above the escalation floor cannot be dismissed (F3)' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.stage = 'verify' AND NEW.stage = 'remedy' THEN
    -- 2 is MAX_APPEALS in @affidavit/contracts (a unit test checks it).
    IF OLD.appeals >= 2 OR NEW.appeals <> OLD.appeals + 1 THEN
      RAISE EXCEPTION 'appeal limit or counter violated' USING ERRCODE = 'check_violation';
    END IF;
  ELSIF NEW.appeals <> OLD.appeals THEN
    RAISE EXCEPTION 'appeals change only on an appeal transition' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END
$$;
