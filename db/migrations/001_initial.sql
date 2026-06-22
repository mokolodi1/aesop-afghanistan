CREATE TABLE IF NOT EXISTS sync_runs (
  id SERIAL PRIMARY KEY,
  started_at TIMESTAMPTZ NOT NULL,
  finished_at TIMESTAMPTZ,
  status VARCHAR(20) NOT NULL,
  courses INTEGER,
  teachers INTEGER,
  students INTEGER,
  grade_rows INTEGER,
  error TEXT,
  backup_export_key VARCHAR(512)
);

CREATE TABLE IF NOT EXISTS people (
  id SERIAL PRIMARY KEY,
  aesop_id VARCHAR(64) UNIQUE,
  email VARCHAR(320) NOT NULL UNIQUE,
  name VARCHAR(255),
  phone VARCHAR(64),
  portal_role VARCHAR(20),
  teacher_classes TEXT,
  synced_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS people_aesop_id_idx ON people (aesop_id);
CREATE INDEX IF NOT EXISTS people_email_idx ON people (email);

CREATE TABLE IF NOT EXISTS courses (
  id SERIAL PRIMARY KEY,
  classroom_course_id VARCHAR(64) NOT NULL UNIQUE,
  label TEXT NOT NULL,
  section VARCHAR(255),
  state VARCHAR(32),
  synced_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS course_enrollments (
  course_id INTEGER NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  person_id INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  role VARCHAR(20) NOT NULL,
  PRIMARY KEY (course_id, person_id)
);

CREATE INDEX IF NOT EXISTS course_enrollments_course_role_idx ON course_enrollments (course_id, role);

CREATE TABLE IF NOT EXISTS course_grades (
  id SERIAL PRIMARY KEY,
  person_id INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  course_id INTEGER NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  calculated_percent VARCHAR(32),
  earned NUMERIC,
  possible NUMERIC,
  synced_at TIMESTAMPTZ,
  UNIQUE (person_id, course_id)
);

CREATE INDEX IF NOT EXISTS course_grades_person_idx ON course_grades (person_id);

CREATE TABLE IF NOT EXISTS assignments (
  id SERIAL PRIMARY KEY,
  course_id INTEGER NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  classroom_work_id VARCHAR(64) NOT NULL,
  title TEXT,
  max_points NUMERIC,
  UNIQUE (course_id, classroom_work_id)
);

CREATE TABLE IF NOT EXISTS assignment_grades (
  assignment_id INTEGER NOT NULL REFERENCES assignments(id) ON DELETE CASCADE,
  person_id INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  earned NUMERIC,
  display VARCHAR(64),
  synced_at TIMESTAMPTZ,
  PRIMARY KEY (assignment_id, person_id)
);

CREATE TABLE IF NOT EXISTS ding_numbers (
  id SERIAL PRIMARY KEY,
  person_id INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  number VARCHAR(32) NOT NULL,
  is_current BOOLEAN NOT NULL DEFAULT FALSE,
  source VARCHAR(128),
  updated_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS ding_numbers_person_current_idx ON ding_numbers (person_id, is_current);

CREATE TABLE IF NOT EXISTS ding_change_history (
  id SERIAL PRIMARY KEY,
  person_id INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  ding_number VARCHAR(32) NOT NULL,
  changed_at TIMESTAMPTZ,
  source VARCHAR(128),
  sheet_row_key VARCHAR(128)
);

CREATE INDEX IF NOT EXISTS ding_change_history_person_changed_idx ON ding_change_history (person_id, changed_at);

CREATE TABLE IF NOT EXISTS ding_topups (
  id SERIAL PRIMARY KEY,
  person_id INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  ding_number VARCHAR(32) NOT NULL,
  amount VARCHAR(32),
  sku VARCHAR(128),
  grade_at_topup VARCHAR(32),
  sync_run_id INTEGER REFERENCES sync_runs(id),
  sent_at TIMESTAMPTZ,
  status VARCHAR(20) NOT NULL DEFAULT 'pending',
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS ding_topups_person_idx ON ding_topups (person_id);
CREATE INDEX IF NOT EXISTS ding_topups_status_idx ON ding_topups (status);
