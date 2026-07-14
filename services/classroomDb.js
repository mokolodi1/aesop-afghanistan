const { eq, and, sql, desc, inArray } = require("drizzle-orm");
const { getDb, isDatabaseEnabled, getPool } = require("../db/index");
const {
  getMirrorCacheMaxAgeMs,
  isMirrorTimestampFresh,
  describeMirrorTimestamp,
} = require("./mirrorCache");
const {
  syncRuns,
  people,
  courses,
  courseEnrollments,
  courseGrades,
  assignments,
  assignmentGrades,
  dingNumbers,
  dingChangeHistory,
  applicants,
  applicantReviews,
} = require("../db/schema");

function normalizeEmail(email) {
  return typeof email === "string" ? email.trim().toLowerCase() : "";
}

function formatPercent(earned, possible) {
  const e = Number(earned);
  const p = Number(possible);
  if (!Number.isFinite(e) || !Number.isFinite(p) || p <= 0) {
    return "";
  }
  return `${((e / p) * 100).toFixed(1)}%`;
}

function parseGradePercent(raw) {
  if (raw == null) {
    return null;
  }
  const s = String(raw).trim().replace("%", "");
  const n = Number.parseFloat(s);
  return Number.isFinite(n) ? n : null;
}

async function getPersonByEmail(email) {
  const db = getDb();
  if (!db) {
    return null;
  }
  const normalized = normalizeEmail(email);
  if (!normalized) {
    return null;
  }
  const rows = await db.select().from(people).where(eq(people.email, normalized)).limit(1);
  return rows[0] || null;
}

async function getPersonByAesopId(aesopId) {
  const db = getDb();
  if (!db) {
    return null;
  }
  const id = typeof aesopId === "string" ? aesopId.trim().toLowerCase() : "";
  if (!id) {
    return null;
  }
  const rows = await db.select().from(people).where(sql`lower(${people.aesopId}) = ${id}`).limit(1);
  return rows[0] || null;
}

async function getLastSyncRun() {
  const db = getDb();
  if (!db) {
    return null;
  }
  const rows = await db
    .select()
    .from(syncRuns)
    .where(eq(syncRuns.status, "success"))
    .orderBy(desc(syncRuns.finishedAt))
    .limit(1);
  return rows[0] || null;
}

async function getSyncStats() {
  const db = getDb();
  if (!db) {
    return { enabled: false, rolesRows: 0, gradesRows: 0, lastSyncedAt: null, lastSyncRun: null };
  }
  const [peopleCount, gradeCount, lastRun] = await Promise.all([
    db.select({ count: sql`count(*)::int` }).from(people),
    db.select({ count: sql`count(*)::int` }).from(courseGrades),
    getLastSyncRun(),
  ]);
  return {
    enabled: true,
    rolesRows: peopleCount[0]?.count ?? 0,
    gradesRows: gradeCount[0]?.count ?? 0,
    lastSyncedAt: lastRun?.finishedAt || null,
    lastSyncRun: lastRun,
  };
}

async function getRoleByEmailFromDb(email) {
  const person = await getPersonByEmail(email);
  if (!person || !isPeopleIdentityFresh(person)) {
    return { found: false, role: "", isTeacher: false, teacherClasses: "" };
  }
  const role = person.portalRole || "";
  const normalizedRole = String(role).toLowerCase();
  return {
    found: !!role,
    role,
    isTeacher: normalizedRole === "teacher",
    isApplied: normalizedRole === "applied",
    isAdmin: normalizedRole === "admin",
    teacherClasses: person.teacherClasses || "",
  };
}

async function getGradesByEmailFromDb(email) {
  const db = getDb();
  if (!db || !(await isClassroomMirrorFresh())) {
    return [];
  }
  const person = await getPersonByEmail(email);
  if (!person) {
    return [];
  }
  const rows = await db
    .select({
      classSection: courses.label,
      calculatedGrade: courseGrades.calculatedPercent,
      name: people.name,
      email: people.email,
    })
    .from(courseGrades)
    .innerJoin(courses, eq(courseGrades.courseId, courses.id))
    .innerJoin(people, eq(courseGrades.personId, people.id))
    .where(eq(courseGrades.personId, person.id));
  return rows.map((row) => ({
    classSection: row.classSection || "",
    calculatedGrade: row.calculatedGrade || "",
    name: row.name || "",
    email: row.email || "",
  }));
}

async function getStudentGradesFromDb(email) {
  const db = getDb();
  if (!db || !(await isClassroomMirrorFresh())) {
    return null;
  }
  const person = await getPersonByEmail(email);
  if (!person) {
    return { classes: [] };
  }

  const gradeRows = await db
    .select({
      courseId: courses.id,
      label: courses.label,
      calculatedPercent: courseGrades.calculatedPercent,
    })
    .from(courseGrades)
    .innerJoin(courses, eq(courseGrades.courseId, courses.id))
    .where(eq(courseGrades.personId, person.id));

  if (gradeRows.length === 0) {
    return { classes: [] };
  }

  const courseIds = gradeRows.map((row) => row.courseId);
  const assignmentRows = await db
    .select({
      courseId: assignments.courseId,
      title: assignments.title,
      earned: assignmentGrades.earned,
      maxPoints: assignments.maxPoints,
      display: assignmentGrades.display,
    })
    .from(assignmentGrades)
    .innerJoin(assignments, eq(assignmentGrades.assignmentId, assignments.id))
    .where(
      and(eq(assignmentGrades.personId, person.id), inArray(assignments.courseId, courseIds)),
    );

  const assignmentsByCourse = new Map();
  for (const row of assignmentRows) {
    if (!assignmentsByCourse.has(row.courseId)) {
      assignmentsByCourse.set(row.courseId, []);
    }
    assignmentsByCourse.get(row.courseId).push({
      title: row.title || "Untitled assignment",
      grade: row.earned != null ? Number(row.earned) : null,
      maxPoints: row.maxPoints != null ? Number(row.maxPoints) : null,
      display: row.display || "—",
    });
  }

  const classes = gradeRows
    .map((row) => ({
      label: row.label,
      grade: row.calculatedPercent || "",
      assignments: (assignmentsByCourse.get(row.courseId) || []).sort((a, b) =>
        a.title.localeCompare(b.title),
      ),
    }))
    .sort((a, b) => a.label.localeCompare(b.label));

  return { classes };
}

