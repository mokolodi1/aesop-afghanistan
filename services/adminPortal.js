const config = require("../config/secrets");
const { isDatabaseEnabled } = require("../db/index");
const {
  getSyncStats,
  getHighGradeStudentsFromDb,
  getAdminClassListFromDb,
  getAdminClassRosterFromDb,
  getRoleByEmailFromDb,
  getGradesByEmailFromDb,
  getStudentGradesFromDb,
  getTeacherRosterFromDb,
  lookupPersonGradesAndRoleFromDb,
  getPersonByAesopId,
} = require("./classroomDb");
const { normalizeAfghanistanPhoneDigits } = require("../utils/validation");
const {
  loadEmailToPeopleProfileMap,
  buildLatestDingNumberByUserIdMap,
  listAllClassroomGradeRows,
  listAllClassroomRoleRows,
  searchPeopleProfiles,
  getClassroomTabStats,
  getRoleByEmail,
  getAllClassGradesByEmail,
  expandClassGradeRow,
  getPortalDingChangeHistory,
  isPeopleSheetAdminRole,
} = require("./googleSheets");
const { listActiveCourses, getClassRosterByCourseId, getStudentGrades, getTeacherRoster } = require("./classroomSync");

const DING_MAP_CACHE_TTL_MS = 5 * 60 * 1000;
/** @type {{ at: number, map: Map<string, string> | null }} */
let dingMapCache = { at: 0, map: null };
/** @type {{ at: number, rows: Array<{ email: string, name: string, classSection: string, calculatedGrade: string }> | null }} */
let gradeRowsCache = { at: 0, rows: null };
/** @type {{ at: number, rows: Array<{ email: string, role: string, teacherClasses: string }> | null }} */
let roleRowsCache = { at: 0, rows: null };
/** @type {{ at: number, map: Map<string, { id: string, name: string }> | null }} */
let peopleProfileCache = { at: 0, map: null };
/** @type {{ at: number, classes: Array<{ courseId: string, label: string }> | null }} */
let classListCache = { at: 0, classes: null };
/** @type {Map<string, { at: number, data: object }>} */
const adminRosterCache = new Map();
const ADMIN_ROSTER_CACHE_TTL_MS = 5 * 60 * 1000;

async function getCachedDingNumberMap() {
  if (dingMapCache.map && Date.now() - dingMapCache.at < DING_MAP_CACHE_TTL_MS) {
    return dingMapCache.map;
  }
  const map = await buildLatestDingNumberByUserIdMap();
  dingMapCache = { at: Date.now(), map };
  return map;
}

async function getCachedGradeRows() {
  if (gradeRowsCache.rows && Date.now() - gradeRowsCache.at < DING_MAP_CACHE_TTL_MS) {
    return gradeRowsCache.rows;
  }
  const rows = await listAllClassroomGradeRows();
  gradeRowsCache = { at: Date.now(), rows };
  return rows;
}

async function getCachedRoleRows() {
  if (roleRowsCache.rows && Date.now() - roleRowsCache.at < DING_MAP_CACHE_TTL_MS) {
    return roleRowsCache.rows;
  }
  const rows = await listAllClassroomRoleRows();
  roleRowsCache = { at: Date.now(), rows };
  return rows;
}

/**
 * Match a course label inside a teacher's comma-/pipe-delimited class list.
 * Course names may contain commas, so never split teacherClasses on "," alone.
 * @param {string} taught
 * @param {string} label
 */
function teacherTeachesCourse(taught, label) {
  const haystack = typeof taught === "string" ? taught : "";
  const needle = typeof label === "string" ? label.trim() : "";
  if (!haystack || !needle) {
    return false;
  }
  const idx = haystack.indexOf(needle);
  if (idx === -1) {
    return false;
  }
  const before = idx === 0 ? "" : haystack[idx - 1];
  const after = haystack[idx + needle.length] ?? "";
  const delim = (ch) => ch === "," || ch === "|";
  const beforeOk = idx === 0 || delim(before) || before === " ";
  const afterOk =
    idx + needle.length === haystack.length || delim(after) || after === " ";
  return beforeOk && afterOk;
}

