const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const {
  isPeopleSheetAdminRole,
  resolvePortalRoleFromPeopleSheet,
} = require("../services/googleSheets");
const { isPortalAdmin } = require("../services/adminPortal");

describe("isPeopleSheetAdminRole (default deny)", () => {
  it("grants admin only for explicit affirmative Admins-column markers", () => {
    for (const value of ["Admin", "admins", "YES", "y", "True", "1", " admin "]) {
      assert.equal(isPeopleSheetAdminRole(value), true, `expected admin for ${JSON.stringify(value)}`);
    }
  });

  it("denies blank, negatives, roles, names, and other non-empty junk", () => {
    for (const value of [
      "",
      "   ",
      null,
      undefined,
      "no",
      "false",
      "0",
      "x",
      "X",
      "John",
      "Teacher",
      "Student",
      "Applied",
      "Teacher: I-1",
      "Student: E-1 (24.5%)",
      "reviewer",
      "✓",
      "truee",
    ]) {
      assert.equal(isPeopleSheetAdminRole(value), false, `expected deny for ${JSON.stringify(value)}`);
    }
  });
});

describe("resolvePortalRoleFromPeopleSheet", () => {
  it("returns Admin only when the Admins column is explicitly marked", () => {
    assert.equal(
      resolvePortalRoleFromPeopleSheet(
        { id: "a1", peopleType: "Student: A-1", portalRole: "yes" },
        new Set(),
      ),
      "Admin",
    );
    assert.equal(
      resolvePortalRoleFromPeopleSheet(
        { id: "a1", peopleType: "Student: A-1", portalRole: "Teacher" },
        new Set(),
      ),
      "Student",
    );
    assert.equal(
      resolvePortalRoleFromPeopleSheet(
        { id: "a1", peopleType: "Teacher: I-1", portalRole: "x" },
        new Set(),
      ),
      "Teacher",
    );
    assert.equal(
      resolvePortalRoleFromPeopleSheet(
        { id: "a1", peopleType: "Student: A-1", portalRole: "" },
        new Set(),
      ),
      "Student",
    );
  });
});

describe("isPortalAdmin", () => {
  it("never grants admin from email alone", () => {
    assert.equal(isPortalAdmin("teo@example.com"), false);
    assert.equal(isPortalAdmin({ email: "teo@example.com" }), false);
    assert.equal(isPortalAdmin({ email: "teo@example.com", portalRole: "Teacher" }), false);
    assert.equal(isPortalAdmin({ email: "teo@example.com", portalRole: "Student" }), false);
    assert.equal(isPortalAdmin({ email: "teo@example.com", portalRole: "x" }), false);
  });

  it("grants admin only for mirrored Admin / explicit sheet markers", () => {
    assert.equal(isPortalAdmin({ portalRole: "Admin" }), true);
    assert.equal(isPortalAdmin({ portalRole: "yes" }), true);
    assert.equal(isPortalAdmin({ portalRole: "1" }), true);
  });
});
