const { eq, and, sql, desc, inArray } = require("drizzle-orm");
const { getDb, isDatabaseEnabled, getPool } = require("../db/index");
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
  if (!person) {
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
  if (!db) {
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
  if (!db) {
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
  if (!db) {
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
  if (!db) {
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
  if (!db) {
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
  if (!db) {
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
  if (!db) {
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
  if (!person) {
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

async function getDingHistoryFromDb(personId, maxRows = 10) {
  const db = getDb();
  if (!db) {
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

    const personIdByEmail = new Map();
    for (const row of payload.people) {
      const result = await client.query(
        `INSERT INTO people (aesop_id, email, name, phone, portal_role, teacher_classes, synced_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (email) DO UPDATE SET
           aesop_id = COALESCE(EXCLUDED.aesop_id, people.aesop_id),
           name = COALESCE(EXCLUDED.name, people.name),
           phone = COALESCE(EXCLUDED.phone, people.phone),
           portal_role = EXCLUDED.portal_role,
           teacher_classes = EXCLUDED.teacher_classes,
           synced_at = EXCLUDED.synced_at
         RETURNING id`,
        [
          row.aesopId || null,
          row.email,
          row.name || null,
          row.phone || null,
          row.portalRole || null,
          row.teacherClasses || null,
          startedAt,
        ],
      );
      personIdByEmail.set(row.email, result.rows[0].id);
    }

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
      const personId = personIdByEmail.get(row.email);
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
      const personId = personIdByEmail.get(row.email);
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
      const personId = personIdByEmail.get(row.email);
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
    return { syncRunId, startedAt };
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

module.exports = {
  isDatabaseEnabled,
  normalizeEmail,
  parseGradePercent,
  getPersonByEmail,
  getPersonByAesopId,
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
  persistClassroomSync,
  updateSyncRunBackupKey,
  exportSnapshotFromDb,
};