/**
 * @param {Array<{ email: string, role: string, teacherClasses: string }>} roleRows
 * @param {Map<string, { id: string, name: string }>} profileMap
 * @param {string[]} courseLabels
 * @returns {Map<string, string[]>}
 */
function buildTeachersByCourseLabel(roleRows, profileMap, courseLabels) {
  const map = new Map(courseLabels.map((label) => [label, new Set()]));
  for (const row of roleRows) {
    if (String(row.role).trim().toLowerCase() !== "teacher") {
      continue;
    }
    const taught = String(row.teacherClasses || "");
    if (!taught) {
      continue;
    }
    const teacherName = profileMap.get(row.email)?.name || row.email;
    for (const label of courseLabels) {
      if (teacherTeachesCourse(taught, label)) {
        map.get(label).add(teacherName);
      }
    }
  }
  const out = new Map();
  for (const [label, names] of map.entries()) {
    out.set(label, [...names].sort((a, b) => a.localeCompare(b)));
  }
  return out;
}

async function getCachedPeopleProfileMap() {
  if (peopleProfileCache.map && Date.now() - peopleProfileCache.at < DING_MAP_CACHE_TTL_MS) {
    return peopleProfileCache.map;
  }
  const map = await loadEmailToPeopleProfileMap();
  peopleProfileCache = { at: Date.now(), map };
  return map;
}

async function getCachedClassList() {
  if (classListCache.classes && Date.now() - classListCache.at < DING_MAP_CACHE_TTL_MS) {
    return classListCache.classes;
  }
  const classes = await listActiveCourses();
  classListCache = { at: Date.now(), classes };
  return classes;
}

function attachDingNumbers(students, dingByUserId) {
  for (const student of students) {
    const dingRaw = student.userId ? dingByUserId.get(String(student.userId).toLowerCase()) || "" : "";
    student.dingNumber = dingRaw ? normalizeAfghanistanPhoneDigits(dingRaw) || dingRaw : "";
  }
}

/**
 * @param {string|{ email?: string, portalRole?: string }} emailOrProfile
 * @returns {boolean}
 */
function isPortalAdmin(emailOrProfile) {
  const email =
    typeof emailOrProfile === "string"
      ? emailOrProfile
      : typeof emailOrProfile?.email === "string"
        ? emailOrProfile.email
        : "";
  const portalRole =
    typeof emailOrProfile === "object" && emailOrProfile ? emailOrProfile.portalRole : "";
  const normalized = typeof email === "string" ? email.trim().toLowerCase() : "";
  if (!normalized) {
    return isPeopleSheetAdminRole(portalRole);
  }
  const allowlist = config.admin?.emails;
  if (Array.isArray(allowlist) && allowlist.length > 0 && allowlist.includes(normalized)) {
    return true;
  }
  return isPeopleSheetAdminRole(portalRole);
}

/**
 * @param {string} email
 * @returns {boolean}
 */
function isAdminEmail(email) {
  return isPortalAdmin(email);
}

/**
 * Parse a calculated grade like "90.8%" to a number.
 * @param {string} raw
 * @returns {number|null}
 */
function parseGradePercent(raw) {
  if (raw == null) {
    return null;
  }
  const s = String(raw).trim().replace("%", "");
  const n = Number.parseFloat(s);
  return Number.isFinite(n) ? n : null;
}

/**
 * @returns {Promise<{ classroomEnabled: boolean, rolesRows: number, gradesRows: number, syncHint: string }>}
 */
