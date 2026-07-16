-- portal_role was a derived cache (Admin/Teacher/Student/Applied).
-- Admin comes from admin_role; teacher/student from people_type / Classroom;
-- applied from people_status / applicants.
ALTER TABLE people DROP COLUMN IF EXISTS portal_role;
ALTER TABLE people_staging DROP COLUMN IF EXISTS portal_role;
