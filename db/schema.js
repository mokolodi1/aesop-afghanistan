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

const magicLinks = pgTable(
  "magic_links",
  {
    token: varchar("token", { length: 64 }).primaryKey(),
    email: varchar("email", { length: 320 }).notNull(),
    userId: varchar("user_id", { length: 64 }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    used: boolean("used").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (table) => ({
    expiresAtIdx: index("magic_links_expires_at_idx").on(table.expiresAt),
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

const emailAdminTests = pgTable(
  "email_admin_tests",
  {
    adminEmail: varchar("admin_email", { length: 320 }).notNull(),
    contentHash: varchar("content_hash", { length: 64 }).notNull(),
    testSentAt: timestamp("test_sent_at", { withTimezone: true }).notNull(),
    testSentTo: varchar("test_sent_to", { length: 320 }).notNull(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.adminEmail, table.contentHash] }),
  }),
);

const emailCampaigns = pgTable(
  "email_campaigns",
  {
    id: serial("id").primaryKey(),
    createdByEmail: varchar("created_by_email", { length: 320 }).notNull(),
    recipientGroup: varchar("recipient_group", { length: 64 }).notNull(),
    subject: text("subject").notNull(),
    body: text("body").notNull(),
    globalVars: text("global_vars").notNull().default("{}"),
    recipientFilter: text("recipient_filter"),
    contentHash: varchar("content_hash", { length: 64 }).notNull(),
    testSentAt: timestamp("test_sent_at", { withTimezone: true }),
    testSentTo: varchar("test_sent_to", { length: 320 }),
    status: varchar("status", { length: 20 }).notNull().default("sending"),
    totalRecipients: integer("total_recipients").notNull().default(0),
    sentCount: integer("sent_count").notNull().default(0),
    failedCount: integer("failed_count").notNull().default(0),
    nextBatchAt: timestamp("next_batch_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (table) => ({
    statusNextBatchIdx: index("email_campaigns_status_next_batch_idx").on(table.status, table.nextBatchAt),
  }),
);

const emailCampaignRecipients = pgTable(
  "email_campaign_recipients",
  {
    id: serial("id").primaryKey(),
    campaignId: integer("campaign_id")
      .notNull()
      .references(() => emailCampaigns.id, { onDelete: "cascade" }),
    aesopId: varchar("aesop_id", { length: 64 }),
    name: varchar("name", { length: 255 }),
    email: varchar("email", { length: 320 }).notNull(),
    rowFields: text("row_fields").notNull().default("{}"),
    status: varchar("status", { length: 20 }).notNull().default("pending"),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    postmarkMessageId: varchar("postmark_message_id", { length: 64 }),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
    openedAt: timestamp("opened_at", { withTimezone: true }),
    clickedAt: timestamp("clicked_at", { withTimezone: true }),
    bouncedAt: timestamp("bounced_at", { withTimezone: true }),
    error: text("error"),
    batchNumber: integer("batch_number"),
    sendPriority: integer("send_priority").notNull().default(1),
  },
  (table) => ({
    campaignStatusIdx: index("email_campaign_recipients_campaign_status_idx").on(
      table.campaignId,
      table.status,
    ),
    campaignPriorityIdx: index("email_campaign_recipients_campaign_priority_idx").on(
      table.campaignId,
      table.status,
      table.sendPriority,
      table.id,
    ),
    postmarkMessageIdIdx: index("email_campaign_recipients_postmark_message_id_idx").on(
      table.postmarkMessageId,
    ),
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
  magicLinks,
  dingTopups,
  emailAdminTests,
  emailCampaigns,
  emailCampaignRecipients,
};
