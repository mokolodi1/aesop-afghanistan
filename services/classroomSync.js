const { google } = require("googleapis");
const config = require("../config/secrets");
const { replaceTabData, resolveColumnIndex } = require("./googleSheets");
const { formatErrorForLog } = require("../utils/errorLogging");

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
  /** email -> { earned, possible } */
  const studentGrades = new Map();

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
      const name = s.profile?.name?.fullName;
      if (name && !emailToName.has(email)) {
        emailToName.set(email, name);
      }
      if (!studentGrades.has(email)) {
        studentGrades.set(email, { earned: 0, possible: 0 });
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
      for (const cw of courseWork) {
        if (cw.id) {
          maxPointsByWork.set(cw.id, typeof cw.maxPoints === "number" ? cw.maxPoints : null);
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
        if (grade != null && maxPoints != null) {
          const acc = studentGrades.get(email) || { earned: 0, possible: 0 };
          acc.earned += grade;
          acc.possible += maxPoints;
          studentGrades.set(email, acc);
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
        ? Array.from(teacherClasses.get(email)).sort().join(", ")
        : "",
    });
  }
  rolesRows.sort((a, b) => String(a[rolesEmailIdx]).localeCompare(String(b[rolesEmailIdx])));

  // Build the Classroom Grades rows (one per enrolled student).
  const gradesEmailIdx = resolveColumnIndex(cr.gradesEmailColumn || "A");
  const gradesNameIdx = resolveColumnIndex(cr.gradesNameColumn || "B");
  const gradesSectionIdx = resolveColumnIndex(cr.gradesSectionColumn || "C");
  const gradesGradeIdx = resolveColumnIndex(cr.gradesGradeColumn || "D");

  const gradesRows = [];
  for (const email of studentSections.keys()) {
    const acc = studentGrades.get(email) || { earned: 0, possible: 0 };
    const percent =
      acc.possible > 0 ? `${((acc.earned / acc.possible) * 100).toFixed(1)}%` : "";
    gradesRows.push({
      [gradesEmailIdx]: email,
      [gradesNameIdx]: emailToName.get(email) || "",
      [gradesSectionIdx]: Array.from(studentSections.get(email)).sort().join(", "),
      [gradesGradeIdx]: percent,
    });
  }
  gradesRows.sort((a, b) => String(a[gradesEmailIdx]).localeCompare(String(b[gradesEmailIdx])));

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

  await replaceTabData(cr.rolesSheetName || "Classroom Roles", rolesHeader, rolesRows);
  await replaceTabData(cr.gradesSheetName || "Classroom Grades", gradesHeader, gradesRows);

  return {
    courses: courses.length,
    teachers: teacherClasses.size,
    students: studentSections.size,
    gradeRows: gradesRows.length,
  };
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

/** Build the student roster (with per-class grades) for one course. */
async function buildCourseRoster(classroom, course) {
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
  /** email -> { name, earned, possible } */
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
    });
  }

  const courseWork = await paginate(async (pageToken) => {
    const res = await classroom.courses.courseWork.list({
      courseId: course.id,
      pageSize: 100,
      pageToken,
    });
    return { items: res.data.courseWork ?? [], next: res.data.nextPageToken ?? undefined };
  });
  const maxPointsByWork = new Map();
  for (const cw of courseWork) {
    if (cw.id) {
      maxPointsByWork.set(cw.id, typeof cw.maxPoints === "number" ? cw.maxPoints : null);
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
    if (grade != null && maxPoints != null) {
      const acc = studentInfo.get(email);
      if (acc) {
        acc.earned += grade;
        acc.possible += maxPoints;
      }
    }
  }

  const studentRows = Array.from(studentInfo.entries()).map(([email, info]) => ({
    email,
    name: info.name,
    grade: info.possible > 0 ? `${((info.earned / info.possible) * 100).toFixed(1)}%` : "",
  }));
  studentRows.sort((a, b) => (a.name || a.email).localeCompare(b.name || b.email));

  return { label: courseLabel(course), students: studentRows };
}

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

  if (!options.force) {
    const cached = teacherRosterCache.get(target);
    if (cached && Date.now() - cached.at < TEACHER_ROSTER_TTL_MS) {
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

  const data = { classes };
  teacherRosterCache.set(target, { at: Date.now(), data });
  return data;
}

module.exports = {
  runClassroomSync,
  buildClassroomClient,
  getTeacherRoster,
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
