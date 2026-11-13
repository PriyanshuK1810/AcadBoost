BEGIN;

ALTER TABLE cohorts
  ADD CONSTRAINT uq_cohorts_id_organization UNIQUE (id, organization_id);
ALTER TABLE organization_memberships
  ADD CONSTRAINT uq_organization_memberships_id_organization UNIQUE (id, organization_id);

CREATE TABLE mentor_cohort_assignments (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  cohort_id uuid NOT NULL,
  membership_id uuid NOT NULL,
  assigned_at timestamptz(6) NOT NULL DEFAULT now(),
  assigned_by uuid NOT NULL,
  revoked_at timestamptz(6),
  revoked_by uuid,
  CONSTRAINT pk_mentor_cohort_assignments PRIMARY KEY (id),
  CONSTRAINT fk_mentor_cohort_assignments_cohort_organization
    FOREIGN KEY (cohort_id, organization_id) REFERENCES cohorts(id, organization_id)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT fk_mentor_cohort_assignments_membership_organization
    FOREIGN KEY (membership_id, organization_id) REFERENCES organization_memberships(id, organization_id)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT fk_mentor_cohort_assignments_assigned_by
    FOREIGN KEY (assigned_by) REFERENCES users(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT fk_mentor_cohort_assignments_revoked_by
    FOREIGN KEY (revoked_by) REFERENCES users(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT ck_mentor_cohort_assignments_revocation_pair
    CHECK ((revoked_at IS NULL) = (revoked_by IS NULL))
);

CREATE UNIQUE INDEX uq_mentor_cohort_assignments_active
  ON mentor_cohort_assignments (cohort_id, membership_id)
  WHERE revoked_at IS NULL;
CREATE INDEX ix_mentor_cohort_assignments_org_cohort
  ON mentor_cohort_assignments (organization_id, cohort_id);
CREATE INDEX ix_mentor_cohort_assignments_membership_org
  ON mentor_cohort_assignments (membership_id, organization_id);
CREATE INDEX ix_mentor_cohort_assignments_assigned_by
  ON mentor_cohort_assignments (assigned_by);
CREATE INDEX ix_mentor_cohort_assignments_revoked_by
  ON mentor_cohort_assignments (revoked_by);

COMMIT;