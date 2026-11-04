CREATE TABLE IF NOT EXISTS projects (
  id text PRIMARY KEY,
  name text NOT NULL,
  code text NOT NULL UNIQUE,
  location text NOT NULL,
  budget_cents integer NOT NULL CHECK (budget_cents > 0)
);

CREATE TABLE IF NOT EXISTS people (
  id text PRIMARY KEY,
  name text NOT NULL,
  role text NOT NULL CHECK (role IN ('worker', 'foreman', 'manager'))
);

CREATE TABLE IF NOT EXISTS project_assignments (
  project_id text REFERENCES projects (id),
  person_id text REFERENCES people (id),
  PRIMARY KEY (project_id, person_id)
);

CREATE TABLE IF NOT EXISTS labour_rates (
  project_id text NOT NULL,
  worker_id text NOT NULL,
  effective_from date NOT NULL,
  rate_cents integer NOT NULL CHECK (rate_cents BETWEEN 1 AND 1000000),
  PRIMARY KEY (project_id, worker_id, effective_from),
  FOREIGN KEY (project_id, worker_id) REFERENCES project_assignments (project_id, person_id)
);

CREATE TABLE IF NOT EXISTS demo_sessions (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL DEFAULT gen_random_uuid(),
  project_id text NOT NULL REFERENCES projects (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT now() + interval '24 hours',
  last_reset_at timestamptz,
  UNIQUE (id, project_id)
);

ALTER TABLE demo_sessions ADD COLUMN IF NOT EXISTS workspace_id uuid NOT NULL DEFAULT gen_random_uuid();
CREATE UNIQUE INDEX IF NOT EXISTS demo_sessions_workspace_id ON demo_sessions (workspace_id);
CREATE INDEX IF NOT EXISTS demo_sessions_expiration ON demo_sessions (expires_at);

CREATE TABLE IF NOT EXISTS timecards (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid NOT NULL,
  project_id text NOT NULL,
  worker_id text NOT NULL,
  work_date date NOT NULL,
  hours numeric(4, 2) NOT NULL CHECK (hours > 0 AND hours <= 24),
  status text NOT NULL CHECK (status IN ('pending', 'returned', 'approved')),
  version integer NOT NULL DEFAULT 1,
  submitted_at timestamptz NOT NULL DEFAULT now(),
  decision_at timestamptz,
  decision_by text,
  reason text,
  approved_rate_cents integer,
  approved_cost_cents integer,
  request_id uuid,
  request_digest text,
  UNIQUE (session_id, request_id),
  FOREIGN KEY (session_id, project_id) REFERENCES demo_sessions (id, project_id) ON DELETE CASCADE,
  FOREIGN KEY (project_id, worker_id) REFERENCES project_assignments (project_id, person_id),
  FOREIGN KEY (project_id, decision_by) REFERENCES project_assignments (project_id, person_id),
  CHECK (decision_by IS NULL OR decision_by <> worker_id),
  CHECK ((request_id IS NULL) = (request_digest IS NULL)),
  CHECK (
    (status = 'pending' AND decision_at IS NULL AND decision_by IS NULL AND reason IS NULL
      AND approved_rate_cents IS NULL AND approved_cost_cents IS NULL)
    OR (status = 'returned' AND decision_at IS NOT NULL AND decision_by IS NOT NULL
      AND char_length(reason) BETWEEN 1 AND 500 AND reason IS NOT NULL
      AND approved_rate_cents IS NULL AND approved_cost_cents IS NULL)
    OR (status = 'approved' AND decision_at IS NOT NULL AND decision_by IS NOT NULL AND reason IS NULL
      AND approved_rate_cents BETWEEN 1 AND 1000000 AND approved_rate_cents IS NOT NULL
      AND approved_cost_cents = round(hours * approved_rate_cents) AND approved_cost_cents IS NOT NULL)
  )
);

-- Version 26 gives legacy returns at version 24 room to be corrected and approved.
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conrelid = 'timecards'::regclass AND conname = 'timecards_revision_limit'
  ) THEN
    ALTER TABLE timecards
      DROP CONSTRAINT IF EXISTS timecards_version_check,
      ADD CONSTRAINT timecards_revision_limit CHECK (version BETWEEN 1 AND 26 AND (version < 26 OR status = 'approved'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS timecards_by_session ON timecards (session_id, work_date DESC);

CREATE TABLE IF NOT EXISTS audit_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  timecard_id uuid NOT NULL REFERENCES timecards (id) ON DELETE CASCADE,
  actor_id text NOT NULL REFERENCES people (id),
  action text NOT NULL CHECK (action IN ('submitted', 'returned', 'resubmitted', 'approved')),
  note text,
  work_date date,
  hours numeric(4, 2),
  previous_work_date date,
  previous_hours numeric(4, 2),
  occurred_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE audit_events ADD COLUMN IF NOT EXISTS work_date date,
  ADD COLUMN IF NOT EXISTS hours numeric(4, 2),
  ADD COLUMN IF NOT EXISTS previous_work_date date,
  ADD COLUMN IF NOT EXISTS previous_hours numeric(4, 2);
CREATE INDEX IF NOT EXISTS audit_events_by_timecard ON audit_events (timecard_id, occurred_at, id);

CREATE TABLE IF NOT EXISTS timecard_correction_receipts (
  session_id uuid NOT NULL REFERENCES demo_sessions (id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL,
  request_id uuid NOT NULL,
  timecard_id uuid NOT NULL REFERENCES timecards (id) ON DELETE CASCADE,
  request_digest text NOT NULL,
  PRIMARY KEY (session_id, workspace_id, request_id)
);

CREATE INDEX IF NOT EXISTS correction_receipts_by_timecard ON timecard_correction_receipts (timecard_id);

CREATE TABLE IF NOT EXISTS discarded_timecard_submissions (
  session_id uuid NOT NULL REFERENCES demo_sessions (id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL,
  request_id uuid NOT NULL,
  PRIMARY KEY (session_id, workspace_id, request_id)
);