async function getTeacherRosterFromDb(teacherEmail) {
  const db = getDb();
  if (!db || !(await isClassroomMirrorFresh())) {
    return null;
  }
  const teacher = await getPersonByEmail(teacherEmail);
  if (!teacher) {
    return { classes: [] };
  }

  const taughtCourses = await db
    .select({
      courseId: courses.id,
      label: courses.label,
      classroomCourseId: courses.classroomCourseId,
    })
    .from(courseEnrollments)
    .innerJoin(courses, eq(courseEnrollments.courseId, courses.id))
    .where(and(eq(courseEnrollments.personId, teacher.id), eq(courseEnrollments.role, "teacher")));

  if (taughtCourses.length === 0) {
    return { classes: [] };
  }

  const courseIds = taughtCourses.map((c) => c.courseId);
  const studentRows = await db
    .select({
      courseId: courseEnrollments.courseId,
      email: people.email,
      name: people.name,
      aesopId: people.aesopId,
      calculatedPercent: courseGrades.calculatedPercent,
      personId: people.id,
    })
    .from(courseEnrollments)
    .innerJoin(people, eq(courseEnrollments.personId, people.id))
    .leftJoin(
      courseGrades,
      and(eq(courseGrades.personId, people.id), eq(courseGrades.courseId, courseEnrollments.courseId)),
    )
    .where(and(inArray(courseEnrollments.courseId, courseIds), eq(courseEnrollments.role, "student")));

  const studentPersonIds = [...new Set(studentRows.map((row) => row.personId))];
  const assignmentRows =
    studentPersonIds.length === 0
      ? []
      : await db
          .select({
            courseId: assignments.courseId,
            personId: assignmentGrades.personId,
            title: assignments.title,
            earned: assignmentGrades.earned,
            maxPoints: assignments.maxPoints,
            display: assignmentGrades.display,
          })
          .from(assignmentGrades)
          .innerJoin(assignments, eq(assignmentGrades.assignmentId, assignments.id))
          .where(
            and(
              inArray(assignments.courseId, courseIds),
              inArray(assignmentGrades.personId, studentPersonIds),
            ),
          );

  const assignmentsByCoursePerson = new Map();
  for (const row of assignmentRows) {
    const key = `${row.courseId}:${row.personId}`;
    if (!assignmentsByCoursePerson.has(key)) {
      assignmentsByCoursePerson.set(key, []);
    }
    assignmentsByCoursePerson.get(key).push({
      title: row.title || "Untitled assignment",
      grade: row.earned != null ? Number(row.earned) : null,
      maxPoints: row.maxPoints != null ? Number(row.maxPoints) : null,
      display: row.display || "—",
    });
  }

  const studentsByCourse = new Map();
  for (const row of studentRows) {
    if (!studentsByCourse.has(row.courseId)) {
      studentsByCourse.set(row.courseId, []);
    }
    const key = `${row.courseId}:${row.personId}`;
    studentsByCourse.get(row.courseId).push({
      email: row.email,
      name: row.name || "",
      userId: row.aesopId || "",
      grade: row.calculatedPercent || "",
      assignments: (assignmentsByCoursePerson.get(key) || []).sort((a, b) =>
        a.title.localeCompare(b.title),
      ),
    });
  }

  const classes = taughtCourses
    .map((course) => ({
      label: course.label,
      students: (studentsByCourse.get(course.courseId) || []).sort((a, b) =>
        (a.name || a.email).localeCompare(b.name || b.email),
      ),
    }))
    .sort((a, b) => a.label.localeCompare(b.label));

  return { classes };
}

async function getAdminClassListFromDb() {
  const db = getDb();
  if (!db || !(await isClassroomMirrorFresh())) {
    return null;
  }

  const courseRows = await db
    .select({
      courseId: courses.classroomCourseId,
      label: courses.label,
      id: courses.id,
    })
    .from(courses)
    .orderBy(courses.label);

  if (courseRows.length === 0) {
    return { classes: [], classCount: 0, liveFromClassroom: false, source: "database" };
  }

  const courseIds = courseRows.map((row) => row.id);
  const [teacherRows, studentCounts] = await Promise.all([
    db
      .select({
        courseId: courseEnrollments.courseId,
        teacherName: people.name,
        teacherEmail: people.email,
      })
      .from(courseEnrollments)
      .innerJoin(people, eq(courseEnrollments.personId, people.id))
      .where(and(inArray(courseEnrollments.courseId, courseIds), eq(courseEnrollments.role, "teacher"))),
    db
      .select({
        courseId: courseEnrollments.courseId,
        count: sql`count(*)::int`,
      })
      .from(courseEnrollments)
      .where(and(inArray(courseEnrollments.courseId, courseIds), eq(courseEnrollments.role, "student")))
      .groupBy(courseEnrollments.courseId),
  ]);

  const teachersByCourse = new Map();
  for (const row of teacherRows) {
    if (!teachersByCourse.has(row.courseId)) {
      teachersByCourse.set(row.courseId, new Set());
    }
    teachersByCourse.get(row.courseId).add(row.teacherName || row.teacherEmail);
  }

  const studentCountByCourse = new Map(studentCounts.map((row) => [row.courseId, row.count]));

  const classes = courseRows.map((row) => ({
    courseId: row.courseId,
    label: row.label,
    teacherNames: [...(teachersByCourse.get(row.id) || [])].sort(),
    studentCount: studentCountByCourse.get(row.id) || 0,
  }));

  return { classes, classCount: classes.length, liveFromClassroom: false, source: "database" };
}

async function getAdminClassRosterFromDb(courseId) {
  const db = getDb();
  if (!db || !(await isClassroomMirrorFresh())) {
    return null;
  }
  const id = typeof courseId === "string" ? courseId.trim() : "";
  if (!id) {
    throw new Error("courseId is required.");
  }

  const courseRows = await db
    .select()
    .from(courses)
    .where(eq(courses.classroomCourseId, id))
    .limit(1);
  const course = courseRows[0];
  if (!course) {
    throw new Error("Course not found.");
  }

  const studentRows = await db
    .select({
      email: people.email,
      name: people.name,
      aesopId: people.aesopId,
      personId: people.id,
      calculatedPercent: courseGrades.calculatedPercent,
    })
    .from(courseEnrollments)
    .innerJoin(people, eq(courseEnrollments.personId, people.id))
    .leftJoin(
      courseGrades,
      and(eq(courseGrades.personId, people.id), eq(courseGrades.courseId, course.id)),
    )
    .where(and(eq(courseEnrollments.courseId, course.id), eq(courseEnrollments.role, "student")));

  const personIds = studentRows.map((row) => row.personId);
  const dingRows =
    personIds.length === 0
      ? []
      : await db
          .select({ personId: dingNumbers.personId, number: dingNumbers.number })
          .from(dingNumbers)
          .where(and(inArray(dingNumbers.personId, personIds), eq(dingNumbers.isCurrent, true)));

  const dingByPerson = new Map(dingRows.map((row) => [row.personId, row.number]));

  const students = studentRows
    .map((row) => ({
      email: row.email,
      name: row.name || "",
      userId: row.aesopId || "",
      dingNumber: dingByPerson.get(row.personId) || "",
      grade: row.calculatedPercent || "",
      assignments: [],
    }))
    .sort((a, b) => (a.name || a.email).localeCompare(b.name || b.email));

  return {
    courseId: id,
    label: course.label,
    students,
    liveFromClassroom: false,
    source: "database",
  };
}

