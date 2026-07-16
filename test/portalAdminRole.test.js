const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { isPeopleSheetAdminRole } = require("../services/googleSheets");
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

describe("isPortalAdmin", () => {
  it("reads only adminRole from the People Admins column", () => {
    assert.equal(isPortalAdmin("teo@example.com"), false);
    assert.equal(isPortalAdmin({ email: "teo@example.com" }), false);
    assert.equal(isPortalAdmin({ email: "teo@example.com", adminRole: "Teacher" }), false);
    assert.equal(isPortalAdmin({ email: "teo@example.com", adminRole: "Student" }), false);
    assert.equal(isPortalAdmin({ email: "teo@example.com", adminRole: "x" }), false);
    assert.equal(isPortalAdmin({ adminRole: "Admin" }), true);
    assert.equal(isPortalAdmin({ adminRole: "yes" }), true);
    assert.equal(isPortalAdmin({ adminRole: "1" }), true);
  });
});
