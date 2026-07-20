const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { filterAdmissionsRows } = require("../services/googleSheets");

describe("filterAdmissionsRows multi-filter AND", () => {
  const rows = [
    {
      id: "1",
      email: "a@example.com",
      fields: { "Round 1": "Accepted", "Review in Round 2": "Yes" },
    },
    {
      id: "2",
      email: "b@example.com",
      fields: { "Round 1": "Accepted", "Review in Round 2": "No" },
    },
    {
      id: "3",
      email: "c@example.com",
      fields: { "Round 1": "Rejected", "Review in Round 2": "No" },
    },
    {
      id: "4",
      email: "d@example.com",
      fields: { "Round 1": "Rejected", "Review in Round 2": "Yes" },
    },
  ];

  it("keeps single-column filters working", () => {
    const filtered = filterAdmissionsRows(rows, {
      column: "Review in Round 2",
      values: ["Yes"],
    });
    assert.deepEqual(
      filtered.map((row) => row.id),
      ["1", "4"],
    );
  });

  it("ANDs Round 1 Accepted with Review in Round 2 Yes", () => {
    const filtered = filterAdmissionsRows(rows, {
      filters: [
        { column: "Round 1", values: ["Accepted"] },
        { column: "Review in Round 2", values: ["Yes"] },
      ],
    });
    assert.deepEqual(
      filtered.map((row) => row.id),
      ["1"],
    );
  });

  it("excludes Round 1 Rejected even if Review in Round 2 is Yes", () => {
    const filtered = filterAdmissionsRows(rows, {
      filters: [
        { column: "Round 1", values: ["Accepted"] },
        { column: "Review in Round 2", values: ["Yes"] },
      ],
    });
    assert.equal(
      filtered.some((row) => row.fields["Round 1"] === "Rejected"),
      false,
    );
  });
});