/**
 * All synced course grade rows (same shape as listAllClassroomGradeRows from Sheets).
 * @returns {Promise<Array<{ email: string, name: string, classSection: string, calculatedGrade: string }>|null>}
 */
async function listAllClassroomGradeRowsFromDb() {
  const db = getDb();
  if (!db || !(await isClassroomMirrorFresh())) {
    return null;
  }

  const rows = await db
    .select({
      email: people.email,
      name: people.name,
      classSection: courses.label,
      calculatedGrade: courseGrades.calculatedPercent,
    })
    .from(courseGrades)
    .innerJoin(people, eq(courseGrades.personId, people.id))
    .innerJoin(courses, eq(courseGrades.courseId, courses.id));

  return rows.map((row) => ({
    email: normalizeEmail(row.email),
    name: row.name || "",
    classSection: row.classSection || "",
    calculatedGrade: row.calculatedGrade || "",
  }));
}

async function getHighGradeStudentsFromDb(threshold) {
  const db = getDb();
  if (!db || !(await isClassroomMirrorFresh())) {
    return null;
  }

  const rows = await db
    .select({
      name: people.name,
      email: people.email,
      aesopId: people.aesopId,
      personId: people.id,
      calculatedPercent: courseGrades.calculatedPercent,
      classSection: courses.label,
    })
    .from(courseGrades)
    .innerJoin(people, eq(courseGrades.personId, people.id))
    .innerJoin(courses, eq(courseGrades.courseId, courses.id));

  const personIds = [...new Set(rows.map((row) => row.personId))];
  const dingRows =
    personIds.length === 0
      ? []
      : await db
          .select({ personId: dingNumbers.personId, number: dingNumbers.number })
          .from(dingNumbers)
          .where(and(inArray(dingNumbers.personId, personIds), eq(dingNumbers.isCurrent, true)));

  const dingByPerson = new Map(dingRows.map((row) => [row.personId, row.number]));

  const students = [];
  for (const row of rows) {
    const pct = parseGradePercent(row.calculatedPercent);
    if (pct == null || pct <= threshold) {
      continue;
    }
    students.push({
      name: row.name || "",
      email: row.email,
      userId: row.aesopId || "",
      dingNumber: dingByPerson.get(row.personId) || "",
      calculatedGrade: row.calculatedPercent || "",
      gradePercent: pct,
      classSection: row.classSection || "",
    });
  }

  students.sort((a, b) => b.gradePercent - a.gradePercent || a.name.localeCompare(b.name));
  return { threshold, students };
}

async function lookupPersonGradesAndRoleFromDb(aesopId) {
  const person = await getPersonByAesopId(aesopId);
  if (!person || !isPeopleIdentityFresh(person)) {
    return null;
  }
  const [role, classGrades, dingHistory] = await Promise.all([
    getRoleByEmailFromDb(person.email),
    getGradesByEmailFromDb(person.email),
    getDingHistoryFromDb(person.id),
  ]);
  const dingNumberRow = await getCurrentDingNumberFromDb(person.id);
  return {
    person,
    role,
    classGrades,
    dingHistory,
    dingNumber: dingNumberRow?.number || "",
  };
}

async function getCurrentDingNumberFromDb(personId) {
  const db = getDb();
  if (!db) {
    return null;
  }
  const rows = await db
    .select()
    .from(dingNumbers)
    .where(and(eq(dingNumbers.personId, personId), eq(dingNumbers.isCurrent, true)))
    .limit(1);
  return rows[0] || null;
}

/**
 * Latest current Ding number for an AESOP ID from the Postgres mirror.
 * @param {string} aesopId
 * @returns {Promise<string|null>}
 */
async function findLatestDingNumberByAesopIdFromDb(aesopId) {
  const person = await getPersonByAesopId(aesopId);
  if (!person?.id) {
    return null;
  }
  const current = await getCurrentDingNumberFromDb(person.id);
  const number = current?.number != null ? String(current.number).trim() : "";
  return number || null;
}

/**
 * Keep Postgres Ding mirror in sync after a portal write to Google Sheets.
 * @param {string} aesopId
 * @param {string} dingNumber
 * @param {Date} [changedAt]
 */
async function recordPortalDingChangeInDb(aesopId, dingNumber, changedAt = new Date()) {
  if (!isDatabaseEnabled()) {
    return;
  }
  const db = getDb();
  if (!db) {
    return;
  }
  const person = await getPersonByAesopId(aesopId);
  if (!person?.id) {
    return;
  }
  const number = String(dingNumber || "").trim();
  if (!number) {
    return;
  }
  const when = changedAt instanceof Date ? changedAt : new Date(changedAt);

  await db.update(dingNumbers).set({ isCurrent: false }).where(eq(dingNumbers.personId, person.id));
  await db.insert(dingNumbers).values({
    personId: person.id,
    number,
    isCurrent: true,
    source: "student_portal",
    updatedAt: when,
  });
  await db.insert(dingChangeHistory).values({
    personId: person.id,
    dingNumber: number,
    changedAt: when,
    source: "student_portal",
    sheetRowKey: `portal:${when.toISOString()}`,
  });
}

async function getDingHistoryFromDb(personId, maxRows = 10) {
  const db = getDb();
  if (!db || !(await isPeopleMirrorFresh())) {
    return [];
  }
  return db
    .select({
      dingNumber: dingChangeHistory.dingNumber,
      changedAt: dingChangeHistory.changedAt,
      source: dingChangeHistory.source,
    })
    .from(dingChangeHistory)
    .where(eq(dingChangeHistory.personId, personId))
    .orderBy(desc(dingChangeHistory.changedAt))
    .limit(maxRows);
}

