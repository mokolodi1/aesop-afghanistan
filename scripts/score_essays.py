#!/usr/bin/env python3
"""
Score essays on the "Essays" Google Sheet tab using ChatGPT.

Reads essays from column B, runs positive/negative indicator prompts, and writes:
  Q - positive raw output
  R - negative raw output
  S - positive total (number)
  T - negative total (number)

Credentials: config/secrets.json (or SECRETS_JSON), same service account as the Node app.
OpenAI: .env OPENAI_API_KEY (repo root), or env var, or secrets.openai.apiKey.

Prompts: scripts/essay-prompts/positive.txt and negative.txt (edit freely; use {essay} where the text goes).
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
from pathlib import Path
from typing import Any

from google.oauth2.service_account import Credentials
from googleapiclient.discovery import build
from openai import OpenAI

REPO_ROOT = Path(__file__).resolve().parent.parent
SCRIPT_DIR = Path(__file__).resolve().parent
PROMPTS_DIR = SCRIPT_DIR / "essay-prompts"
DEFAULT_POSITIVE_PROMPT_FILE = PROMPTS_DIR / "positive.txt"
DEFAULT_NEGATIVE_PROMPT_FILE = PROMPTS_DIR / "negative.txt"
DEFAULT_SHEET_ID = "1n2gYqey0rX-hkANJhT_uuco3fvwPKY_sSms919ta5ag"
DEFAULT_TAB = "Essays"
SHEETS_SCOPE = "https://www.googleapis.com/auth/spreadsheets"

COL_POSITIVE_RAW = "Q"
COL_NEGATIVE_RAW = "R"
COL_POSITIVE_TOTAL = "S"
COL_NEGATIVE_TOTAL = "T"
OUTPUT_COLUMNS = (
    COL_POSITIVE_RAW,
    COL_NEGATIVE_RAW,
    COL_POSITIVE_TOTAL,
    COL_NEGATIVE_TOTAL,
)

ARABIC_RE = re.compile(r"[\u0600-\u06FF]")
TOTAL_NUMBER_PATTERNS = [
    re.compile(
        r"\*\*Total\s+(?:Errors|Clues)\s*:\s*(\d+)\s*\*\*",
        re.IGNORECASE,
    ),
    re.compile(
        r"\*\*Total\s+(?:Errors|Clues)\s*:\s*(\d+)\b",
        re.IGNORECASE,
    ),
    re.compile(
        r"(?:^|\n)\s*\d+\.\s*\*\*Total\s+(?:Errors|Clues)\s*:\s*(\d+)",
        re.IGNORECASE | re.MULTILINE,
    ),
    re.compile(r"Total\s+(?:Errors|Clues)\s*:\s*(\d+)\b", re.IGNORECASE),
    re.compile(
        r"Total\s+(?:number\s+of\s+)?(?:errors|clues)\s*:\s*(\d+)\b",
        re.IGNORECASE,
    ),
    re.compile(r"\*\*Total\s*:\s*(\d+)\s*\*\*", re.IGNORECASE),
    re.compile(r"Total\s*:\s*(\d+)\b", re.IGNORECASE),
]


def load_dotenv(path: Path | None = None) -> None:
    """Load KEY=VALUE pairs from .env into os.environ (existing env wins)."""
    env_path = path or (REPO_ROOT / ".env")
    if not env_path.is_file():
        return
    with env_path.open(encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, value = line.partition("=")
            key = key.strip()
            if not key or key in os.environ:
                continue
            value = value.strip()
            if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
                value = value[1:-1]
            os.environ[key] = value


def load_secrets() -> dict[str, Any]:
    raw = os.environ.get("SECRETS_JSON")
    if raw:
        return json.loads(raw)

    secrets_path = REPO_ROOT / "config" / "secrets.json"
    if secrets_path.is_file():
        with secrets_path.open(encoding="utf-8") as f:
            return json.load(f)

    raise SystemExit(
        "Missing config: set SECRETS_JSON or create config/secrets.json "
        "(see config/secrets.example.json)."
    )


def service_account_info(secrets: dict[str, Any]) -> dict[str, Any]:
    creds = (
        secrets.get("email", {})
        .get("gmailServiceAccount", {})
        .get("credentials")
    )
    if not creds or not creds.get("client_email") or not creds.get("private_key"):
        raise SystemExit(
            "Service account credentials not found at "
            "email.gmailServiceAccount.credentials in secrets."
        )
    return creds


def openai_api_key(secrets: dict[str, Any]) -> str:
    from_env = os.environ.get("OPENAI_API_KEY", "").strip()
    if from_env:
        return from_env
    from_file = (secrets.get("openai") or {}).get("apiKey", "")
    if from_file and str(from_file).strip():
        return str(from_file).strip()
    raise SystemExit(
        "Missing OpenAI API key: set OPENAI_API_KEY in .env, env, or secrets.openai.apiKey."
    )


def sheets_service(secrets: dict[str, Any]):
    creds = Credentials.from_service_account_info(
        service_account_info(secrets),
        scopes=[SHEETS_SCOPE],
    )
    return build("sheets", "v4", credentials=creds, cache_discovery=False)


def strip_code_fences(text: str) -> str:
    text = text.strip()
    if text.startswith("```"):
        text = re.sub(r"^```[^\n]*\n", "", text, count=1)
        text = re.sub(r"\n```\s*$", "", text)
    return text


def extract_total(text: str) -> int | None:
    """Parse the final total from model output (Errors or Clues)."""
    text = strip_code_fences(text)
    last: int | None = None
    for pattern in TOTAL_NUMBER_PATTERNS:
        for match in pattern.finditer(text):
            last = int(match.group(1))
    return last


def has_arabic_skip(essay: str, threshold: int = 10) -> bool:
    return len(ARABIC_RE.findall(essay)) >= threshold


def load_prompt_template(path: Path) -> str:
    if not path.is_file():
        raise SystemExit(f"Prompt file not found: {path}")
    return path.read_text(encoding="utf-8").strip()


def render_prompt(template: str, essay: str) -> str:
    """Insert essay text. Template may use {essay} or PLACE ESSAY HERE."""
    if "{essay}" in template:
        return template.format(essay=essay)
    return template.replace("PLACE ESSAY HERE", essay)


def call_chatgpt(client: OpenAI, prompt: str, model: str) -> str:
    response = client.chat.completions.create(
        model=model,
        messages=[
            {
                "role": "system",
                "content": (
                    "You are a helpful assistant that answers briefly unless asked otherwise."
                ),
            },
            {"role": "user", "content": prompt},
        ],
    )
    if not response.choices:
        raise RuntimeError("OpenAI returned no choices")
    return (response.choices[0].message.content or "").strip()


def read_column_values(
    service,
    sheet_id: str,
    tab: str,
    col: str,
    start_row: int,
    end_row: int,
) -> list[str]:
    range_name = f"'{tab}'!{col}{start_row}:{col}{end_row}"
    result = (
        service.spreadsheets()
        .values()
        .get(spreadsheetId=sheet_id, range=range_name)
        .execute()
    )
    rows = result.get("values", [])
    values: list[str] = []
    for i in range(end_row - start_row + 1):
        if i < len(rows) and rows[i]:
            values.append(str(rows[i][0]))
        else:
            values.append("")
    return values


def read_existing_outputs(
    service,
    sheet_id: str,
    tab: str,
    cols: tuple[str, ...],
    start_row: int,
    end_row: int,
) -> dict[str, list[str]]:
    out: dict[str, list[str]] = {}
    for col in cols:
        out[col] = read_column_values(service, sheet_id, tab, col, start_row, end_row)
    return out


def batch_write_cells(
    service,
    sheet_id: str,
    tab: str,
    updates: list[tuple[int, str, str | int]],
) -> None:
    """updates: list of (row, column_letter, value)"""
    if not updates:
        return
    data = [
        {
            "range": f"'{tab}'!{col}{row}",
            "values": [[value]],
        }
        for row, col, value in updates
    ]
    service.spreadsheets().values().batchUpdate(
        spreadsheetId=sheet_id,
        body={"valueInputOption": "RAW", "data": data},
    ).execute()


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Score Essays tab with ChatGPT.")
    parser.add_argument(
        "--sheet-id",
        default=os.environ.get("ESSAYS_SHEET_ID", DEFAULT_SHEET_ID),
        help=f"Spreadsheet ID (default: {DEFAULT_SHEET_ID})",
    )
    parser.add_argument(
        "--tab",
        default=os.environ.get("ESSAYS_TAB", DEFAULT_TAB),
        help=f"Worksheet name (default: {DEFAULT_TAB})",
    )
    parser.add_argument(
        "--start-row",
        type=int,
        default=int(os.environ.get("ESSAYS_START_ROW", "2")),
        help="First data row (default: 2, assumes row 1 is header)",
    )
    parser.add_argument(
        "--end-row",
        type=int,
        default=None,
        help="Last row to process (default: last non-empty B cell)",
    )
    parser.add_argument(
        "--model",
        default=os.environ.get("OPENAI_MODEL", "gpt-4.1"),
        help="OpenAI chat model (default: gpt-4.1)",
    )
    parser.add_argument(
        "--skip-filled",
        action="store_true",
        help="Skip rows where both S and T already have values",
    )
    parser.add_argument(
        "--row",
        type=int,
        default=None,
        help="Process only this row number",
    )
    parser.add_argument(
        "--delay",
        type=float,
        default=float(os.environ.get("ESSAYS_API_DELAY", "5")),
        help="Seconds to wait between rows (default: 5)",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Print actions without calling OpenAI or writing to Sheets",
    )
    parser.add_argument(
        "--positive-prompt",
        type=Path,
        default=DEFAULT_POSITIVE_PROMPT_FILE,
        help=f"Positive indicators prompt file (default: {DEFAULT_POSITIVE_PROMPT_FILE.relative_to(REPO_ROOT)})",
    )
    parser.add_argument(
        "--negative-prompt",
        type=Path,
        default=DEFAULT_NEGATIVE_PROMPT_FILE,
        help=f"Negative indicators prompt file (default: {DEFAULT_NEGATIVE_PROMPT_FILE.relative_to(REPO_ROOT)})",
    )
    return parser.parse_args()


def find_last_row(service, sheet_id: str, tab: str) -> int:
    result = (
        service.spreadsheets()
        .values()
        .get(spreadsheetId=sheet_id, range=f"'{tab}'!B:B")
        .execute()
    )
    rows = result.get("values", [])
    for idx in range(len(rows) - 1, -1, -1):
        if rows[idx] and str(rows[idx][0]).strip():
            return idx + 1
    return 1


def main() -> None:
    args = parse_args()
    load_dotenv()
    secrets = load_secrets()
    service = sheets_service(secrets)
    client = OpenAI(api_key=openai_api_key(secrets))

    positive_template = load_prompt_template(args.positive_prompt)
    negative_template = load_prompt_template(args.negative_prompt)
    print(f"Prompts: {args.positive_prompt} | {args.negative_prompt}")

    end_row = args.end_row or find_last_row(service, args.sheet_id, args.tab)
    start_row = args.row if args.row else args.start_row
    if args.row:
        end_row = args.row
    if start_row > end_row:
        print("No rows to process.")
        return

    essays = read_column_values(
        service, args.sheet_id, args.tab, "B", start_row, end_row
    )
    existing = read_existing_outputs(
        service, args.sheet_id, args.tab, OUTPUT_COLUMNS, start_row, end_row
    )

    processed = 0
    skipped = 0
    cells_written = 0

    for offset, essay in enumerate(essays):
        row = start_row + offset
        essay = essay.strip()
        if not essay:
            skipped += 1
            continue

        if args.skip_filled:
            p_val = (existing[COL_POSITIVE_TOTAL][offset] or "").strip()
            q_val = (existing[COL_NEGATIVE_TOTAL][offset] or "").strip()
            if p_val and q_val:
                print(f"Row {row}: skip (S and T already filled)")
                skipped += 1
                continue

        row_updates: list[tuple[int, str, str | int]] = []

        if has_arabic_skip(essay):
            print(f"Row {row}: Arabic text detected, writing -1 to S and T")
            row_updates = [
                (row, COL_POSITIVE_TOTAL, -1),
                (row, COL_NEGATIVE_TOTAL, -1),
                (row, COL_POSITIVE_RAW, "Skipped: Arabic text (>=10 chars)"),
                (row, COL_NEGATIVE_RAW, "Skipped: Arabic text (>=10 chars)"),
            ]
        else:
            print(f"Row {row}: scoring ({len(essay)} chars)...")
            if args.dry_run:
                processed += 1
                continue

            positive_raw = call_chatgpt(
                client, render_prompt(positive_template, essay), args.model
            )
            negative_raw = call_chatgpt(
                client, render_prompt(negative_template, essay), args.model
            )

            positive_total = extract_total(positive_raw)
            negative_total = extract_total(negative_raw)

            if positive_total is None:
                print(f"  warning: could not parse positive total from row {row}")
            if negative_total is None:
                print(f"  warning: could not parse negative total from row {row}")

            row_updates = [
                (row, COL_POSITIVE_RAW, positive_raw),
                (row, COL_NEGATIVE_RAW, negative_raw),
                (row, COL_POSITIVE_TOTAL, positive_total if positive_total is not None else ""),
                (row, COL_NEGATIVE_TOTAL, negative_total if negative_total is not None else ""),
            ]

        if not args.dry_run and row_updates:
            batch_write_cells(service, args.sheet_id, args.tab, row_updates)
            cells_written += len(row_updates)

        processed += 1

        if args.delay and offset < len(essays) - 1:
            time.sleep(args.delay)

    if args.dry_run:
        print(f"Dry run complete: would process {processed} row(s), skip {skipped}.")
        return

    print(f"Done: processed {processed} row(s), skipped {skipped}, wrote {cells_written} cell(s).")


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\nInterrupted.", file=sys.stderr)
        sys.exit(130)
