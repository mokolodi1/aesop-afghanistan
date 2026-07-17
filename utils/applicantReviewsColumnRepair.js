/**
 * Repair ApplicantReviews rows written with the legacy column map
 * (A fitness in F–H, B scores in I–M) after Unable/Technical columns were added
 * (current map: A fitness H–J, B scores K–Q with flags in F/G and M/N).
 */

const SCORE_RE = /^(10|[1-9])$/;
const UNABLE_TO_GRADE_RE = /^unable to grade$/i;
const TECHNICAL_FLAG_RE =
  /^(there is a technical problem with this application|technical flag|technical problem)$/i;
const SUSPECTED_AI_RE = /^(suspected ai|flagged for ai|yes|y|true|1)$/i;

/**
 * @param {unknown} value
 * @returns {string}
 */
function cell(value) {
  return String(value ?? "").trim();
}

/**
 * @param {string} value
 * @returns {boolean}
 */
function isScore(value) {
  return SCORE_RE.test(cell(value));
}

/**
 * @param {string} value
 * @returns {boolean}
 */
function isEmpty(value) {
  return cell(value) === "";
}

/**
 * @param {string} value
 * @returns {boolean}
 */
function isUnableOrTechnicalFlagText(value) {
  const trimmed = cell(value);
  return UNABLE_TO_GRADE_RE.test(trimmed) || TECHNICAL_FLAG_RE.test(trimmed);
}

/**
 * @param {string} value
 * @returns {boolean}
 */
function isSuspectedAiText(value) {
  return SUSPECTED_AI_RE.test(cell(value));
}

/**
 * A fitness already sits in H–J with F/G free (or holding real flag text).
 * @param {{ aUnable: string, aTechnical: string, aInstruction: string, aOriginal: string, aCharacter: string }} cells
 */
function isAlreadyCorrectA(cells) {
  if (isUnableOrTechnicalFlagText(cells.aUnable) || isUnableOrTechnicalFlagText(cells.aTechnical)) {
    return true;
  }
  const hasNewFitness =
    isScore(cells.aInstruction) || isScore(cells.aOriginal) || isScore(cells.aCharacter);
  return isEmpty(cells.aUnable) && isEmpty(cells.aTechnical) && hasNewFitness;
}

/**
 * Legacy A fitness still occupies F–H (Unable/Tech/Instruction under new headers).
 * @param {{ aUnable: string, aTechnical: string, aInstruction: string, aOriginal: string, aCharacter: string }} cells
 */
function needsAFitnessShift(cells) {
  if (isAlreadyCorrectA(cells)) {
    return false;
  }
  if (isUnableOrTechnicalFlagText(cells.aUnable) || isUnableOrTechnicalFlagText(cells.aTechnical)) {
    return false;
  }
  if (!isScore(cells.aUnable)) {
    return false;
  }
  return (
    (isScore(cells.aTechnical) || isEmpty(cells.aTechnical)) &&
    (isScore(cells.aInstruction) || isEmpty(cells.aInstruction))
  );
}

/**
 * B scores already sit in K/L + O–Q (or M/N hold real flag text).
 * @param {{ bUnable: string, bTechnical: string, bInstruction: string, bOriginal: string, bCharacter: string }} cells
 */
function isAlreadyCorrectB(cells) {
  if (isUnableOrTechnicalFlagText(cells.bUnable) || isUnableOrTechnicalFlagText(cells.bTechnical)) {
    return true;
  }
  return (
    isScore(cells.bInstruction) || isScore(cells.bOriginal) || isScore(cells.bCharacter)
  );
}

/**
 * Legacy B level/AI/fitness still occupy I–M.
 * @param {{
 *   aOriginal: string,
 *   aCharacter: string,
 *   bLevel: string,
 *   bSuspectedAi: string,
 *   bUnable: string,
 *   bTechnical: string,
 *   bInstruction: string,
 *   bOriginal: string,
 *   bCharacter: string,
 * }} cells
 */
function needsBScoreShift(cells) {
  if (isAlreadyCorrectB(cells)) {
    return false;
  }
  // I holds legacy B level; J holds legacy B Suspected AI (blank or flag text).
  if (!isScore(cells.aOriginal)) {
    return false;
  }
  if (!(isEmpty(cells.aCharacter) || isSuspectedAiText(cells.aCharacter))) {
    return false;
  }
  // Legacy B fitness lived in K/L/M — required so we do not steal a correct A
  // Original Thinking score from column I.
  return (
    isScore(cells.bLevel) || isScore(cells.bSuspectedAi) || isScore(cells.bUnable)
  );
}

/**
 * @param {Record<string, unknown>} row
 * @returns {{ changed: boolean, row: Record<string, string>, shifts: string[] }}
 */
function repairApplicantReviewRow(row) {
  const original = {
    aLevel: cell(row.aLevel),
    aSuspectedAi: cell(row.aSuspectedAi),
    aUnable: cell(row.aUnable),
    aTechnical: cell(row.aTechnical),
    aInstruction: cell(row.aInstruction),
    aOriginal: cell(row.aOriginal),
    aCharacter: cell(row.aCharacter),
    bLevel: cell(row.bLevel),
    bSuspectedAi: cell(row.bSuspectedAi),
    bUnable: cell(row.bUnable),
    bTechnical: cell(row.bTechnical),
    bInstruction: cell(row.bInstruction),
    bOriginal: cell(row.bOriginal),
    bCharacter: cell(row.bCharacter),
  };

  const shiftA = needsAFitnessShift(original);
  const shiftB = needsBScoreShift(original);
  /** @type {string[]} */
  const shifts = [];
  const next = { ...original };

  // Snapshot legacy letter positions before writing.
  const legacyAInstr = original.aUnable; // F
  const legacyAOrig = original.aTechnical; // G
  const legacyAChar = original.aInstruction; // H
  const legacyBLevel = original.aOriginal; // I
  const legacyBAi = original.aCharacter; // J
  const legacyBInstr = original.bLevel; // K
  const legacyBOrig = original.bSuspectedAi; // L
  const legacyBChar = original.bUnable; // M

  if (shiftA) {
    next.aUnable = "";
    next.aTechnical = "";
    next.aInstruction = legacyAInstr;
    next.aOriginal = legacyAOrig;
    next.aCharacter = legacyAChar;
    shifts.push("A-fitness");
  }

  if (shiftB) {
    next.bLevel = legacyBLevel;
    next.bSuspectedAi = legacyBAi;
    next.bUnable = "";
    next.bTechnical = "";
    next.bInstruction = legacyBInstr;
    next.bOriginal = legacyBOrig;
    next.bCharacter = legacyBChar;
    if (!shiftA) {
      // I/J only held B level/AI; clear them. When shiftA also ran, I/J now hold A fitness.
      next.aOriginal = "";
      next.aCharacter = "";
    }
    shifts.push("B-scores");
  }

  return { changed: shifts.length > 0, row: next, shifts };
}

module.exports = {
  cell,
  isScore,
  needsAFitnessShift,
  needsBScoreShift,
  repairApplicantReviewRow,
};