/**
 * @param {{
 *   people?: Array<{ email: string, teacherClasses?: string }>,
 *   enrollments?: Array<{ email: string }>,
 *   courseGrades?: Array<{ email: string }>,
 *   assignmentGrades?: Array<{ email: string }>,
 * }} payload
 * @returns {Set<string>}
 */
function collectClassroomSyncEmails(payload) {
  const emails = new Set();
  for (const list of [
    payload.people,
    payload.enrollments,
    payload.courseGrades,
    payload.assignmentGrades,
  ]) {
    if (!Array.isArray(list)) {
      continue;
    }
    for (const row of list) {
      const email = normalizeEmail(row?.email);
      if (email) {
        emails.add(email);
      }
    }
  }
  return emails;
}

/**
 * Link Classroom rows to existing People sheet mirror rows only — never insert people.
 * @param {import("pg").PoolClient} client
 * @param {{
 *   people?: Array<{ email: string, teacherClasses?: string }>,
 *   enrollments?: Array<{ email: string }>,
 *   courseGrades?: Array<{ email: string }>,
 *   assignmentGrades?: Array<{ email: string }>,
 * }} payload
 * @returns {Promise<{ personIdByEmail: Map<string, number>, stats: { linked: number, missing: number, teacherClassesUpdated: number } }>}
 */
async function linkPeopleForClassroomSync(client, payload) {
  const emails = [...collectClassroomSyncEmails(payload)];
  const personIdByEmail = new Map();
  const stats = { linked: 0, missing: 0, teacherClassesUpdated: 0 };

  if (emails.length === 0) {
    return { personIdByEmail, stats };
  }

  const result = await client.query(
    `SELECT id, lower(trim(email)) AS email_key
     FROM people
     WHERE lower(trim(email)) = ANY($1::text[])`,
    [emails],
  );
  const idByEmail = new Map(result.rows.map((row) => [row.email_key, row.id]));

  for (const email of emails) {
    const personId = idByEmail.get(email);
    if (personId) {
      personIdByEmail.set(email, personId);
      stats.linked += 1;
    } else {
      stats.missing += 1;
    }
  }

  for (const row of payload.people || []) {
    const email = normalizeEmail(row.email);
    const teacherClasses = String(row.teacherClasses || "").trim();
    const personId = personIdByEmail.get(email);
    if (!email || !teacherClasses || !personId) {
      continue;
    }
    const updated = await client.query(`UPDATE people SET teacher_classes = $1 WHERE id = $2`, [
      teacherClasses,
      personId,
    ]);
    stats.teacherClassesUpdated += updated.rowCount;
  }

  return { personIdByEmail, stats };
}

/**
 * Persist a full Classroom sync snapshot inside a transaction.
 * @param {{
 *   courses: Array<object>,
 *   people: Array<object>,
 *   enrollments: Array<object>,
 *   courseGrades: Array<object>,
 *   assignments: Array<object>,
 *   assignmentGrades: Array<object>,
 *   summary: { courses: number, teachers: number, students: number, gradeRows: number }
 * }} payload
 */
async function persistClassroomSync(payload) {
  const pool = getPool();
  if (!pool) {
    throw new Error("Database is not configured.");
  }

  const client = await pool.connect();
  const startedAt = new Date();
  let syncRunId = null;

  try {
    await client.query("BEGIN");

    const syncRunInsert = await client.query(
      `INSERT INTO sync_runs (started_at, status) VALUES ($1, 'running') RETURNING id`,
      [startedAt],
    );
    syncRunId = syncRunInsert.rows[0].id;

    await client.query(`DELETE FROM assignment_grades`);
    await client.query(`DELETE FROM assignments`);
    await client.query(`DELETE FROM course_grades`);
    await client.query(`DELETE FROM course_enrollments`);
    await client.query(`DELETE FROM courses`);

    const { personIdByEmail, stats: peopleLinkStats } = await linkPeopleForClassroomSync(
      client,
      payload,
    );

    const courseIdByClassroomId = new Map();
    for (const row of payload.courses) {
      const result = await client.query(
        `INSERT INTO courses (classroom_course_id, label, section, state, synced_at)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id`,
        [row.classroomCourseId, row.label, row.section || null, row.state || "ACTIVE", startedAt],
      );
      courseIdByClassroomId.set(row.classroomCourseId, result.rows[0].id);
    }

    for (const row of payload.enrollments) {
      const personId = personIdByEmail.get(normalizeEmail(row.email));
      const courseId = courseIdByClassroomId.get(row.classroomCourseId);
      if (!personId || !courseId) {
        continue;
      }
      await client.query(
        `INSERT INTO course_enrollments (course_id, person_id, role)
         VALUES ($1, $2, $3)
         ON CONFLICT (course_id, person_id) DO UPDATE SET role = EXCLUDED.role`,
        [courseId, personId, row.role],
      );
    }

    for (const row of payload.courseGrades) {
      const personId = personIdByEmail.get(normalizeEmail(row.email));
      const courseId = courseIdByClassroomId.get(row.classroomCourseId);
      if (!personId || !courseId) {
        continue;
      }
      await client.query(
        `INSERT INTO course_grades (person_id, course_id, calculated_percent, earned, possible, synced_at)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (person_id, course_id) DO UPDATE SET
           calculated_percent = EXCLUDED.calculated_percent,
           earned = EXCLUDED.earned,
           possible = EXCLUDED.possible,
           synced_at = EXCLUDED.synced_at`,
        [
          personId,
          courseId,
          row.calculatedPercent || null,
          row.earned ?? null,
          row.possible ?? null,
          startedAt,
        ],
      );
    }

    const assignmentIdByKey = new Map();
    for (const row of payload.assignments) {
      const courseId = courseIdByClassroomId.get(row.classroomCourseId);
      if (!courseId) {
        continue;
      }
      const result = await client.query(
        `INSERT INTO assignments (course_id, classroom_work_id, title, max_points)
         VALUES ($1, $2, $3, $4)
         RETURNING id`,
        [courseId, row.classroomWorkId, row.title || null, row.maxPoints ?? null],
      );
      assignmentIdByKey.set(`${row.classroomCourseId}:${row.classroomWorkId}`, result.rows[0].id);
    }

    for (const row of payload.assignmentGrades) {
      const personId = personIdByEmail.get(normalizeEmail(row.email));
      const assignmentId = assignmentIdByKey.get(`${row.classroomCourseId}:${row.classroomWorkId}`);
      if (!personId || !assignmentId) {
        continue;
      }
      await client.query(
        `INSERT INTO assignment_grades (assignment_id, person_id, earned, display, synced_at)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (assignment_id, person_id) DO UPDATE SET
           earned = EXCLUDED.earned,
           display = EXCLUDED.display,
           synced_at = EXCLUDED.synced_at`,
        [assignmentId, personId, row.earned ?? null, row.display || null, startedAt],
      );
    }

    await client.query(
      `UPDATE sync_runs SET
         finished_at = $2,
         status = 'success',
         courses = $3,
         teachers = $4,
         students = $5,
         grade_rows = $6
       WHERE id = $1`,
      [
        syncRunId,
        new Date(),
        payload.summary.courses,
        payload.summary.teachers,
        payload.summary.students,
        payload.summary.gradeRows,
      ],
    );

    await client.query("COMMIT");
    return { syncRunId, startedAt, peopleLinkStats };
  } catch (error) {
    await client.query("ROLLBACK");
    if (syncRunId) {
      await pool.query(
        `UPDATE sync_runs SET finished_at = $2, status = 'failed', error = $3 WHERE id = $1`,
        [syncRunId, new Date(), error.message],
      );
    }
    throw error;
  } finally {
    client.release();
  }
}

