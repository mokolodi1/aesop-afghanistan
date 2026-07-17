const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const {
  needsAFitnessShift,
  needsBScoreShift,
  repairApplicantReviewRow,
} = require("../utils/applicantReviewsColumnRepair");

describe("applicantReviewsColumnRepair", () => {
  it("shifts legacy A fitness out of Unable/Technical/Instruction", () => {
    const result = repairApplicantReviewRow({
      aLevel: "1",
      aSuspectedAi: "",
      aUnable: "5",
      aTechnical: "8",
      aInstruction: "7",
      aOriginal: "",
      aCharacter: "",
      bLevel: "",
      bSuspectedAi: "",
      bUnable: "",
      bTechnical: "",
      bInstruction: "",
      bOriginal: "",
      bCharacter: "",
    });
    assert.equal(result.changed, true);
    assert.deepEqual(result.shifts, ["A-fitness"]);
    assert.equal(result.row.aUnable, "");
    assert.equal(result.row.aTechnical, "");
    assert.equal(result.row.aInstruction, "5");
    assert.equal(result.row.aOriginal, "8");
    assert.equal(result.row.aCharacter, "7");
    assert.equal(result.row.aLevel, "1");
  });

  it("shifts legacy B scores out of I–M into K/L + O–Q", () => {
    const result = repairApplicantReviewRow({
      aLevel: "",
      aSuspectedAi: "",
      aUnable: "",
      aTechnical: "",
      aInstruction: "",
      aOriginal: "2", // legacy B level in I
      aCharacter: "",
      bLevel: "7", // legacy B instruction in K
      bSuspectedAi: "4",
      bUnable: "4",
      bTechnical: "",
      bInstruction: "",
      bOriginal: "",
      bCharacter: "",
    });
    assert.equal(result.changed, true);
    assert.deepEqual(result.shifts, ["B-scores"]);
    assert.equal(result.row.aOriginal, "");
    assert.equal(result.row.aCharacter, "");
    assert.equal(result.row.bLevel, "2");
    assert.equal(result.row.bSuspectedAi, "");
    assert.equal(result.row.bUnable, "");
    assert.equal(result.row.bInstruction, "7");
    assert.equal(result.row.bOriginal, "4");
    assert.equal(result.row.bCharacter, "4");
  });

  it("repairs combined A + B legacy rows without clobbering A fitness", () => {
    const result = repairApplicantReviewRow({
      aLevel: "2",
      aSuspectedAi: "",
      aUnable: "6",
      aTechnical: "5",
      aInstruction: "3",
      aOriginal: "1", // legacy B level
      aCharacter: "Suspected AI",
      bLevel: "2",
      bSuspectedAi: "3",
      bUnable: "2",
      bTechnical: "",
      bInstruction: "",
      bOriginal: "",
      bCharacter: "",
    });
    assert.equal(result.changed, true);
    assert.ok(result.shifts.includes("A-fitness"));
    assert.ok(result.shifts.includes("B-scores"));
    assert.equal(result.row.aInstruction, "6");
    assert.equal(result.row.aOriginal, "5");
    assert.equal(result.row.aCharacter, "3");
    assert.equal(result.row.bLevel, "1");
    assert.equal(result.row.bSuspectedAi, "Suspected AI");
    assert.equal(result.row.bInstruction, "2");
    assert.equal(result.row.bOriginal, "3");
    assert.equal(result.row.bCharacter, "2");
  });

  it("leaves already-correct rows alone", () => {
    const result = repairApplicantReviewRow({
      aLevel: "3",
      aSuspectedAi: "",
      aUnable: "",
      aTechnical: "",
      aInstruction: "5",
      aOriginal: "4",
      aCharacter: "5",
      bLevel: "1",
      bSuspectedAi: "",
      bUnable: "",
      bTechnical: "",
      bInstruction: "8",
      bOriginal: "5",
      bCharacter: "5",
    });
    assert.equal(result.changed, false);
    assert.equal(needsAFitnessShift(result.row), false);
    assert.equal(needsBScoreShift(result.row), false);
  });

  it("does not treat real Unable to Grade text as a misplaced score", () => {
    const result = repairApplicantReviewRow({
      aLevel: "",
      aSuspectedAi: "",
      aUnable: "Unable to Grade",
      aTechnical: "",
      aInstruction: "",
      aOriginal: "",
      aCharacter: "",
      bLevel: "",
      bSuspectedAi: "",
      bUnable: "",
      bTechnical: "",
      bInstruction: "",
      bOriginal: "",
      bCharacter: "",
    });
    assert.equal(result.changed, false);
  });

  it("keeps Suspected AI in place when no fitness scores need shifting", () => {
    const result = repairApplicantReviewRow({
      aLevel: "",
      aSuspectedAi: "Suspected AI",
      aUnable: "",
      aTechnical: "",
      aInstruction: "",
      aOriginal: "",
      aCharacter: "",
      bLevel: "",
      bSuspectedAi: "",
      bUnable: "",
      bTechnical: "",
      bInstruction: "",
      bOriginal: "",
      bCharacter: "",
    });
    assert.equal(result.changed, false);
    assert.equal(result.row.aSuspectedAi, "Suspected AI");
  });
});
