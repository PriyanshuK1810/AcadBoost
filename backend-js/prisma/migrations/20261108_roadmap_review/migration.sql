BEGIN;

-- Existing identity, content, publication time and cohort/progress rows stay in place.
ALTER TABLE roadmap_versions ADD COLUMN revision integer NOT NULL DEFAULT 1,
  ADD COLUMN revision_txid bigint NOT NULL DEFAULT txid_current();
ALTER TABLE roadmap_versions DROP CONSTRAINT ck_roadmap_versions_lifecycle;
ALTER TABLE roadmap_versions ADD CONSTRAINT ck_roadmap_versions_lifecycle CHECK (
  revision > 0 AND version_number > 0 AND status IN ('draft','in_review','published','archived') AND
  ((status IN ('draft','in_review') AND published_at IS NULL) OR
   (status IN ('published','archived') AND published_at IS NOT NULL))
);

CREATE TABLE roadmap_review_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  version_id uuid NOT NULL REFERENCES roadmap_versions(id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  submitted_revision integer NOT NULL CHECK (submitted_revision > 1),
  submitted_by uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  submitted_at timestamptz(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  decision varchar(16) NOT NULL DEFAULT 'pending',
  reviewed_by uuid REFERENCES users(id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  reviewed_at timestamptz(6),
  rejection_reason varchar(2000),
  CONSTRAINT uq_review_submission UNIQUE(version_id, submitted_revision),
  CONSTRAINT ck_review_metadata CHECK (
    (decision = 'pending' AND reviewed_by IS NULL AND reviewed_at IS NULL AND rejection_reason IS NULL) OR
    (decision = 'approved' AND reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL AND
      reviewed_at >= submitted_at AND rejection_reason IS NULL) OR
    (decision = 'rejected' AND reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL AND
      reviewed_at >= submitted_at AND rejection_reason IS NOT NULL AND
      -- Match Unicode whitespace as well as the database locale's POSIX spaces.
      rejection_reason ~ '[^[:space:]\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000\uFEFF]')
  )
);
CREATE UNIQUE INDEX uq_review_pending ON roadmap_review_attempts(version_id) WHERE decision = 'pending';
CREATE UNIQUE INDEX uq_review_approved ON roadmap_review_attempts(version_id) WHERE decision = 'approved';
CREATE INDEX ix_review_submitter ON roadmap_review_attempts(submitted_by);
CREATE INDEX ix_review_reviewer ON roadmap_review_attempts(reviewed_by);

CREATE FUNCTION outpost_valid_audit_metadata(value jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE k text; v jsonb; n integer := 0;
BEGIN
  IF jsonb_typeof(value) <> 'object' OR octet_length(value::text) > 4096 THEN RETURN false; END IF;
  FOR k,v IN SELECT * FROM jsonb_each(value) LOOP
    n := n + 1;
    IF n > 16 OR k !~ '^[a-zA-Z][a-zA-Z0-9_]{0,63}$' OR
      k ~* '(secret|token|password|authorization|cookie|invitation|code)' OR
      jsonb_typeof(v) NOT IN ('string','number','boolean','null') OR
      (jsonb_typeof(v) = 'string' AND length(v #>> '{}') > 256) THEN RETURN false; END IF;
  END LOOP;
  RETURN true;
END;
$$;
CREATE TABLE audit_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  actor_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  action varchar(100) NOT NULL CHECK (action ~ '^[a-z][a-z0-9_.]{0,99}$'),
  entity_type varchar(64) NOT NULL CHECK (entity_type ~ '^[a-z][a-z0-9_]{0,63}$'),
  entity_id uuid NOT NULL,
  created_at timestamptz(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  request_id varchar(128) CHECK (request_id IS NULL OR request_id ~ '^[a-zA-Z0-9_.:-]{1,128}$'),
  metadata jsonb NOT NULL DEFAULT '{}' CHECK (outpost_valid_audit_metadata(metadata))
);
CREATE INDEX ix_audit_org_time ON audit_events(organization_id, created_at, id);
CREATE INDEX ix_audit_actor_time ON audit_events(actor_id, created_at);
CREATE INDEX ix_audit_entity ON audit_events(entity_type, entity_id, created_at);
CREATE UNIQUE INDEX uq_audit_roadmap_effect ON audit_events(entity_id, action, (metadata->>'revision'))
 WHERE action IN ('roadmap.submitted','roadmap.rejected','roadmap.approved_published','roadmap.archived');

CREATE OR REPLACE FUNCTION outpost_guard_roadmap_version() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'draft' THEN RAISE EXCEPTION 'Only unreviewed drafts may be deleted' USING ERRCODE='23514'; END IF;
    RETURN OLD;
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'draft' OR NEW.published_at IS NOT NULL OR NEW.revision <> 1 THEN
      RAISE EXCEPTION 'Create a baseline draft' USING ERRCODE='23514';
    END IF;
    NEW.revision_txid := txid_current();
    RETURN NEW;
  END IF;
  IF ROW(NEW.id,NEW.roadmap_id,NEW.version_number,NEW.created_by,NEW.created_at)
    IS DISTINCT FROM ROW(OLD.id,OLD.roadmap_id,OLD.version_number,OLD.created_by,OLD.created_at) THEN
    RAISE EXCEPTION 'Roadmap version identity cannot change' USING ERRCODE='23514';
  END IF;
  IF NEW.status = OLD.status THEN
    IF NEW.published_at IS DISTINCT FROM OLD.published_at OR
       (pg_trigger_depth() = 1 AND ROW(NEW.revision,NEW.revision_txid) IS DISTINCT FROM ROW(OLD.revision,OLD.revision_txid)) THEN
      RAISE EXCEPTION 'Publication metadata and revision are database managed' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
  END IF;
  IF NOT ((OLD.status='draft' AND NEW.status='in_review') OR
    (OLD.status='in_review' AND NEW.status IN ('draft','published')) OR
    (OLD.status='published' AND NEW.status='archived')) THEN
    RAISE EXCEPTION 'Unsupported roadmap transition: % -> %', OLD.status, NEW.status USING ERRCODE='23514';
  END IF;
  IF NEW.status <> 'published' AND NEW.published_at IS DISTINCT FROM OLD.published_at THEN
    RAISE EXCEPTION 'Publication timestamp cannot change' USING ERRCODE='23514';
  END IF;
  IF NEW.status IN ('in_review','published') AND (
    NOT EXISTS (SELECT 1 FROM phases WHERE roadmap_version_id=OLD.id) OR
    EXISTS (SELECT 1 FROM phases p WHERE p.roadmap_version_id=OLD.id AND
      (btrim(p.title)='' OR p.order_index<1 OR NOT EXISTS (SELECT 1 FROM weeks w WHERE w.phase_id=p.id))) OR
    EXISTS (SELECT 1 FROM weeks w JOIN phases p ON p.id=w.phase_id WHERE p.roadmap_version_id=OLD.id AND
      (btrim(w.title)='' OR w.order_index<1 OR NOT EXISTS (SELECT 1 FROM topics t WHERE t.week_id=w.id))) OR
    EXISTS (SELECT 1 FROM topics t JOIN weeks w ON w.id=t.week_id JOIN phases p ON p.id=w.phase_id
      WHERE p.roadmap_version_id=OLD.id AND (btrim(t.title)='' OR t.order_index<1))) THEN
    RAISE EXCEPTION 'Roadmap draft is incomplete' USING ERRCODE='23514';
  END IF;
  NEW.revision := OLD.revision + 1;
  NEW.revision_txid := txid_current();
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION outpost_guard_roadmap_content() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE content_version uuid; v roadmap_versions%ROWTYPE;
BEGIN
  IF TG_OP='UPDATE' THEN
    IF NEW.id IS DISTINCT FROM OLD.id OR
      (TG_TABLE_NAME='phases' AND to_jsonb(NEW)->>'roadmap_version_id' IS DISTINCT FROM to_jsonb(OLD)->>'roadmap_version_id') OR
      (TG_TABLE_NAME='weeks' AND to_jsonb(NEW)->>'phase_id' IS DISTINCT FROM to_jsonb(OLD)->>'phase_id') OR
      (TG_TABLE_NAME='topics' AND to_jsonb(NEW)->>'week_id' IS DISTINCT FROM to_jsonb(OLD)->>'week_id') THEN
      RAISE EXCEPTION 'Curriculum identity and parent cannot change' USING ERRCODE='23514';
    END IF;
  END IF;
  IF TG_TABLE_NAME='phases' THEN
    content_version := CASE WHEN TG_OP='DELETE' THEN OLD.roadmap_version_id ELSE NEW.roadmap_version_id END;
  ELSIF TG_TABLE_NAME='weeks' THEN
    SELECT roadmap_version_id INTO content_version FROM phases WHERE id=CASE WHEN TG_OP='DELETE' THEN OLD.phase_id ELSE NEW.phase_id END;
  ELSE
    SELECT p.roadmap_version_id INTO content_version FROM weeks w JOIN phases p ON p.id=w.phase_id
      WHERE w.id=CASE WHEN TG_OP='DELETE' THEN OLD.week_id ELSE NEW.week_id END;
  END IF;
  -- During a permitted draft cascade the ancestor may already be deleted.
  -- The ancestor's guard has already locked and checked the version.
  IF content_version IS NULL AND TG_OP='DELETE' THEN RETURN OLD; END IF;
  SELECT * INTO v FROM roadmap_versions WHERE id=content_version FOR UPDATE;
  IF NOT FOUND OR v.status <> 'draft' THEN
    RAISE EXCEPTION 'Only draft curriculum is editable' USING ERRCODE='23514';
  END IF;
  IF (TG_OP <> 'UPDATE' OR NEW IS DISTINCT FROM OLD) AND v.revision_txid <> txid_current() THEN
    UPDATE roadmap_versions SET revision=revision+1, revision_txid=txid_current() WHERE id=content_version;
  END IF;
  RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END;
$$;

CREATE FUNCTION outpost_guard_review() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v roadmap_versions%ROWTYPE;
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Review history cannot be deleted' USING ERRCODE='23514'; END IF;
  SELECT * INTO v FROM roadmap_versions WHERE id=NEW.version_id FOR UPDATE;
  IF v.status <> 'in_review' OR v.revision <> NEW.submitted_revision THEN
    RAISE EXCEPTION 'Review must identify the current submitted revision' USING ERRCODE='23514';
  END IF;
  IF TG_OP='INSERT' THEN
    IF NEW.decision <> 'pending' THEN RAISE EXCEPTION 'Insert a pending submission' USING ERRCODE='23514'; END IF;
  ELSE
    IF OLD.decision <> 'pending' OR NEW.decision NOT IN ('approved','rejected') OR
      ROW(NEW.id,NEW.version_id,NEW.submitted_revision,NEW.submitted_by,NEW.submitted_at)
      IS DISTINCT FROM ROW(OLD.id,OLD.version_id,OLD.submitted_revision,OLD.submitted_by,OLD.submitted_at) THEN
      RAISE EXCEPTION 'Review identity and completed history are immutable' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER trg_guard_review BEFORE INSERT OR UPDATE OR DELETE ON roadmap_review_attempts
 FOR EACH ROW EXECUTE FUNCTION outpost_guard_review();

CREATE FUNCTION outpost_guard_audit() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v roadmap_versions%ROWTYPE; org uuid; expected_status text; a roadmap_review_attempts%ROWTYPE;
BEGIN
  IF TG_OP <> 'INSERT' THEN RAISE EXCEPTION 'Audit events are append only' USING ERRCODE='23514'; END IF;
  IF NEW.action IN ('roadmap.submitted','roadmap.rejected','roadmap.approved_published','roadmap.archived') THEN
    SELECT rv.* INTO v FROM roadmap_versions rv WHERE rv.id=NEW.entity_id FOR UPDATE;
    SELECT organization_id INTO org FROM roadmaps WHERE id=v.roadmap_id;
    expected_status := CASE NEW.action WHEN 'roadmap.submitted' THEN 'in_review' WHEN 'roadmap.rejected' THEN 'draft'
      WHEN 'roadmap.approved_published' THEN 'published' ELSE 'archived' END;
    IF NEW.entity_type <> 'roadmap_version' OR org IS DISTINCT FROM NEW.organization_id OR
      v.status IS DISTINCT FROM expected_status OR NEW.metadata->>'revision' IS DISTINCT FROM v.revision::text OR
      jsonb_typeof(NEW.metadata->'revision') IS DISTINCT FROM 'number' OR v.revision_txid <> txid_current() THEN
      RAISE EXCEPTION 'Audit must match the current lifecycle transaction' USING ERRCODE='23514';
    END IF;
    IF NEW.action <> 'roadmap.archived' THEN
      SELECT * INTO a FROM roadmap_review_attempts WHERE version_id=v.id AND id::text=NEW.metadata->>'reviewAttemptId';
      IF NOT FOUND OR a.submitted_revision <> (CASE WHEN NEW.action='roadmap.submitted' THEN v.revision ELSE v.revision-1 END) OR
        (NEW.action='roadmap.submitted' AND (a.decision<>'pending' OR a.submitted_by<>NEW.actor_id)) OR
        (NEW.action='roadmap.rejected' AND (a.decision<>'rejected' OR a.reviewed_by<>NEW.actor_id)) OR
        (NEW.action='roadmap.approved_published' AND (a.decision<>'approved' OR a.reviewed_by<>NEW.actor_id)) THEN
        RAISE EXCEPTION 'Audit actor and attempt must match decision' USING ERRCODE='23514';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER trg_guard_audit BEFORE INSERT OR UPDATE OR DELETE ON audit_events
 FOR EACH ROW EXECUTE FUNCTION outpost_guard_audit();

-- Deferred checks allow: version transition -> pending attempt -> audit, and
-- decision finalization -> version transition -> audit in a single transaction.
CREATE FUNCTION outpost_check_transition() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE a roadmap_review_attempts%ROWTYPE; expected_decision text; action_name text; submission integer;
BEGIN
  IF NEW.status=OLD.status THEN RETURN NULL; END IF;
  action_name := CASE NEW.status WHEN 'in_review' THEN 'roadmap.submitted' WHEN 'draft' THEN 'roadmap.rejected'
    WHEN 'published' THEN 'roadmap.approved_published' ELSE 'roadmap.archived' END;
  IF NEW.status <> 'archived' THEN
    submission := CASE WHEN NEW.status='in_review' THEN NEW.revision ELSE OLD.revision END;
    expected_decision := CASE NEW.status WHEN 'in_review' THEN 'pending' WHEN 'draft' THEN 'rejected' ELSE 'approved' END;
    SELECT * INTO a FROM roadmap_review_attempts WHERE version_id=NEW.id AND submitted_revision=submission;
    IF NOT FOUND OR a.decision<>expected_decision THEN
      RAISE EXCEPTION 'Lifecycle requires its exact review attempt and decision' USING ERRCODE='23514';
    END IF;
    IF NEW.status='published' AND NEW.published_at IS DISTINCT FROM a.reviewed_at THEN
      RAISE EXCEPTION 'Approval and publication timestamps must match' USING ERRCODE='23514';
    END IF;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM audit_events e WHERE e.entity_id=NEW.id AND e.action=action_name
    AND e.metadata->>'revision'=NEW.revision::text AND
    (NEW.status='archived' OR e.metadata->>'reviewAttemptId'=a.id::text)) THEN
    RAISE EXCEPTION 'Lifecycle requires its transactional success audit event' USING ERRCODE='23514';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER trg_check_transition AFTER UPDATE ON roadmap_versions
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION outpost_check_transition();

CREATE FUNCTION outpost_check_review() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE a roadmap_review_attempts%ROWTYPE; v roadmap_versions%ROWTYPE;
BEGIN
  SELECT * INTO a FROM roadmap_review_attempts WHERE id=NEW.id;
  SELECT * INTO v FROM roadmap_versions WHERE id=a.version_id;
  IF (a.decision='pending' AND (v.status<>'in_review' OR v.revision<>a.submitted_revision)) OR
    (a.decision='approved' AND (v.status NOT IN ('published','archived') OR v.revision<=a.submitted_revision)) OR
    (a.decision='rejected' AND v.revision<=a.submitted_revision) THEN
    RAISE EXCEPTION 'Review decision and version must commit together' USING ERRCODE='23514';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER trg_check_review AFTER INSERT OR UPDATE ON roadmap_review_attempts
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION outpost_check_review();

-- TRUNCATE does not fire row guards; deny this ordinary SQL bypass explicitly.
CREATE FUNCTION outpost_guard_cohort_curriculum() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v roadmap_versions%ROWTYPE; org uuid;
BEGIN
  IF TG_OP='UPDATE' THEN
    IF ROW(NEW.organization_id,NEW.roadmap_version_id) IS DISTINCT FROM ROW(OLD.organization_id,OLD.roadmap_version_id) THEN
      RAISE EXCEPTION 'Existing cohort curriculum pins cannot change' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
  END IF;
  SELECT * INTO v FROM roadmap_versions WHERE id=NEW.roadmap_version_id FOR SHARE;
  SELECT organization_id INTO org FROM roadmaps WHERE id=v.roadmap_id;
  IF v.status IS DISTINCT FROM 'published' OR org IS DISTINCT FROM NEW.organization_id THEN
    RAISE EXCEPTION 'New cohorts require same-organization published curriculum' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER trg_guard_cohort_curriculum BEFORE INSERT OR UPDATE OF organization_id,roadmap_version_id ON cohorts
 FOR EACH ROW EXECUTE FUNCTION outpost_guard_cohort_curriculum();

CREATE FUNCTION outpost_guard_roadmap_tenant() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.id,NEW.organization_id,NEW.created_by,NEW.created_at) IS DISTINCT FROM
     ROW(OLD.id,OLD.organization_id,OLD.created_by,OLD.created_at) THEN
    RAISE EXCEPTION 'Roadmap identity and tenant cannot change' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER trg_guard_roadmap_tenant BEFORE UPDATE ON roadmaps
 FOR EACH ROW EXECUTE FUNCTION outpost_guard_roadmap_tenant();

CREATE FUNCTION outpost_deny_history_truncate() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Curriculum and governance history cannot be truncated' USING ERRCODE='23514';
END;
$$;
CREATE TRIGGER trg_no_truncate_reviews BEFORE TRUNCATE ON roadmap_review_attempts
 FOR EACH STATEMENT EXECUTE FUNCTION outpost_deny_history_truncate();
CREATE TRIGGER trg_no_truncate_audit BEFORE TRUNCATE ON audit_events
 FOR EACH STATEMENT EXECUTE FUNCTION outpost_deny_history_truncate();
CREATE TRIGGER trg_no_truncate_versions BEFORE TRUNCATE ON roadmap_versions
 FOR EACH STATEMENT EXECUTE FUNCTION outpost_deny_history_truncate();
CREATE TRIGGER trg_no_truncate_phases BEFORE TRUNCATE ON phases
 FOR EACH STATEMENT EXECUTE FUNCTION outpost_deny_history_truncate();
CREATE TRIGGER trg_no_truncate_weeks BEFORE TRUNCATE ON weeks
 FOR EACH STATEMENT EXECUTE FUNCTION outpost_deny_history_truncate();
CREATE TRIGGER trg_no_truncate_topics BEFORE TRUNCATE ON topics
 FOR EACH STATEMENT EXECUTE FUNCTION outpost_deny_history_truncate();
COMMIT;
