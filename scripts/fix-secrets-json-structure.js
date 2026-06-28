#!/usr/bin/env node
/**
 * Fix secrets.json when a top-level "postmark" block was pasted inside "email".
 * Usage: node scripts/fix-secrets-json-structure.js
 */
const fs = require("fs");
const path = require("path");

const secretsPath = path.join(__dirname, "..", "config", "secrets.json");
const text = fs.readFileSync(secretsPath, "utf8");

const credBlock =
  /,\s*"postmark"\s*:\s*\{\s*"serverToken"\s*:\s*"([^"]*)"\s*,\s*"webhookSecret"\s*:\s*"([^"]*)"\s*\}\s*,(?=\s*"gmailServiceAccount")/;

const match = text.match(credBlock);
if (!match) {
  console.error("No misplaced postmark credentials block found.");
  process.exit(1);
}

const [, serverToken, webhookSecret] = match;
let fixedText = text.replace(credBlock, ",");
fixedText = fixedText.replace(
  /"postmark"\s*:\s*\{\s*"messageStream"\s*:\s*"outbound"\s*\}/,
  '"postmark": {\n      "messageStream": "outbound"\n    }',
);

if (!/\n  "postmark"\s*:\s*\{\n    "serverToken"/.test(fixedText)) {
  fixedText = fixedText.replace(
    /\n  \},\n  "admin"\s*:\s*\{/,
    `\n  },\n  "postmark": {\n    "serverToken": ${JSON.stringify(serverToken)},\n    "webhookSecret": ${JSON.stringify(webhookSecret)}\n  },\n  "admin": {`,
  );
}

const data = JSON.parse(fixedText);
if (!data.email.postmark) {
  data.email.postmark = { messageStream: "outbound" };
}
if (!data.postmark?.serverToken) {
  data.postmark = { serverToken, webhookSecret };
}

const order = ["googleSheets", "classroom", "email", "postmark", "admin"];
const ordered = {};
for (const key of order) {
  if (data[key] !== undefined) {
    ordered[key] = data[key];
  }
}

fs.writeFileSync(secretsPath, `${JSON.stringify(ordered, null, 2)}\n`);
console.log("Fixed config/secrets.json structure.");
