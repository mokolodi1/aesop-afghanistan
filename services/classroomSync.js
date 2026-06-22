const { google } = require("googleapis");
const config = require("../config/secrets");
const {
  replaceTabData,
  resolveColumnIndex,
  loadEmailToPeopleProfileMap,
  listAllClassroomGradeRows,
  isPeopleSheetAdminRole,
} = require("./googleSheets");
const { formatErrorForLog } = require("../utils/errorLogging");
const { isDatabaseEnabled } = require("../db/index");
const {
  persistClassroomSync,
  updateSyncRunBackupKey,
  getStudentGradesFromDb,
  getTeacherRosterFromDb,
} = require("./classroomDb");
const { exportSyncBackup } = require("./backupExport");
const { mirrorPeopleAndDingFromSheets } = require("./peopleMirror");

/**
 * Read-only Classroom scopes used by the unattended sync. The service account
 * impersonates a Workspace user (domain-wide delegation) to read all courses.
 */
const CLASSROOM_SYNC_SCOPES = [
  "https://www.googleapis.com/auth/classroom.courses.readonly",
  "https://www.googleapis.com/auth/classroom.rosters.readonly",
  "https://www.googleapis.com/auth/classroom.profile.emails",
  "https://www.googleapis.com/auth/classroom.coursework.students.readonly",
  "https://www.googleapis.com/auth/classroom.student-submissions.students.readonly",
];

/**
 * Build a Google Classroom client authenticated as the Gmail service account via
 * domain-wide delegation, impersonating config.classroom.impersonateEmail.
 * @returns {Promise<import('googleapis').classroom_v1.Classroom>}
 */
async function buildClassroomClient() {
  const credentials = config.email?.gmailServiceAccount?.credentials;
  if (!credentials?.client_email || !credentials?.private_key) {
    throw new Error(
      "Classroom sync requires email.gmailServiceAccount.credentials (client_email and private_key).",
    );
  }

  const subject = config.classroom?.impersonateEmail;
  if (!subject) {
    throw new Error(
      "Classroom sync requires classroom.impersonateEmail (CLASSROOM_IMPERSONATE_EMAIL) so the service account can act as a Workspace user that can see the courses.",
    );
  }

  const auth = new google.auth.JWT({
    email: credentials.client_email,
    key: credentials.private_key,
    scopes: CLASSROOM_SYNC_SCOPES,
    subject,
  });
  await auth.authorize();

  return google.classroom({ version: "v1", auth });
}

/**
 * Collect every page of a Classroom list endpoint.
 * @template T
 * @param {(pageToken?: string) => Promise<{ items: T[], next?: string }>} fetchPage
 * @returns {Promise<T[]>}
 */
async function paginate(fetchPage) {
  const out = [];
  let token;
  do {
    const { items, next } = await fetchPage(token);
    out.push(...items);
    token = next;
  } while (token);
  return out;
}

/** Delimiter for multi-class lists in Classroom Roles (course names may contain commas). */
const CLASS_LIST_DELIMITER = " | ";

/**
 * Human-friendly class label for a course (name plus section when present).
 * @param {import('googleapis').classroom_v1.Schema$Course} course
 * @returns {string}
 */
function courseLabel(course) {
  const name = (course.name || "").trim() || "(unnamed course)";
  const section = (course.section || "").trim();
  return section ? `${name} (${section})` : name;
}

function normalizeEmail(email) {
  return typeof email === "string" ? email.trim().toLowerCase() : "";
}

/**
 * Pull all active courses, their teachers/students, coursework, and submissions
 * from Google Classroom, then rewrite the Classroom Roles and Classroom Grades
 * tabs (keyed by email). Idempotent: each run fully replaces the tab contents.
 *
 * @returns {Promise<{ courses: number, teachers: number, students: number, gradeRows: number }>}
 */