async function updateSyncRunBackupKey(syncRunId, backupExportKey) {
  const db = getDb();
  if (!db || !syncRunId) {
    return;
  }
  await db.update(syncRuns).set({ backupExportKey }).where(eq(syncRuns.id, syncRunId));
}

async function exportSnapshotFromDb() {
  const db = getDb();
  if (!db) {
    return null;
  }

  const [courseRows, gradeRows, enrollmentRows, peopleRows, lastRun] = await Promise.all([
    db.select().from(courses),
    db
      .select({
        email: people.email,
        aesopId: people.aesopId,
        name: people.name,
        classSection: courses.label,
        calculatedGrade: courseGrades.calculatedPercent,
      })
      .from(courseGrades)
      .innerJoin(people, eq(courseGrades.personId, people.id))
      .innerJoin(courses, eq(courseGrades.courseId, courses.id)),
    db
      .select({
        classroomCourseId: courses.classroomCourseId,
        label: courses.label,
        email: people.email,
        aesopId: people.aesopId,
        name: people.name,
        role: courseEnrollments.role,
        calculatedGrade: courseGrades.calculatedPercent,
      })
      .from(courseEnrollments)
      .innerJoin(courses, eq(courseEnrollments.courseId, courses.id))
      .innerJoin(people, eq(courseEnrollments.personId, people.id))
      .leftJoin(
        courseGrades,
        and(eq(courseGrades.personId, people.id), eq(courseGrades.courseId, courses.id)),
      ),
    db.select().from(people),
    getLastSyncRun(),
  ]);

  const rostersByCourse = new Map();
  for (const row of enrollmentRows) {
    if (!rostersByCourse.has(row.classroomCourseId)) {
      rostersByCourse.set(row.classroomCourseId, {
        classroomCourseId: row.classroomCourseId,
        label: row.label,
        teachers: [],
        students: [],
      });
    }
    const bucket = rostersByCourse.get(row.classroomCourseId);
    const entry = {
      email: row.email,
      aesopId: row.aesopId || "",
      name: row.name || "",
      grade: row.calculatedGrade || "",
    };
    if (row.role === "teacher") {
      bucket.teachers.push(entry);
    } else {
      bucket.students.push(entry);
    }
  }

  return {
    exportedAt: new Date().toISOString(),
    syncRun: lastRun,
    manifest: {
      courses: courseRows.length,
      people: peopleRows.length,
      gradeRows: gradeRows.length,
      enrollmentRows: enrollmentRows.length,
    },
    grades: gradeRows,
    rosters: [...rostersByCourse.values()],
  };
}

/** @returns {Promise<boolean>} */
async function isClassroomMirrorFresh() {
  const lastRun = await getLastSyncRun();
  return isMirrorTimestampFresh(lastRun?.finishedAt);
}

/** @returns {Promise<boolean>} */
async function isPeopleMirrorFresh() {
  const pool = getPool();
  if (!pool) {
    return false;
  }
  const result = await pool.query(
    `SELECT MAX(synced_at) AS latest FROM people WHERE synced_at IS NOT NULL`,
  );
  return isMirrorTimestampFresh(result.rows[0]?.latest);
}

/**
 * @returns {Promise<{
 *   maxAgeMs: number,
 *   classroom: { fresh: boolean, ageMs: number|null, lastSyncedAt: Date|string|null },
 *   people: { fresh: boolean, ageMs: number|null, lastSyncedAt: Date|string|null },
 *   applicants: { fresh: boolean, ageMs: number|null, lastSyncedAt: Date|string|null },
 *   applicantReviews: { fresh: boolean, ageMs: number|null, lastSyncedAt: Date|string|null },
 * }>}
 */
async function getMirrorCacheStatus() {
  const maxAgeMs = getMirrorCacheMaxAgeMs();
  const lastRun = await getLastSyncRun();
  const classroom = {
    ...describeMirrorTimestamp(lastRun?.finishedAt),
    lastSyncedAt: lastRun?.finishedAt || null,
  };

  const pool = getPool();
  let people = { fresh: false, ageMs: null, maxAgeMs, lastSyncedAt: null };
  let applicants = { fresh: false, ageMs: null, maxAgeMs, lastSyncedAt: null };
  let applicantReviewsStatus = { fresh: false, ageMs: null, maxAgeMs, lastSyncedAt: null };

  if (pool) {
    const [peopleResult, applicantsResult, reviewsResult] = await Promise.all([
      pool.query(`SELECT MAX(synced_at) AS latest FROM people WHERE synced_at IS NOT NULL`),
      pool.query(`SELECT MAX(synced_at) AS latest FROM applicants WHERE synced_at IS NOT NULL`),
      pool.query(`SELECT MAX(synced_at) AS latest FROM applicant_reviews WHERE synced_at IS NOT NULL`),
    ]);
    const peopleLatest = peopleResult.rows[0]?.latest || null;
    const applicantsLatest = applicantsResult.rows[0]?.latest || null;
    const reviewsLatest = reviewsResult.rows[0]?.latest || null;
    people = { ...describeMirrorTimestamp(peopleLatest), lastSyncedAt: peopleLatest };
    applicants = { ...describeMirrorTimestamp(applicantsLatest), lastSyncedAt: applicantsLatest };
    applicantReviewsStatus = {
      ...describeMirrorTimestamp(reviewsLatest),
      lastSyncedAt: reviewsLatest,
    };
  }

  return { maxAgeMs, classroom, people, applicants, applicantReviews: applicantReviewsStatus };
}

