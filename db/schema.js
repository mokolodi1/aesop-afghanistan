const {
  pgTable,
  serial,
  varchar,
  text,
  integer,
  numeric,
  timestamp,
  boolean,
  primaryKey,
  unique,
  index,
} = require("drizzle-orm/pg-core");

const syncRuns = pgTable("sync_runs", {
  id: serial("id").primaryKey(),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
  status: varchar("status", { length: 20 }).notNull(),
  courses: integer("courses"),
  teachers: integer("teachers"),
  students: integer("students"),
  gradeRows: integer("grade_rows"),
  error: text("error"),
  backupExportKey: varchar("backup_export_key", { length: 512 }),
});

const people = pgTable(
  "people",
  {
    id: serial("id").primaryKey(),
    aesopId: varchar("aesop_id", { length: 64 }),
    email: varchar("email", { length: 320 }).notNull(),
    name: varchar("name", { length: 255 }),
    phone: varchar("phone", { length: 64 }),
    portalRole: varchar("portal_role", { length: 20 }),
    teacherClasses: text("teacher_classes"),
    syncedAt: timestamp("synced_at", { withTimezone: true }),
  },
  (table) => ({
    aesopIdUnique: unique("people_aesop_id_unique").on(table.aesopId),
    emailUnique: unique("people_email_unique").on(table.email),
    aesopIdIdx: index("people_aesop_id_idx").on(table.aesopId),
    emailIdx: index("people_email_idx").on(table.email),
  }),
);

const courses = pgTable(
  "courses",
  {
    id: serial("id").primaryKey(),
    classroomCourseId: varchar("classroom_course_id", { length: 64 }).notNull(),
    label: text("label").notNull(),
    section: varchar("section", { length: 255 }),
    state: varchar("state", { length: 32 }),
    syncedAt: timestamp("synced_at", { withTimezone: true }),
  },
  (table) => ({
    classroomCourseIdUnique: unique("courses_classroom_course_id_unique").on(table.classroomCourseId),
  }),
);

const courseEnrollments = pgTable(
  "course_enrollments",
  {
    courseId: integer("course_id")
      .notNull()
      .references(() => courses.id, { onDelete: "cascade" }),
    personId: integer("person_id")
      .notNull()
      .references(() => people.id, { onDelete: "cascade" }),
    role: varchar("role", { length: 20 }).notNull(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.courseId, table.personId] }),
    courseRoleIdx: index("course_enrollments_course_role_idx").on(table.courseId, table.role),
  }),
);

const courseGrades = pgTable(
  "course_grades",
  {
    id: serial("id").primaryKey(),
    personId: integer("person_id")
      .notNull()
      .references(() => people.id, { onDelete: "cascade" }),
    courseId: integer("course_id")
      .notNull()
      .references(() => courses.id, { onDelete: "cascade" }),
    calculatedPercent: varchar("calculated_percent", { length: 32 }),
    earned: numeric("earned"),
    possible: numeric("possible"),
    syncedAt: timestamp("synced_at", { withTimezone: true }),
  },
  (table) => ({
    personCourseUnique: unique("course_grades_person_course_unique").on(table.personId, table.courseId),
    personIdx: index("course_grades_person_idx").on(table.personId),
  }),
);

const assignments = pgTable(
  "assignments",
  {
    id: serial("id").primaryKey(),
    courseId: integer("course_id")
      .notNull()
      .references(() => courses.id, { onDelete: "cascade" }),
    classroomWorkId: varchar("classroom_work_id", { length: 64 }).notNull(),
    title: text("title"),
    maxPoints: numeric("max_points"),
  },
  (table) => ({
    courseWorkUnique: unique("assignments_course_work_unique").on(table.courseId, table.classroomWorkId),
  }),
);

const assignmentGrades = pgTable(
  "assignment_grades",
  {
    assignmentId: integer("assignment_id")
      .notNull()
      .references(() => assignments.id, { onDelete: "cascade" }),
    personId: integer("person_id")
      .notNull()
      .references(() => people.id, { onDelete: "cascade" }),
    earned: numeric("earned"),
    display: varchar("display", { length: 64 }),
    syncedAt: timestamp("synced_at", { withTimezone: true }),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.assignmentId, table.personId] }),
  }),
);

const dingNumbers = pgTable(
  "ding_numbers",
  {
    id: serial("id").primaryKey(),
    personId: integer("person_id")
      .notNull()
      .references(() => people.id, { onDelete: "cascade" }),
    number: varchar("number", { length: 32 }).notNull(),
    isCurrent: boolean("is_current").notNull().default(false),
    source: varchar("source", { length: 128 }),
    updatedAt: timestamp("updated_at", { withTimezone: true }),
  },
  (table) => ({
    personCurrentIdx: index("ding_numbers_person_current_idx").on(table.personId, table.isCurrent),
  }),
);

const dingChangeHistory = pgTable(
  "ding_change_history",
  {
    id: serial("id").primaryKey(),
    personId: integer("person_id")
      .notNull()
      .references(() => people.id, { onDelete: "cascade" }),
    dingNumber: varchar("ding_number", { length: 32 }).notNull(),
    changedAt: timestamp("changed_at", { withTimezone: true }),
    source: varchar("source", { length: 128 }),
    sheetRowKey: varchar("sheet_row_key", { length: 128 }),
  },
  (table) => ({
    personChangedIdx: index("ding_change_history_person_changed_idx").on(table.personId, table.changedAt),
  }),
);

const dingTopups = pgTable(
  "ding_topups",
  {
    id: serial("id").primaryKey(),
    personId: integer("person_id")
      .notNull()
      .references(() => people.id, { onDelete: "cascade" }),
    dingNumber: varchar("ding_number", { length: 32 }).notNull(),
    amount: varchar("amount", { length: 32 }),
    sku: varchar("sku", { length: 128 }),
    gradeAtTopup: varchar("grade_at_topup", { length: 32 }),
    syncRunId: integer("sync_run_id").references(() => syncRuns.id),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    status: varchar("status", { length: 20 }).notNull().default("pending"),
    error: text("error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (table) => ({
    personIdx: index("ding_topups_person_idx").on(table.personId),
    statusIdx: index("ding_topups_status_idx").on(table.status),
  }),
);

module.exports = {
  syncRuns,
  people,
  courses,
  courseEnrollments,
  courseGrades,
  assignments,
  assignmentGrades,
  dingNumbers,
  dingChangeHistory,
  dingTopups,
};