async function runClassroomSync() {
  if (!config.classroom?.enabled) {
    throw new Error(
      "Classroom sync is disabled. Set classroom.enabled (or CLASSROOM_SYNC_ENABLED=true) to run it.",
    );
  }

  const classroom = await buildClassroomClient();

  const courses = await paginate(async (pageToken) => {
    const res = await classroom.courses.list({
      courseStates: ["ACTIVE"],
      pageSize: 100,
      pageToken,
    });
    return { items: res.data.courses ?? [], next: res.data.nextPageToken ?? undefined };
  });

  /** email -> Set(class labels they teach) */
  const teacherClasses = new Map();
  /** email -> display name (best effort) */
  const emailToName = new Map();
  /** email -> Set(class labels enrolled) */
  const studentSections = new Map();
  /** `${email}\0${courseLabel}` -> { email, label, earned, possible } */
  const studentGrades = new Map();
  /** DB payload collectors */
  const dbCourses = [];
  const dbAssignments = [];
  const dbAssignmentGrades = [];
  const dbEnrollments = [];

  const gradeKey = (email, courseLabel) => `${email}\0${courseLabel}`;

  const addToMapSet = (map, key, value) => {
    if (!map.has(key)) {
      map.set(key, new Set());
    }
    if (value) {
      map.get(key).add(value);
    }
  };

  for (const course of courses) {
    if (!course.id) {
      continue;
    }
    const label = courseLabel(course);
    dbCourses.push({
      classroomCourseId: course.id,
      label,
      section: (course.section || "").trim(),
      state: course.courseState || "ACTIVE",
    });

    // The impersonated user is not a member of every course in the org. Reading
    // a course they can't access throws 403; skip those instead of aborting the
    // whole sync. Grades (courseWork/submissions) require course membership even
    // when the roster is visible, so degrade gracefully and keep roles/sections.
    let teachers;
    let students;
    try {
      teachers = await paginate(async (pageToken) => {
        const res = await classroom.courses.teachers.list({
          courseId: course.id,
          pageSize: 100,
          pageToken,
        });
        return { items: res.data.teachers ?? [], next: res.data.nextPageToken ?? undefined };
      });

      students = await paginate(async (pageToken) => {
        const res = await classroom.courses.students.list({
          courseId: course.id,
          pageSize: 100,
          pageToken,
        });
        return { items: res.data.students ?? [], next: res.data.nextPageToken ?? undefined };
      });
    } catch (courseErr) {
      console.warn(
        `[classroom-sync] skipping course "${label}" (roster not accessible): ${courseErr.message}`,
      );
      continue;
    }

    for (const t of teachers) {
      const email = normalizeEmail(t.profile?.emailAddress);
      if (!email) {
        continue;
      }
      addToMapSet(teacherClasses, email, label);
      dbEnrollments.push({ email, classroomCourseId: course.id, role: "teacher" });
      const name = t.profile?.name?.fullName;
      if (name && !emailToName.has(email)) {
        emailToName.set(email, name);
      }
    }

    /** Classroom userId -> email (for joining submissions) */
    const userIdToEmail = new Map();
    for (const s of students) {
      const email = normalizeEmail(s.profile?.emailAddress);
      if (!email) {
        continue;
      }
      if (s.userId) {
        userIdToEmail.set(s.userId, email);
      }
      addToMapSet(studentSections, email, label);
      dbEnrollments.push({ email, classroomCourseId: course.id, role: "student" });
      const name = s.profile?.name?.fullName;
      if (name && !emailToName.has(email)) {
        emailToName.set(email, name);
      }
      const key = gradeKey(email, label);
      if (!studentGrades.has(key)) {
        studentGrades.set(key, { email, label, earned: 0, possible: 0 });
      }
    }

    try {
      // courseWorkId -> maxPoints
      const courseWork = await paginate(async (pageToken) => {
        const res = await classroom.courses.courseWork.list({
          courseId: course.id,
          pageSize: 100,
          pageToken,
        });
        return { items: res.data.courseWork ?? [], next: res.data.nextPageToken ?? undefined };
      });
      const maxPointsByWork = new Map();
      const titleByWork = new Map();
      for (const cw of courseWork) {
        if (cw.id) {
          maxPointsByWork.set(cw.id, typeof cw.maxPoints === "number" ? cw.maxPoints : null);
          titleByWork.set(cw.id, (cw.title || "").trim() || "Untitled assignment");
          dbAssignments.push({
            classroomCourseId: course.id,
            classroomWorkId: cw.id,
            title: titleByWork.get(cw.id),
            maxPoints: maxPointsByWork.get(cw.id),
          });
        }
      }

      const submissions = await paginate(async (pageToken) => {
        const res = await classroom.courses.courseWork.studentSubmissions.list({
          courseId: course.id,
          courseWorkId: "-",
          pageSize: 100,
          pageToken,
        });
        return {
          items: res.data.studentSubmissions ?? [],
          next: res.data.nextPageToken ?? undefined,
        };
      });

      for (const sub of submissions) {
        if (!sub.userId || !sub.courseWorkId) {
          continue;
        }
        const email = userIdToEmail.get(sub.userId);
        if (!email) {
          continue;
        }
        const grade = sub.assignedGrade ?? sub.draftGrade ?? null;
        const maxPoints = maxPointsByWork.get(sub.courseWorkId) ?? null;
        if (grade != null) {
          dbAssignmentGrades.push({
            email,
            classroomCourseId: course.id,
            classroomWorkId: sub.courseWorkId,
            earned: grade,
            display: formatAssignmentGrade(grade, maxPoints) || "—",
          });
        }
        if (grade != null && maxPoints != null) {
          const key = gradeKey(email, label);
          const acc = studentGrades.get(key) || { email, label, earned: 0, possible: 0 };
          acc.earned += grade;
          acc.possible += maxPoints;
          studentGrades.set(key, acc);
        }
      }
    } catch (gradeErr) {
      console.warn(
        `[classroom-sync] grades unavailable for "${label}" (kept roster only): ${gradeErr.message}`,
      );
    }
  }

  // Build the Classroom Roles rows (teachers win over student when both apply).
  const cr = config.classroom;
  const rolesEmailIdx = resolveColumnIndex(cr.rolesEmailColumn || "A");
  const rolesRoleIdx = resolveColumnIndex(cr.rolesRoleColumn || "B");
  const rolesClassesIdx = resolveColumnIndex(cr.rolesClassesColumn || "C");

  const roleEmails = new Set([...teacherClasses.keys(), ...studentSections.keys()]);
  const rolesRows = [];
  for (const email of roleEmails) {
    const isTeacher = teacherClasses.has(email);
    rolesRows.push({
      [rolesEmailIdx]: email,
      [rolesRoleIdx]: isTeacher ? "Teacher" : "Student",
      [rolesClassesIdx]: isTeacher
        ? Array.from(teacherClasses.get(email)).sort().join(CLASS_LIST_DELIMITER)
        : "",
    });
  }
  rolesRows.sort((a, b) => String(a[rolesEmailIdx]).localeCompare(String(b[rolesEmailIdx])));

  // Build the Classroom Grades rows (one per student per course).
  const gradesEmailIdx = resolveColumnIndex(cr.gradesEmailColumn || "A");
  const gradesNameIdx = resolveColumnIndex(cr.gradesNameColumn || "B");
  const gradesSectionIdx = resolveColumnIndex(cr.gradesSectionColumn || "C");
  const gradesGradeIdx = resolveColumnIndex(cr.gradesGradeColumn || "D");

  const gradesRows = [];
  for (const acc of studentGrades.values()) {
    const percent =
      acc.possible > 0 ? `${((acc.earned / acc.possible) * 100).toFixed(1)}%` : "";
    gradesRows.push({
      [gradesEmailIdx]: acc.email,
      [gradesNameIdx]: emailToName.get(acc.email) || "",
      [gradesSectionIdx]: acc.label,
      [gradesGradeIdx]: percent,
    });
  }
  gradesRows.sort((a, b) => {
    const byEmail = String(a[gradesEmailIdx]).localeCompare(String(b[gradesEmailIdx]));
    if (byEmail !== 0) {
      return byEmail;
    }
    return String(a[gradesSectionIdx]).localeCompare(String(b[gradesSectionIdx]));
  });

  const rolesHeader = {
    [rolesEmailIdx]: "Email",
    [rolesRoleIdx]: "Role",
    [rolesClassesIdx]: "Classes Taught",
  };
  const gradesHeader = {
    [gradesEmailIdx]: "Email",
    [gradesNameIdx]: "Name",
    [gradesSectionIdx]: "Section",
    [gradesGradeIdx]: "Calculated Grade",
  };

  const dualWriteSheets =
    process.env.CLASSROOM_SHEET_DUAL_WRITE == null ||
    String(process.env.CLASSROOM_SHEET_DUAL_WRITE).trim().toLowerCase() !== "false";

  if (dualWriteSheets) {
    await replaceTabData(cr.rolesSheetName || "Classroom Roles", rolesHeader, rolesRows);
    await replaceTabData(cr.gradesSheetName || "Classroom Grades", gradesHeader, gradesRows);
  }

  const summary = {
    courses: courses.length,
    teachers: teacherClasses.size,
    students: studentSections.size,
    gradeRows: gradesRows.length,
  };

  if (isDatabaseEnabled()) {
    try {
      const profileMap = await loadEmailToPeopleProfileMap();
      const peopleEmails = new Set([...teacherClasses.keys(), ...studentSections.keys()]);
      for (const row of dbEnrollments) {
        peopleEmails.add(row.email);
      }
      for (const row of dbAssignmentGrades) {
        peopleEmails.add(row.email);
      }
      for (const acc of studentGrades.values()) {
        peopleEmails.add(acc.email);
      }
      const dbPeople = [];
      for (const email of peopleEmails) {
        const profile = profileMap.get(email);
        const isTeacher = teacherClasses.has(email);
        const sheetPortalRole = profile?.portalRole || "";
        const portalRole = isPeopleSheetAdminRole(sheetPortalRole)
          ? "Admin"
          : isTeacher
            ? "Teacher"
            : "Student";
        dbPeople.push({
          email,
          aesopId: profile?.id || "",
          name: emailToName.get(email) || profile?.name || "",
          phone: profile?.phone || "",
          portalRole,
          teacherClasses: isTeacher
            ? Array.from(teacherClasses.get(email)).sort().join(CLASS_LIST_DELIMITER)
            : "",
        });
      }

      const dbCourseGrades = [];
      for (const acc of studentGrades.values()) {
        const courseEntry = dbCourses.find((entry) => entry.label === acc.label);
        if (!courseEntry) {
          continue;
        }
        dbCourseGrades.push({
          email: acc.email,
          classroomCourseId: courseEntry.classroomCourseId,
          calculatedPercent:
            acc.possible > 0 ? `${((acc.earned / acc.possible) * 100).toFixed(1)}%` : "",
          earned: acc.earned,
          possible: acc.possible,
        });
      }

      const { syncRunId } = await persistClassroomSync({
        courses: dbCourses,
        people: dbPeople,
        enrollments: dbEnrollments,
        courseGrades: dbCourseGrades,
        assignments: dbAssignments,
        assignmentGrades: dbAssignmentGrades,
        summary,
      });

      try {
        const mirrorResult = await mirrorPeopleAndDingFromSheets();
        console.log(
          `[classroom-sync] mirrored People/Ding: people=${mirrorResult.people}, dingNumbers=${mirrorResult.dingNumbers}, dingHistory=${mirrorResult.dingHistory}`,
        );
      } catch (mirrorErr) {
        console.warn("[classroom-sync] People/Ding mirror failed:", mirrorErr.message);
      }

      try {
        const backupResult = await exportSyncBackup(syncRunId);
        if (backupResult.manifestKey) {
          await updateSyncRunBackupKey(syncRunId, backupResult.manifestKey);
        }
        console.log("[classroom-sync] backup export:", JSON.stringify(backupResult));
      } catch (backupErr) {
        console.warn("[classroom-sync] backup export failed:", backupErr.message);
      }
    } catch (dbErr) {
      console.error("[classroom-sync] database persist failed:", formatErrorForLog(dbErr));
      if (!dualWriteSheets) {
        throw dbErr;
      }
      console.warn("[classroom-sync] continuing because sheet dual-write succeeded");
    }
  }

  return summary;
}