/** @deprecated use getMirrorCacheMaxAgeMs from services/mirrorCache.js */
function getPortalMirrorMaxAgeMs() {
  return getMirrorCacheMaxAgeMs();
}

/**
 * @param {{ syncedAt?: Date|string|null }} person
 * @returns {boolean}
 */
function isPeopleIdentityFresh(person) {
  return isMirrorTimestampFresh(person?.syncedAt);
}

/**
 * @param {import('../db/schema').people.$inferSelect} person
 * @returns {{ name: string, email: string, id: string, phone: string, portalRole: string, reviewerRole: string, peopleStatus: string }}
 */
function personRowToProfile(person) {
  const aesopId = person.aesopId || "";
  const portalRole = person.portalRole || "";
  const storedStatus = person.peopleStatus ? String(person.peopleStatus).trim() : "";
  return {
    name: person.name || "",
    email: person.email || "",
    id: aesopId,
    phone: person.phone || "",
    portalRole,
    reviewerRole: person.reviewerRole || "",
    peopleStatus:
      storedStatus ||
      (String(portalRole).trim().toLowerCase() === "applied" ? "applied" : ""),
  };
}

/**
 * @param {{ syncedAt?: Date|string|null }} applicant
 * @returns {boolean}
 */
function isApplicantsMirrorFresh(applicant) {
  return isMirrorTimestampFresh(applicant?.syncedAt);
}

/**
 * @param {import('../db/schema').applicants.$inferSelect} applicant
 * @returns {{ aesopId: string, round1: string, round2: string, links: string, submittedAt: string, email: string, driveFileId: string|null, driveFileName: string|null, driveDurationSeconds: number|null, round2Prompt: string }}
 */
function applicantRowFromDb(applicant) {
  return {
    aesopId: String(applicant.aesopId || "").trim(),
    round1: String(applicant.round1 ?? "").trim(),
    round2: String(applicant.round2 ?? "").trim(),
    links: String(applicant.applicantLinks ?? "").trim(),
    submittedAt: String(applicant.submittedAt ?? "").trim(),
    email: String(applicant.email || "").trim(),
    age: String(applicant.age ?? "").trim(),
    essay: String(applicant.essay ?? "").trim(),
    round2Prompt: String(applicant.round2Prompt ?? "").trim(),
    driveFileId: applicant.driveFileId ? String(applicant.driveFileId).trim() : null,
    driveFileName: applicant.driveFileName ? String(applicant.driveFileName).trim() : null,
    driveDurationSeconds:
      applicant.driveDurationSeconds != null && Number.isFinite(Number(applicant.driveDurationSeconds))
        ? Number(applicant.driveDurationSeconds)
        : null,
  };
}

/**
 * @param {string} aesopId
 * @returns {Promise<ReturnType<typeof applicantRowFromDb>|null>}
 */
async function getApplicantRowByAesopIdFromDb(aesopId) {
  const db = getDb();
  if (!db) {
    return null;
  }
  const id = typeof aesopId === "string" ? aesopId.trim().toLowerCase() : "";
  if (!id) {
    return null;
  }
  const rows = await db
    .select()
    .from(applicants)
    .where(sql`lower(${applicants.aesopId}) = ${id}`)
    .limit(1);
  const applicant = rows[0];
  if (!applicant) {
    return null;
  }
  return applicantRowFromDb(applicant);
}

/**
 * Upsert one Applicants sheet row (+ optional Drive metadata) into applicants.
 * @param {{
 *   aesopId: string,
 *   email?: string,
 *   name?: string,
 *   appliedLevel?: string,
 *   age?: string,
 *   essay?: string,
 *   round1?: string,
 *   round2?: string,
 *   round2Prompt?: string,
 *   applicantLinks?: string,
 *   submittedAt?: string,
 *   driveFileId?: string|null,
 *   driveFileName?: string|null,
 *   driveDurationSeconds?: number|null,
 *   syncedAt?: Date,
 * }} fields
 * @returns {Promise<{ id: number }|null>}
 */
async function upsertApplicantFromMirror(fields) {
  const pool = getPool();
  if (!pool) {
    return null;
  }

  const aesopId = String(fields.aesopId || "").trim();
  if (!aesopId) {
    return null;
  }

  const email = fields.email ? normalizeEmail(fields.email) : null;
  const syncedAt = fields.syncedAt instanceof Date ? fields.syncedAt : new Date();
  const result = await pool.query(
    `INSERT INTO applicants (
       aesop_id, email, name, applied_level, age, essay,
       round1, round2, round2_prompt, applicant_links, submitted_at,
       drive_file_id, drive_file_name, drive_duration_seconds, synced_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
     ON CONFLICT (aesop_id) DO UPDATE SET
       email = COALESCE(EXCLUDED.email, applicants.email),
       name = EXCLUDED.name,
       applied_level = EXCLUDED.applied_level,
       age = EXCLUDED.age,
       essay = EXCLUDED.essay,
       round1 = EXCLUDED.round1,
       round2 = EXCLUDED.round2,
       round2_prompt = EXCLUDED.round2_prompt,
       applicant_links = EXCLUDED.applicant_links,
       submitted_at = EXCLUDED.submitted_at,
       drive_file_id = EXCLUDED.drive_file_id,
       drive_file_name = EXCLUDED.drive_file_name,
       drive_duration_seconds = EXCLUDED.drive_duration_seconds,
       synced_at = EXCLUDED.synced_at
     RETURNING id`,
    [
      aesopId,
      email,
      fields.name ?? "",
      fields.appliedLevel ?? "",
      fields.age ?? "",
      fields.essay ?? "",
      fields.round1 ?? "",
      fields.round2 ?? "",
      fields.round2Prompt ?? "",
      fields.applicantLinks ?? "",
      fields.submittedAt ?? "",
      fields.driveFileId || null,
      fields.driveFileName || null,
      fields.driveDurationSeconds ?? null,
      syncedAt,
    ],
  );
  return result.rows[0] || null;
}

/**
 * Update cached Drive file metadata / duration for an applicant without rewriting sheet fields.
 * @param {string} aesopId
 * @param {{
 *   driveDurationSeconds?: number|null,
 *   driveFileId?: string|null,
 *   driveFileName?: string|null,
 * }} fields
 * @returns {Promise<boolean>}
 */
