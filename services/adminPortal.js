const config = require("../config/secrets");
const {
  loadEmailToPeopleProfileMap,
  buildLatestDingNumberByUserIdMap,
  listAllClassroomGradeRows,
  searchPeopleProfiles,
  getClassroomTabStats,
  getRoleByEmail,
  getClassGradeByEmail,
  getPortalDingChangeHistory,
} = require("./googleSheets");
const { getStudentGrades } = require("./classroomSync");
const { normalizeAfghanistanPhoneDigits } = require("../utils/validation");

/**
 * @param {string} email
 * @returns {boolean}
 */
function isAdminEmail(email) {
  const normalized = typeof email === "string" ? email.trim().toLowerCase() : "";
  if (!normalized) {
    return false;
  }
  const allowlist = config.admin?.emails;
  if (!Array.isArray(allowlist) || allowlist.length === 0) {
    return false;
  }
  return allowlist.includes(normalized);
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
  const stats = await getClassroomTabStats();
  const classroomEnabled = !!config.classroom?.enabled;
  return {
    classroomEnabled,
    rolesRows: stats.rolesRows,
    gradesRows: stats.gradesRows,
    rolesTab: stats.rolesTitle,
    gradesTab: stats.gradesTitle,
    gradeThreshold: config.admin?.gradeThreshold ?? 65,
    dingConnectTopUpAmount: config.admin?.dingConnectTopUpAmount ?? "",
    dingConnectTopUpSku: config.admin?.dingConnectTopUpSku ?? "",
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

  const [gradeRows, emailToProfile, dingByUserId] = await Promise.all([
    listAllClassroomGradeRows(),
    loadEmailToPeopleProfileMap(),
    buildLatestDingNumberByUserIdMap(),
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
 * Admin student lookup with role, sheet grade, and live assignment summary.
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
  let grade = { found: false, classSection: "", calculatedGrade: "" };
  let dingHistory = [];
  let liveClasses = [];

  if (email) {
    [role, grade] = await Promise.all([getRoleByEmail(email), getClassGradeByEmail(email)]);
    if (config.classroom?.enabled && !role.isTeacher) {
      try {
        const live = await getStudentGrades(email);
        liveClasses = live.classes || [];
      } catch {
        liveClasses = [];
      }
    }
  }

  if (primary.id) {
    try {
      dingHistory = await getPortalDingChangeHistory(primary.id, { maxRows: 10 });
    } catch {
      dingHistory = [];
    }
  }

  const dingByUserId = await buildLatestDingNumberByUserIdMap();
  const dingRaw = primary.id ? dingByUserId.get(primary.id.toLowerCase()) || "" : "";
  const dingNumber = dingRaw ? normalizeAfghanistanPhoneDigits(dingRaw) || dingRaw : "";

  return {
    matches,
    detail: {
      ...primary,
      dingNumber,
      role: role.role,
      isTeacher: role.isTeacher,
      teacherClasses: role.teacherClasses,
      classSection: grade.classSection,
      calculatedGrade: grade.calculatedGrade,
      dingHistory,
      liveClasses,
    },
  };
}

module.exports = {
  isAdminEmail,
  getAdminDashboard,
  getHighGradeStudents,
  buildDingConnectTopUpCsv,
  lookupStudentForAdmin,
};