/**
 * Run `fn` over `items` with a bounded number of concurrent promises so we can
 * fan out Classroom API calls (which are otherwise slow when done serially)
 * without exhausting the per-user quota.
 * @template T, R
 * @param {T[]} items
 * @param {number} limit
 * @param {(item: T, index: number) => Promise<R>} fn
 * @returns {Promise<R[]>}
 */
async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let cursor = 0;
  const workers = new Array(Math.min(limit, items.length)).fill(null).map(async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await fn(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

function formatAssignmentGrade(grade, maxPoints) {
  if (grade != null && maxPoints != null) {
    return `${grade}/${maxPoints}`;
  }
  if (grade != null) {
    return String(grade);
  }
  return "";
}

/** Build the student roster (with per-class grades and assignments) for one course. */
function gradeRowMatchesCourseLabel(gradeRow, label) {
  const section = gradeRow?.classSection ? String(gradeRow.classSection).trim() : "";
  if (!section || !label) {
    return false;
  }
  if (section === label) {
    return true;
  }
  // Legacy rows may still list multiple courses in one cell.
  return section
    .split(",")
    .map((part) => part.trim())
    .includes(label);
}

async function buildCourseRoster(classroom, course, options = {}) {
  const includeAssignments = options.includeAssignments !== false;
  const useSheetGrades = options.useSheetGrades === true;
  const students = await paginate(async (pageToken) => {
    const res = await classroom.courses.students.list({
      courseId: course.id,
      pageSize: 100,
      pageToken,
    });
    return { items: res.data.students ?? [], next: res.data.nextPageToken ?? undefined };
  });

  /** Classroom userId -> email (for joining submissions) */
  const userIdToEmail = new Map();
  /** email -> { name, earned, possible, assignments } */
  const studentInfo = new Map();
  for (const s of students) {
    const email = normalizeEmail(s.profile?.emailAddress);
    if (!email) {
      continue;
    }
    if (s.userId) {
      userIdToEmail.set(s.userId, email);
    }
    studentInfo.set(email, {
      name: s.profile?.name?.fullName || "",
      earned: 0,
      possible: 0,
      assignments: [],
    });
  }

  if (useSheetGrades) {
    const label = courseLabel(course);
    const gradeRows = options.gradeRows || (await listAllClassroomGradeRows());
    const gradeByEmail = new Map();
    for (const row of gradeRows) {
      if (!gradeRowMatchesCourseLabel(row, label)) {
        continue;
      }
      const email = normalizeEmail(row.email);
      if (!email) {
        continue;
      }
      if (String(row.classSection).trim() === label) {
        gradeByEmail.set(email, row.calculatedGrade || "");
      }
    }
    for (const row of gradeRows) {
      if (!gradeRowMatchesCourseLabel(row, label)) {
        continue;
      }
      const email = normalizeEmail(row.email);
      if (!email || gradeByEmail.has(email)) {
        continue;
      }
      gradeByEmail.set(email, row.calculatedGrade || "");
    }

    const studentRows = Array.from(studentInfo.entries()).map(([email, info]) => ({
      email,
      name: info.name,
      userId: "",
      grade: gradeByEmail.get(email) || "",
      assignments: [],
    }));
    studentRows.sort((a, b) => (a.name || a.email).localeCompare(b.name || b.email));
    return { label, students: studentRows };
  }

  const courseWork = await paginate(async (pageToken) => {
    const res = await classroom.courses.courseWork.list({
      courseId: course.id,
      pageSize: 100,
      pageToken,
    });
    return { items: res.data.courseWork ?? [], next: res.data.nextPageToken ?? undefined };
  });
  const workById = new Map();
  for (const cw of courseWork) {
    if (cw.id) {
      workById.set(cw.id, {
        title: (cw.title || "").trim() || "Untitled assignment",
        maxPoints: typeof cw.maxPoints === "number" ? cw.maxPoints : null,
      });
    }
  }

  const submissions = await paginate(async (pageToken) => {
    const res = await classroom.courses.courseWork.studentSubmissions.list({
      courseId: course.id,
      courseWorkId: "-",
      pageSize: 100,
      pageToken,
    });
    return {
      items: res.data.studentSubmissions ?? [],
      next: res.data.nextPageToken ?? undefined,
    };
  });

  for (const sub of submissions) {
    if (!sub.userId || !sub.courseWorkId) {
      continue;
    }
    const email = userIdToEmail.get(sub.userId);
    if (!email) {
      continue;
    }
    const work = workById.get(sub.courseWorkId);
    if (!work) {
      continue;
    }
    const grade = sub.assignedGrade ?? sub.draftGrade ?? null;
    const maxPoints = work.maxPoints;
    const acc = studentInfo.get(email);
    if (!acc) {
      continue;
    }
    if (includeAssignments) {
      acc.assignments.push({
        title: work.title,
        grade: grade != null ? grade : null,
        maxPoints,
        display: formatAssignmentGrade(grade, maxPoints) || "—",
      });
    }
    if (grade != null && maxPoints != null) {
      acc.earned += grade;
      acc.possible += maxPoints;
    }
  }

  const studentRows = Array.from(studentInfo.entries()).map(([email, info]) => {
    if (includeAssignments) {
      info.assignments.sort((a, b) => a.title.localeCompare(b.title));
    }
    return {
      email,
      name: info.name,
      userId: "",
      grade: info.possible > 0 ? `${((info.earned / info.possible) * 100).toFixed(1)}%` : "",
      assignments: includeAssignments ? info.assignments : [],
    };
  });
  studentRows.sort((a, b) => (a.name || a.email).localeCompare(b.name || b.email));

  return { label: courseLabel(course), students: studentRows };
}

async function enrichStudentsWithPeopleIds(classes) {
  const profileMap = await loadEmailToPeopleProfileMap();
  for (const cls of classes) {
    for (const student of cls.students) {
      const profile = profileMap.get(normalizeEmail(student.email));
      student.userId = profile?.id || "";
      if (!student.name && profile?.name) {
        student.name = profile.name;
      }
    }
  }
}

/** Bump when roster payload shape changes (invalidates stale in-memory cache). */
const ROSTER_CACHE_VERSION = 2;

/** In-memory cache for teacher rosters: email -> { at: number, data }. */
const TEACHER_ROSTER_TTL_MS = 5 * 60 * 1000;
const teacherRosterCache = new Map();

/**
 * Live (un-synced) per-class roster for a single teacher. Finds the active
 * courses where `teacherEmail` is a teacher and returns, for each, the enrolled
 * students with their grade *in that class* (earned/possible across graded work).
 *
 * Unlike runClassroomSync (which writes aggregate grades to the sheet), this is
 * computed on demand so teachers always see current data without waiting for a
 * sync, and grades are scoped to the specific class rather than overall. Course
 * lookups and per-course rosters are fetched concurrently, and results are
 * cached briefly so repeat loads are instant.
 *
 * @param {string} teacherEmail
 * @param {{ force?: boolean }} [options]
 * @returns {Promise<{ classes: Array<{ label: string, students: Array<{ name: string, email: string, grade: string }> }> }>}
 */
async function getTeacherRoster(teacherEmail, options = {}) {
  const target = normalizeEmail(teacherEmail);
  if (!target) {
    throw new Error("getTeacherRoster requires a teacher email.");
  }

  if (!options.force && isDatabaseEnabled()) {
    try {
      const fromDb = await getTeacherRosterFromDb(target);
      if (fromDb && fromDb.classes.length > 0) {
        return fromDb;
      }
    } catch (dbErr) {
      console.warn("[classroom] teacher roster DB read failed; falling back to live API:", dbErr.message);
    }
  }

  if (!options.force) {
    const cached = teacherRosterCache.get(target);
    if (
      cached &&
      cached.version === ROSTER_CACHE_VERSION &&
      Date.now() - cached.at < TEACHER_ROSTER_TTL_MS
    ) {
      return cached.data;
    }
  }

  const classroom = await buildClassroomClient();

  const courses = await paginate(async (pageToken) => {
    const res = await classroom.courses.list({
      courseStates: ["ACTIVE"],
      pageSize: 100,
      pageToken,
    });
    return { items: res.data.courses ?? [], next: res.data.nextPageToken ?? undefined };
  });

  const withId = courses.filter((c) => c.id);

  // Determine which courses this teacher teaches (concurrently).
  const teaches = await mapWithConcurrency(withId, 8, async (course) => {
    const teachers = await paginate(async (pageToken) => {
      const res = await classroom.courses.teachers.list({
        courseId: course.id,
        pageSize: 100,
        pageToken,
      });
      return { items: res.data.teachers ?? [], next: res.data.nextPageToken ?? undefined };
    });
    return teachers.some((t) => normalizeEmail(t.profile?.emailAddress) === target);
  });
  const myCourses = withId.filter((_, i) => teaches[i]);

  // Build each roster concurrently (this is the expensive part).
  const classes = await mapWithConcurrency(myCourses, 6, (course) =>
    buildCourseRoster(classroom, course),
  );
  classes.sort((a, b) => a.label.localeCompare(b.label));

  await enrichStudentsWithPeopleIds(classes);

  const data = { classes };
  teacherRosterCache.set(target, { at: Date.now(), version: ROSTER_CACHE_VERSION, data });
  return data;
}

/** Bump when student grades payload shape changes. */
const STUDENT_GRADES_CACHE_VERSION = 2;

/** In-memory cache for student grade detail: email -> { at, data }. */
const STUDENT_GRADES_TTL_MS = 5 * 60 * 1000;
const studentGradesCache = new Map();

/**
 * Live per-class assignment grades for a single enrolled student.
 * @param {string} studentEmail
 * @param {{ force?: boolean }} [options]
 * @returns {Promise<{ classes: Array<{ label: string, grade: string, assignments: Array<{ title: string, display: string }> }> }>}
 */
async function getStudentGrades(studentEmail, options = {}) {
  const target = normalizeEmail(studentEmail);
  if (!target) {
    throw new Error("getStudentGrades requires a student email.");
  }

  if (!options.force && isDatabaseEnabled()) {
    try {
      const fromDb = await getStudentGradesFromDb(target);
      if (fromDb && fromDb.classes.length > 0) {
        return fromDb;
      }
    } catch (dbErr) {
      console.warn("[classroom] student grades DB read failed; falling back to live API:", dbErr.message);
    }
  }

  if (!options.force) {
    const cached = studentGradesCache.get(target);
    if (
      cached &&
      cached.version === STUDENT_GRADES_CACHE_VERSION &&
      Date.now() - cached.at < STUDENT_GRADES_TTL_MS
    ) {
      return cached.data;
    }
  }

  const classroom = await buildClassroomClient();

  const courses = await paginate(async (pageToken) => {
    const res = await classroom.courses.list({
      courseStates: ["ACTIVE"],
      pageSize: 100,
      pageToken,
    });
    return { items: res.data.courses ?? [], next: res.data.nextPageToken ?? undefined };
  });

  const withId = courses.filter((c) => c.id);

  const enrolledFlags = await mapWithConcurrency(withId, 8, async (course) => {
    const students = await paginate(async (pageToken) => {
      const res = await classroom.courses.students.list({
        courseId: course.id,
        pageSize: 100,
        pageToken,
      });
      return { items: res.data.students ?? [], next: res.data.nextPageToken ?? undefined };
    });
    return students.some((s) => normalizeEmail(s.profile?.emailAddress) === target);
  });
  const myCourses = withId.filter((_, i) => enrolledFlags[i]);

  const rosters = await mapWithConcurrency(myCourses, 6, (course) => buildCourseRoster(classroom, course));

  const classes = rosters
    .map((roster) => {
      const student = roster.students.find((s) => normalizeEmail(s.email) === target);
      if (!student) {
        return null;
      }
      return {
        label: roster.label,
        grade: student.grade,
        assignments: student.assignments,
      };
    })
    .filter(Boolean);
  classes.sort((a, b) => a.label.localeCompare(b.label));

  const data = { classes };
  studentGradesCache.set(target, { at: Date.now(), version: STUDENT_GRADES_CACHE_VERSION, data });
  return data;
}

/** Bump when admin all-classes roster payload shape changes. */
const ALL_CLASSES_ROSTER_CACHE_VERSION = 1;

/** In-memory cache for the org-wide admin roster (single entry, not per-user). */
const ALL_CLASSES_ROSTER_TTL_MS = 5 * 60 * 1000;
const allClassesRosterCache = { at: 0, version: 0, data: null };

/**
 * Live per-class rosters for every accessible ACTIVE course (admin view).
 * Uses the impersonated Workspace user to list all courses, then builds each
 * roster with current Google Classroom grades. Inaccessible courses are skipped.
 *
 * @param {{ force?: boolean }} [options]
 * @returns {Promise<{ classes: Array<{ label: string, students: Array<object> }>, skippedCourses: number }>}
 */
async function getAllClassesRoster(options = {}) {
  if (!options.force) {
    const cached = allClassesRosterCache;
    if (
      cached.data &&
      cached.version === ALL_CLASSES_ROSTER_CACHE_VERSION &&
      Date.now() - cached.at < ALL_CLASSES_ROSTER_TTL_MS
    ) {
      return cached.data;
    }
  }

  const classroom = await buildClassroomClient();

  const courses = await paginate(async (pageToken) => {
    const res = await classroom.courses.list({
      courseStates: ["ACTIVE"],
      pageSize: 100,
      pageToken,
    });
    return { items: res.data.courses ?? [], next: res.data.nextPageToken ?? undefined };
  });

  const withId = courses.filter((c) => c.id);

  const rosterResults = await mapWithConcurrency(withId, 6, async (course) => {
    try {
      return await buildCourseRoster(classroom, course);
    } catch (courseErr) {
      console.warn(
        `[classroom] skipping course "${courseLabel(course)}" (roster unavailable): ${courseErr.message}`,
      );
      return null;
    }
  });

  const classes = rosterResults.filter(Boolean);
  classes.sort((a, b) => a.label.localeCompare(b.label));
  await enrichStudentsWithPeopleIds(classes);

  const data = { classes, skippedCourses: withId.length - classes.length };
  allClassesRosterCache.at = Date.now();
  allClassesRosterCache.version = ALL_CLASSES_ROSTER_CACHE_VERSION;
  allClassesRosterCache.data = data;
  return data;
}

/** In-memory cache for single-class rosters: courseId -> { at, data }. */
const CLASS_ROSTER_BY_ID_TTL_MS = 5 * 60 * 1000;
const classRosterByIdCache = new Map();

/**
 * List ACTIVE courses visible to the impersonated user (fast — no rosters).
 * @returns {Promise<Array<{ courseId: string, label: string }>>}
 */
async function listActiveCourses() {
  const classroom = await buildClassroomClient();
  const courses = await paginate(async (pageToken) => {
    const res = await classroom.courses.list({
      courseStates: ["ACTIVE"],
      pageSize: 100,
      pageToken,
    });
    return { items: res.data.courses ?? [], next: res.data.nextPageToken ?? undefined };
  });
  return courses
    .filter((c) => c.id)
    .map((c) => ({ courseId: c.id, label: courseLabel(c) }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

/**
 * Live roster for one course (grades from Classroom; assignments optional).
 * @param {string} courseId
 * @param {{ force?: boolean, includeAssignments?: boolean }} [options]
 */
async function getClassRosterByCourseId(courseId, options = {}) {
  const id = typeof courseId === "string" ? courseId.trim() : "";
  if (!id) {
    throw new Error("getClassRosterByCourseId requires a courseId.");
  }
  const includeAssignments = options.includeAssignments === true;
  const useSheetGrades = options.useSheetGrades !== false && !includeAssignments;
  const cacheKey = `${id}:${includeAssignments ? "full" : useSheetGrades ? "sheet" : "summary"}`;

  if (!options.force) {
    const cached = classRosterByIdCache.get(cacheKey);
    if (cached && Date.now() - cached.at < CLASS_ROSTER_BY_ID_TTL_MS) {
      return cached.data;
    }
  }

  const classroom = await buildClassroomClient();
  const courseRes = await classroom.courses.get({ id });
  const course = courseRes.data;
  if (!course?.id) {
    throw new Error("Course not found.");
  }

  const roster = await buildCourseRoster(classroom, course, { includeAssignments, useSheetGrades });
  await enrichStudentsWithPeopleIds([roster]);

  const data = { courseId: id, label: roster.label, students: roster.students };
  classRosterByIdCache.set(cacheKey, { at: Date.now(), data });
  return data;
}

module.exports = {
  runClassroomSync,
  buildClassroomClient,
  getTeacherRoster,
  getStudentGrades,
  getAllClassesRoster,
  listActiveCourses,
  getClassRosterByCourseId,
};

// Allow running directly: `node services/classroomSync.js`.
if (require.main === module) {
  runClassroomSync()
    .then((summary) => {
      console.log(
        `[classroom-sync] done: ${summary.courses} course(s), ${summary.teachers} teacher(s), ${summary.students} student(s), ${summary.gradeRows} grade row(s).`,
      );
      process.exit(0);
    })
    .catch((error) => {
      console.error("[classroom-sync] failed:", formatErrorForLog(error));
      process.exit(1);
    });
}