async function getAdminDashboard() {
  const classroomEnabled = !!config.classroom?.enabled;
  if (isDatabaseEnabled()) {
    try {
      const dbStats = await getSyncStats();
      return {
        classroomEnabled,
        databaseEnabled: true,
        rolesRows: dbStats.rolesRows,
        gradesRows: dbStats.gradesRows,
        rolesTab: "people (database)",
        gradesTab: "course_grades (database)",
        gradeThreshold: config.admin?.gradeThreshold ?? 65,
        dingConnectTopUpAmount: config.admin?.dingConnectTopUpAmount ?? "",
        dingConnectTopUpSku: config.admin?.dingConnectTopUpSku ?? "",
        lastSyncedAt: dbStats.lastSyncedAt,
        backupExportKey: dbStats.lastSyncRun?.backupExportKey || "",
        syncHint: classroomEnabled
          ? "Classroom data is cached in Postgres. Run npm run sync:classroom daily (Fly scheduled job) to refresh."
          : "Set CLASSROOM_SYNC_ENABLED=true and run the Classroom sync to populate the database.",
      };
    } catch (dbErr) {
      console.warn("[admin] dashboard DB stats failed:", dbErr.message);
    }
  }

  const stats = await getClassroomTabStats();
  return {
    classroomEnabled,
    databaseEnabled: false,
    rolesRows: stats.rolesRows,
    gradesRows: stats.gradesRows,
    rolesTab: stats.rolesTitle,
    gradesTab: stats.gradesTitle,
    gradeThreshold: config.admin?.gradeThreshold ?? 65,
    dingConnectTopUpAmount: config.admin?.dingConnectTopUpAmount ?? "",
    dingConnectTopUpSku: config.admin?.dingConnectTopUpSku ?? "",
    lastSyncedAt: null,
    backupExportKey: "",
    syncHint: classroomEnabled
      ? "Run npm run sync:classroom (or the scheduled Fly job) to refresh Classroom Roles and Classroom Grades tabs."
      : "Set CLASSROOM_SYNC_ENABLED=true and run the Classroom sync to populate grade tabs.",
  };
}

/**
 * Students with calculated grade strictly above threshold, with Ding numbers.
 * @param {number} [threshold]
 */
async function getHighGradeStudents(threshold) {
  const minGrade =
    typeof threshold === "number" && Number.isFinite(threshold)
      ? threshold
      : config.admin?.gradeThreshold ?? 65;

  if (isDatabaseEnabled()) {
    try {
      const fromDb = await getHighGradeStudentsFromDb(minGrade);
      if (fromDb) {
        return fromDb;
      }
    } catch (dbErr) {
      console.warn("[admin] high grades DB read failed:", dbErr.message);
    }
  }

  const [gradeRows, emailToProfile, dingByUserId] = await Promise.all([
    listAllClassroomGradeRows(),
    loadEmailToPeopleProfileMap(),
    getCachedDingNumberMap(),
  ]);

  const students = [];
  for (const row of gradeRows) {
    const pct = parseGradePercent(row.calculatedGrade);
    if (pct == null || pct <= minGrade) {
      continue;
    }
    const profile = emailToProfile.get(row.email);
    const userId = profile?.id || "";
    const dingRaw = userId ? dingByUserId.get(userId.toLowerCase()) || "" : "";
    const dingNumber = dingRaw ? normalizeAfghanistanPhoneDigits(dingRaw) || dingRaw : "";
    students.push({
      name: row.name || profile?.name || "",
      email: row.email,
      userId,
      dingNumber,
      calculatedGrade: row.calculatedGrade,
      gradePercent: pct,
      classSection: row.classSection,
    });
  }

  students.sort((a, b) => b.gradePercent - a.gradePercent || a.name.localeCompare(b.name));
  return { threshold: minGrade, students };
}

/**
 * DingConnect+ bulk CSV rows: Number, Amount, Sku for students above grade threshold with a Ding number.
 * @param {number} [threshold]
 */