async function updateApplicantDriveDurationSeconds(aesopId, fields = {}) {
  const pool = getPool();
  if (!pool) {
    return false;
  }
  const id = String(aesopId || "").trim();
  if (!id) {
    return false;
  }

  const sets = [];
  const values = [id];
  let param = 2;

  if (Object.prototype.hasOwnProperty.call(fields, "driveDurationSeconds")) {
    const duration =
      fields.driveDurationSeconds != null && Number.isFinite(Number(fields.driveDurationSeconds))
        ? Math.round(Number(fields.driveDurationSeconds))
        : null;
    sets.push(`drive_duration_seconds = $${param}`);
    values.push(duration);
    param += 1;
  }
  if (Object.prototype.hasOwnProperty.call(fields, "driveFileId")) {
    const fileId = fields.driveFileId ? String(fields.driveFileId).trim() : null;
    sets.push(`drive_file_id = $${param}`);
    values.push(fileId || null);
    param += 1;
  }
  if (Object.prototype.hasOwnProperty.call(fields, "driveFileName")) {
    const fileName = fields.driveFileName ? String(fields.driveFileName).trim() : null;
    sets.push(`drive_file_name = $${param}`);
    values.push(fileName || null);
    param += 1;
  }

  if (sets.length === 0) {
    return false;
  }

  const result = await pool.query(
    `UPDATE applicants
     SET ${sets.join(", ")}
     WHERE lower(aesop_id) = lower($1)`,
    values,
  );
  return (result.rowCount || 0) > 0;
}

/** @returns {Promise<boolean>} */
async function isApplicantsTableMirrorFresh() {
  const pool = getPool();
  if (!pool) {
    return false;
  }
  const result = await pool.query(
    `SELECT MAX(synced_at) AS latest FROM applicants WHERE synced_at IS NOT NULL`,
  );
  return isMirrorTimestampFresh(result.rows[0]?.latest);
}

/**
 * @returns {Promise<Map<string, { age: string, essay: string, driveFileId: string }>|null>}
 */
async function getApplicantsReviewFieldsMapFromDb() {
  const pool = getPool();
  if (!pool) {
    return null;
  }

  const result = await pool.query(
    `SELECT lower(aesop_id) AS aesop_key, age, essay, drive_file_id, drive_duration_seconds
     FROM applicants
     WHERE aesop_id IS NOT NULL AND trim(aesop_id) <> ''`,
  );

  /** @type {Map<string, { age: string, essay: string, driveFileId: string, driveDurationSeconds: number|null }>} */
  const byId = new Map();
  for (const row of result.rows) {
    const key = String(row.aesop_key || "").trim().toLowerCase();
    if (!key) {
      continue;
    }
    const durationRaw = Number(row.drive_duration_seconds);
    byId.set(key, {
      age: String(row.age ?? "").trim(),
      essay: String(row.essay ?? "").trim(),
      driveFileId: String(row.drive_file_id ?? "").trim(),
      driveDurationSeconds: Number.isFinite(durationRaw) ? durationRaw : null,
    });
  }
  return byId;
}

/**
 * Cached voice-memo durations keyed by Drive file id (and AESOP id fallback).
 * Includes browser-corrected lengths written by the portal player.
 * @returns {Promise<{
 *   byFileId: Map<string, number>,
 *   byAesopId: Map<string, { fileId: string|null, durationSeconds: number }>,
 * }|null>}
 */
async function getApplicantVoiceMemoDurationsMapFromDb() {
  const pool = getPool();
  if (!pool) {
    return null;
  }

  const result = await pool.query(
    `SELECT lower(aesop_id) AS aesop_key, drive_file_id, drive_duration_seconds
     FROM applicants
     WHERE drive_duration_seconds IS NOT NULL
       AND aesop_id IS NOT NULL
       AND trim(aesop_id) <> ''`,
  );

  /** @type {Map<string, number>} */
  const byFileId = new Map();
  /** @type {Map<string, { fileId: string|null, durationSeconds: number }>} */
  const byAesopId = new Map();

  for (const row of result.rows) {
    const aesopKey = String(row.aesop_key || "").trim().toLowerCase();
    const fileId = String(row.drive_file_id || "").trim();
    const durationRaw = Number(row.drive_duration_seconds);
    if (!aesopKey || !Number.isFinite(durationRaw) || durationRaw < 0) {
      continue;
    }
    byAesopId.set(aesopKey, {
      fileId: fileId || null,
      durationSeconds: durationRaw,
    });
    if (fileId) {
      byFileId.set(fileId, durationRaw);
    }
  }

  return { byFileId, byAesopId };
}

/**
 * @param {string} reviewerAesopId
 * @param {string} applicantAesopId
 * @returns {Promise<boolean|null>} null when mirror is stale/unavailable
 */
async function isReviewerAssignedToApplicantFromDb(reviewerAesopId, applicantAesopId) {
  const pool = getPool();
  if (!pool) {
    return null;
  }
  const reviewerKey = typeof reviewerAesopId === "string" ? reviewerAesopId.trim().toLowerCase() : "";
  const applicantKey = typeof applicantAesopId === "string" ? applicantAesopId.trim().toLowerCase() : "";
  if (!reviewerKey || !applicantKey) {
    return false;
  }

  const result = await pool.query(
    `SELECT 1
     FROM applicant_reviews
     WHERE lower(aesop_id) = $1
       AND (lower(reviewer_a) = $2 OR lower(reviewer_b) = $2)
     LIMIT 1`,
    [applicantKey, reviewerKey],
  );
  return result.rows.length > 0;
}

/**
 * @param {string} reviewerAesopId
 * @returns {Promise<boolean|null>} null when DB pool is unavailable
 */
async function isListedAsApplicantReviewerFromDb(reviewerAesopId) {
  const pool = getPool();
  if (!pool) {
    return null;
  }
  const reviewerKey = typeof reviewerAesopId === "string" ? reviewerAesopId.trim().toLowerCase() : "";
  if (!reviewerKey) {
    return false;
  }

  const result = await pool.query(
    `SELECT 1
     FROM applicant_reviews
     WHERE lower(reviewer_a) = $1 OR lower(reviewer_b) = $1
     LIMIT 1`,
    [reviewerKey],
  );
  return result.rows.length > 0;
}

/** @returns {Promise<boolean>} */
async function isApplicantReviewsMirrorFresh() {
  const pool = getPool();
  if (!pool) {
    return false;
  }
  const result = await pool.query(
    `SELECT MAX(synced_at) AS latest FROM applicant_reviews WHERE synced_at IS NOT NULL`,
  );
  return isMirrorTimestampFresh(result.rows[0]?.latest);
}