async function buildDingConnectTopUpCsv(threshold) {
  const { students, threshold: usedThreshold } = await getHighGradeStudents(threshold);
  const amount = config.admin?.dingConnectTopUpAmount ?? "";
  const sku = config.admin?.dingConnectTopUpSku ?? "";

  const eligible = students.filter((s) => s.dingNumber && String(s.dingNumber).trim());
  const header = "Number,Amount,Sku";
  const lines = eligible.map((s) => {
    const number = String(s.dingNumber).replace(/"/g, '""');
    const amountEsc = String(amount).replace(/"/g, '""');
    const skuEsc = String(sku).replace(/"/g, '""');
    return `"${number}","${amountEsc}","${skuEsc}"`;
  });

  return {
    threshold: usedThreshold,
    rowCount: eligible.length,
    skippedWithoutDing: students.length - eligible.length,
    amount,
    sku,
    csv: [header, ...lines].join("\n"),
    students: eligible.map((s) => ({
      name: s.name,
      userId: s.userId,
      dingNumber: s.dingNumber,
      calculatedGrade: s.calculatedGrade,
    })),
  };
}

/**
 * Admin student lookup from People + Classroom sheets (fast; no live Classroom scan).
 * @param {string} query
 */
async function lookupStudentForAdmin(query) {
  const matches = await searchPeopleProfiles(query, 10);
  if (matches.length === 0) {
    return { matches: [], detail: null };
  }

  const primary = matches[0];
  const email = primary.email ? primary.email.trim().toLowerCase() : "";
  let role = { found: false, role: "", isTeacher: false, teacherClasses: "" };
  let classGrades = [];
  let dingHistory = [];
  let dingNumber = "";
  let liveClasses = [];

  if (isDatabaseEnabled() && primary.id) {
    try {
      const fromDb = await lookupPersonGradesAndRoleFromDb(primary.id);
      if (fromDb) {
        role = fromDb.role;
        classGrades = fromDb.classGrades;
        dingHistory = fromDb.dingHistory.map((row) => ({
          dingNumber: row.dingNumber,
          timestamp: row.changedAt,
          source: row.source,
        }));
        dingNumber = fromDb.dingNumber
          ? normalizeAfghanistanPhoneDigits(fromDb.dingNumber) || fromDb.dingNumber
          : "";
      }
    } catch (dbErr) {
      console.warn("[admin] lookup DB read failed:", dbErr.message);
    }
  }

  if (!role.found && email) {
    const [roleResult, grades] = await Promise.all([
      isDatabaseEnabled() ? getRoleByEmailFromDb(email) : getRoleByEmail(email),
      isDatabaseEnabled() ? getGradesByEmailFromDb(email) : getAllClassGradesByEmail(email),
    ]);
    role = roleResult;
    classGrades = grades;
  }

  if (!dingNumber && primary.id) {
    try {
      dingHistory = await getPortalDingChangeHistory(primary.id, { maxRows: 10 });
    } catch {
      dingHistory = [];
    }
    const dingByUserId = await getCachedDingNumberMap();
    const dingRaw = dingByUserId.get(primary.id.toLowerCase()) || "";
    dingNumber = dingRaw ? normalizeAfghanistanPhoneDigits(dingRaw) || dingRaw : "";
  }

  if (email && config.classroom?.enabled) {
    try {
      const gradesView = await getStudentGradesFromDb(email);
      if (gradesView?.classes?.length) {
        liveClasses = gradesView.classes;
      }
    } catch {
      liveClasses = [];
    }
  }

  const classSection = classGrades
    .map((row) => row.classSection)
    .filter(Boolean)
    .join(", ");
  const calculatedGrade = classGrades.length === 1 ? classGrades[0].calculatedGrade : "";

  return {
    matches,
    detail: {
      ...primary,
      dingNumber,
      role: role.role,
      isTeacher: role.isTeacher,
      teacherClasses: role.teacherClasses,
      classSection,
      calculatedGrade,
      classGrades,
      dingHistory,
      liveClasses,
    },
  };
}

/**
 * Search People + synced Classroom Grades for admin (fast; no per-class Classroom API).
 * @param {string} query
 * @param {number} [limit]
 */
async function searchAdminStudents(query, limit = 25) {
  const q = typeof query === "string" ? query.trim().toLowerCase() : "";
  if (!q || q.length < 2) {
    return { students: [] };
  }

  const [peopleMatches, gradeRows, dingByUserId] = await Promise.all([
    searchPeopleProfiles(query, limit),
    listAllClassroomGradeRows(),
    getCachedDingNumberMap(),
  ]);

  const gradeRowsByEmail = new Map();
  for (const row of gradeRows) {
    const email = row.email ? row.email.trim().toLowerCase() : "";
    if (!email) {
      continue;
    }
    if (!gradeRowsByEmail.has(email)) {
      gradeRowsByEmail.set(email, []);
    }
    gradeRowsByEmail.get(email).push(...expandClassGradeRow(row));
  }

  const students = [];
  for (const person of peopleMatches) {
    const email = person.email ? person.email.trim().toLowerCase() : "";
    const dingRaw = person.id ? dingByUserId.get(String(person.id).toLowerCase()) || "" : "";
    const dingNumber = dingRaw ? normalizeAfghanistanPhoneDigits(dingRaw) || dingRaw : "";
    const personGrades = email ? gradeRowsByEmail.get(email) || [] : [];

    if (personGrades.length === 0) {
      students.push({
        name: person.name || "",
        email: person.email,
        userId: person.id,
        dingNumber,
        classSection: "",
        calculatedGrade: "",
        grade: "",
      });
      continue;
    }

    for (const gradeRow of personGrades) {
      students.push({
        name: person.name || gradeRow.name || "",
        email: person.email,
        userId: person.id,
        dingNumber,
        classSection: gradeRow.classSection || "",
        calculatedGrade: gradeRow.calculatedGrade || "",
        grade: gradeRow.calculatedGrade || "",
      });
    }
  }

  return { students };
}

/**
 * Fast list of ACTIVE Classroom courses (labels only — rosters load per class).
 */
async function getAdminClassList() {
  if (!config.classroom?.enabled) {
    throw new Error("Classroom data is not enabled.");
  }

  if (isDatabaseEnabled()) {
    try {
      const fromDb = await getAdminClassListFromDb();
      if (fromDb && fromDb.classes.length > 0) {
        return fromDb;
      }
    } catch (dbErr) {
      console.warn("[admin] class list DB read failed:", dbErr.message);
    }
  }

  const [classes, roleRows, profileMap, gradeRows] = await Promise.all([
    getCachedClassList(),
    getCachedRoleRows(),
    getCachedPeopleProfileMap(),
    getCachedGradeRows(),
  ]);
  const courseLabels = classes.map((entry) => entry.label);
  const teachersByLabel = buildTeachersByCourseLabel(roleRows, profileMap, courseLabels);
  const studentCountByLabel = new Map();
  for (const row of gradeRows) {
    const label = String(row.classSection).trim();
    if (!label) {
      continue;
    }
    studentCountByLabel.set(label, (studentCountByLabel.get(label) || 0) + 1);
  }
  const enriched = classes.map((entry) => ({
    ...entry,
    teacherNames: teachersByLabel.get(entry.label) || [],
    studentCount: studentCountByLabel.get(entry.label) || 0,
  }));
  return { classes: enriched, classCount: enriched.length, liveFromClassroom: true };
}

/**
 * Roster for one class from the synced Classroom Grades sheet (fast; no live Classroom scan).
 * @param {string} courseId
 */
async function getAdminClassRoster(courseId, options = {}) {
  if (!config.classroom?.enabled) {
    throw new Error("Classroom data is not enabled.");
  }

  const id = typeof courseId === "string" ? courseId.trim() : "";
  if (!id) {
    throw new Error("courseId is required.");
  }

  const live = options.live === true;

  if (!live && isDatabaseEnabled()) {
    try {
      const fromDb = await getAdminClassRosterFromDb(id);
      if (fromDb && fromDb.students.length > 0) {
        attachDingNumbers(fromDb.students, await getCachedDingNumberMap());
        adminRosterCache.set(id, { at: Date.now(), data: fromDb });
        return fromDb;
      }
    } catch (dbErr) {
      console.warn("[admin] class roster DB read failed:", dbErr.message);
    }
  }

  const cached = adminRosterCache.get(id);
  if (cached && Date.now() - cached.at < ADMIN_ROSTER_CACHE_TTL_MS) {
    return cached.data;
  }

  const [classes, gradeRows, dingByUserId, profileMap] = await Promise.all([
    getCachedClassList(),
    getCachedGradeRows(),
    getCachedDingNumberMap(),
    getCachedPeopleProfileMap(),
  ]);

  const course = classes.find((entry) => entry.courseId === id);
  if (!course) {
    throw new Error("Course not found.");
  }

  const label = course.label;
  const students = [];
  for (const row of gradeRows) {
    if (String(row.classSection).trim() !== label) {
      continue;
    }
    const email = row.email ? row.email.trim().toLowerCase() : "";
    if (!email) {
      continue;
    }
    const profile = profileMap.get(email);
    const userId = profile?.id || "";
    const dingRaw = userId ? dingByUserId.get(String(userId).toLowerCase()) || "" : "";
    const dingNumber = dingRaw ? normalizeAfghanistanPhoneDigits(dingRaw) || dingRaw : "";
    students.push({
      email: row.email,
      name: row.name || profile?.name || "",
      userId,
      dingNumber,
      grade: row.calculatedGrade || "",
      assignments: [],
    });
  }

  students.sort((a, b) => (a.name || a.email).localeCompare(b.name || b.email));

  if (students.length === 0) {
    try {
      const live = await getClassRosterByCourseId(id, { includeAssignments: false, force: true });
      attachDingNumbers(live.students, dingByUserId);
      if (live.students.length > 0) {
        const data = { courseId: id, label, students: live.students, liveFromClassroom: true };
        adminRosterCache.set(id, { at: Date.now(), data });
        return data;
      }
    } catch (liveErr) {
      console.warn(
        `[admin] live roster fallback unavailable for "${label}": ${liveErr.message}`,
      );
    }
  }

  const data = { courseId: id, label, students, liveFromClassroom: false };
  adminRosterCache.set(id, { at: Date.now(), data });
  return data;
}

/**
 * @deprecated Loads every course at once — too slow for large orgs. Use getAdminClassList + getAdminClassRoster.
 */
async function getAdminAllClassesRoster() {
  if (!config.classroom?.enabled) {
    throw new Error("Classroom data is not enabled.");
  }
  const classes = await listActiveCourses();
  return {
    classes: classes.map((c) => ({ ...c, students: [] })),
    classCount: classes.length,
    studentCount: 0,
    skippedCourses: 0,
    liveFromClassroom: true,
  };
}

async function getAdminViewAsStudent(targetUserId, options = {}) {
  const person = await getPersonByAesopId(targetUserId);
  if (!person?.email) {
    throw new Error("Student not found for that AESOP ID.");
  }
  if (!options.live) {
    const fromDb = await getStudentGradesFromDb(person.email);
    if (fromDb) {
      return {
        targetUserId: person.aesopId || targetUserId,
        email: person.email,
        name: person.name || "",
        source: "database",
        ...fromDb,
      };
    }
  }
  const live = await getStudentGrades(person.email, { force: true });
  return {
    targetUserId: person.aesopId || targetUserId,
    email: person.email,
    name: person.name || "",
    source: "live",
    ...live,
  };
}

async function getAdminViewAsTeacher(targetUserId, options = {}) {
  const person = await getPersonByAesopId(targetUserId);
  if (!person?.email) {
    throw new Error("Teacher not found for that AESOP ID.");
  }
  if (!options.live) {
    const fromDb = await getTeacherRosterFromDb(person.email);
    if (fromDb) {
      return {
        targetUserId: person.aesopId || targetUserId,
        email: person.email,
        name: person.name || "",
        source: "database",
        ...fromDb,
      };
    }
  }
  const live = await getTeacherRoster(person.email, { force: true });
  return {
    targetUserId: person.aesopId || targetUserId,
    email: person.email,
    name: person.name || "",
    source: "live",
    ...live,
  };
}

module.exports = {
  isAdminEmail,
  isPortalAdmin,
  getAdminDashboard,
  getHighGradeStudents,
  buildDingConnectTopUpCsv,
  lookupStudentForAdmin,
  searchAdminStudents,
  getAdminClassList,
  getAdminClassRoster,
  getAdminAllClassesRoster,
  getAdminViewAsStudent,
  getAdminViewAsTeacher,
};