/**
 * @param {string} aesopId
 * @returns {Promise<Record<string, unknown>|null>}
 */
async function getApplicantReviewRowFromDb(aesopId) {
  const pool = getPool();
  if (!pool) {
    return null;
  }
  const id = typeof aesopId === "string" ? aesopId.trim().toLowerCase() : "";
  if (!id) {
    return null;
  }
  if (!(await isApplicantReviewsMirrorFresh())) {
    return null;
  }
  const result = await pool.query(
    `SELECT * FROM applicant_reviews WHERE lower(aesop_id) = $1 LIMIT 1`,
    [id],
  );
  return result.rows[0] || null;
}

/**
 * @param {{
 *   aesopId: string,
 *   reviewerA?: string,
 *   reviewerB?: string,
 *   aEnglishLevel?: string,
 *   aSuspectedAi?: string,
 *   aInstructionFollowing?: string,
 *   aOriginalThinking?: string,
 *   aCharacter?: string,
 *   bEnglishLevel?: string,
 *   bSuspectedAi?: string,
 *   bInstructionFollowing?: string,
 *   bOriginalThinking?: string,
 *   bCharacter?: string,
 *   sheetRowNumber?: number|null,
 *   syncedAt?: Date,
 * }} fields
 * @returns {Promise<{ id: number }|null>}
 */
async function upsertApplicantReviewFromMirror(fields) {
  const pool = getPool();
  if (!pool) {
    return null;
  }

  const aesopId = String(fields.aesopId || "").trim();
  if (!aesopId) {
    return null;
  }

  const syncedAt = fields.syncedAt instanceof Date ? fields.syncedAt : new Date();
  const result = await pool.query(
    `INSERT INTO applicant_reviews (
       aesop_id, reviewer_a, reviewer_b,
       a_english_level, a_suspected_ai, a_instruction_following, a_original_thinking, a_character,
       b_english_level, b_suspected_ai, b_instruction_following, b_original_thinking, b_character,
       sheet_row_number, synced_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
     ON CONFLICT (aesop_id) DO UPDATE SET
       reviewer_a = EXCLUDED.reviewer_a,
       reviewer_b = EXCLUDED.reviewer_b,
       a_english_level = EXCLUDED.a_english_level,
       a_suspected_ai = EXCLUDED.a_suspected_ai,
       a_instruction_following = EXCLUDED.a_instruction_following,
       a_original_thinking = EXCLUDED.a_original_thinking,
       a_character = EXCLUDED.a_character,
       b_english_level = EXCLUDED.b_english_level,
       b_suspected_ai = EXCLUDED.b_suspected_ai,
       b_instruction_following = EXCLUDED.b_instruction_following,
       b_original_thinking = EXCLUDED.b_original_thinking,
       b_character = EXCLUDED.b_character,
       sheet_row_number = COALESCE(EXCLUDED.sheet_row_number, applicant_reviews.sheet_row_number),
       synced_at = EXCLUDED.synced_at
     RETURNING id`,
    [
      aesopId,
      fields.reviewerA ?? "",
      fields.reviewerB ?? "",
      fields.aEnglishLevel ?? "",
      fields.aSuspectedAi ?? "",
      fields.aInstructionFollowing ?? "",
      fields.aOriginalThinking ?? "",
      fields.aCharacter ?? "",
      fields.bEnglishLevel ?? "",
      fields.bSuspectedAi ?? "",
      fields.bInstructionFollowing ?? "",
      fields.bOriginalThinking ?? "",
      fields.bCharacter ?? "",
      fields.sheetRowNumber ?? null,
      syncedAt,
    ],
  );
  return result.rows[0] || null;
}

/**
 * @param {string} reviewerAesopId
 * @returns {Promise<Array<Record<string, unknown>>|null>}
 */
async function getReviewAssignmentsForReviewerFromDb(reviewerAesopId) {
  const pool = getPool();
  if (!pool) {
    return null;
  }
  const reviewerKey = typeof reviewerAesopId === "string" ? reviewerAesopId.trim().toLowerCase() : "";
  if (!reviewerKey) {
    return [];
  }

  const result = await pool.query(
    `SELECT
       ar.aesop_id,
       ar.reviewer_a,
       ar.reviewer_b,
       ar.a_english_level,
       ar.a_suspected_ai,
       ar.a_instruction_following,
       ar.a_original_thinking,
       ar.a_character,
       ar.b_english_level,
       ar.b_suspected_ai,
       ar.b_instruction_following,
       ar.b_original_thinking,
       ar.b_character,
       a.age,
       a.essay,
       a.drive_file_id,
       a.drive_duration_seconds
     FROM applicant_reviews ar
     LEFT JOIN applicants a ON lower(a.aesop_id) = lower(ar.aesop_id)
     WHERE lower(ar.reviewer_a) = $1 OR lower(ar.reviewer_b) = $1`,
    [reviewerKey],
  );

  return result.rows;
}

module.exports = {
  isDatabaseEnabled,
  normalizeEmail,
  parseGradePercent,
  getPersonByEmail,
  getPersonByAesopId,
  getPortalMirrorMaxAgeMs,
  getMirrorCacheStatus,
  isClassroomMirrorFresh,
  isPeopleMirrorFresh,
  isPeopleIdentityFresh,
  isApplicantsMirrorFresh,
  isApplicantsTableMirrorFresh,
  getApplicantsReviewFieldsMapFromDb,
  getApplicantVoiceMemoDurationsMapFromDb,
  isReviewerAssignedToApplicantFromDb,
  isListedAsApplicantReviewerFromDb,
  isApplicantReviewsMirrorFresh,
  personRowToProfile,
  applicantRowFromDb,
  getApplicantRowByAesopIdFromDb,
  upsertApplicantFromMirror,
  updateApplicantDriveDurationSeconds,
  getApplicantReviewRowFromDb,
  upsertApplicantReviewFromMirror,
  getReviewAssignmentsForReviewerFromDb,
  getLastSyncRun,
  getSyncStats,
  getRoleByEmailFromDb,
  getGradesByEmailFromDb,
  getStudentGradesFromDb,
  getTeacherRosterFromDb,
  getAdminClassListFromDb,
  getAdminClassRosterFromDb,
  listAllClassroomGradeRowsFromDb,
  getHighGradeStudentsFromDb,
  lookupPersonGradesAndRoleFromDb,
  getDingHistoryFromDb,
  findLatestDingNumberByAesopIdFromDb,
  recordPortalDingChangeInDb,
  persistClassroomSync,
  updateSyncRunBackupKey,
  exportSnapshotFromDb,
};
