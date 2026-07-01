#!/usr/bin/env python3
"""
Score essays on the "Teo's Working" Google Sheet tab using ChatGPT.

Reads essays from column AA (from row 4), runs positive/negative indicator prompts, and writes:
  BB - positive raw output
  BC - negative raw output
  BD - positive total (number)
  BE - negative total (number)

Credentials: config/secrets.json (or SECRETS_JSON), same service account as the Node app.
OpenAI: .env OPENAI_API_KEY (repo root), or env var, or secrets.openai.apiKey.

Prompts: scripts/essay-prompts/positive.txt and negative.txt (edit freely; use {essay} where the text goes).
"""

from __future__ import annotations

import argparse
import json
import os
import random
import re
import sys
import threading
import time
import unicodedata
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, TypeVar

from google.oauth2.service_account import Credentials
from googleapiclient.discovery import build
from googleapiclient.errors import HttpError
from openai import APIConnectionError, APITimeoutError, OpenAI, RateLimitError
from openai import APIStatusError

T = TypeVar("T")

REPO_ROOT = Path(__file__).resolve().parent.parent
SCRIPT_DIR = Path(__file__).resolve().parent
PROMPTS_DIR = SCRIPT_DIR / "essay-prompts"
DEFAULT_POSITIVE_PROMPT_FILE = PROMPTS_DIR / "positive.txt"
DEFAULT_NEGATIVE_PROMPT_FILE = PROMPTS_DIR / "negative.txt"
DEFAULT_SHEET_ID = "11BotrIShhPCrbfiA9rcjoeR-e5twUyoX8-YlHL5AhyM"
DEFAULT_TAB = "Teo's Working"
DEFAULT_ESSAY_COLUMN = "AA"
DEFAULT_START_ROW = 4
COL_SKIP_FLAG = "AZ"
SHEETS_SCOPE = "https://www.googleapis.com/auth/spreadsheets"

COL_POSITIVE_RAW = "BB"
COL_NEGATIVE_RAW = "BC"
COL_POSITIVE_TOTAL = "BD"
COL_NEGATIVE_TOTAL = "BE"
OUTPUT_COLUMNS = (
    COL_POSITIVE_RAW,
    COL_NEGATIVE_RAW,
    COL_POSITIVE_TOTAL,
    COL_NEGATIVE_TOTAL,
)
DEFAULT_CONCURRENCY = 10
MAX_API_RETRIES = 8
RETRYABLE_HTTP_STATUS = {429, 500, 502, 503, 504}
RETRY_BASE_SECONDS = 1.0
RETRY_MAX_SECONDS = 120.0
RETRY_MULTIPLIER = 2.0
NON_LATIN_RATIO_THRESHOLD = 0.20
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


def is_latin_letter(char: str) -> bool:
    if not char.isalpha():
        return False
    return "LATIN" in unicodedata.name(char, "")


def non_latin_letter_ratio(text: str) -> float:
    letters = [c for c in text if c.isalpha()]
    if not letters:
        return 0.0
    non_latin = sum(1 for c in letters if not is_latin_letter(c))
    return non_latin / len(letters)


def should_skip_non_latin(
    text: str, threshold: float = NON_LATIN_RATIO_THRESHOLD
) -> bool:
    return non_latin_letter_ratio(text) > threshold


def strip_non_english(text: str) -> str:
    """Remove non-Latin letters; keep Latin text, digits, and punctuation."""
    kept: list[str] = []
    for char in text:
        if char.isalpha() and not is_latin_letter(char):
            continue
        kept.append(char)
    cleaned = "".join(kept)
    cleaned = re.sub(r"[ \t]+", " ", cleaned)
    cleaned = re.sub(r"\n{3,}", "\n\n", cleaned)
    return cleaned.strip()


def has_english_text(text: str) -> bool:
    return any(is_latin_letter(c) for c in text)

def skip_row_result(row: int, reason: str) -> RowResult:
    return RowResult(
        row=row,
        updates=[
            (row, COL_POSITIVE_TOTAL, -1),
            (row, COL_NEGATIVE_TOTAL, -1),
            (row, COL_POSITIVE_RAW, reason),
            (row, COL_NEGATIVE_RAW, reason),
        ],
    )

def load_prompt_template(path: Path) -> str:
    if not path.is_file():
        raise SystemExit(f"Prompt file not found: {path}")
    return path.read_text(encoding="utf-8").strip()


def render_prompt(template: str, essay: str) -> str:
    """Insert essay text. Template may use {essay} or PLACE ESSAY HERE."""
    if "{essay}" in template:
        return template.format(essay=essay)
    return template.replace("PLACE ESSAY HERE", essay)


def exponential_backoff_seconds(attempt: int) -> float:
    """Seconds to wait before retry attempt (0-indexed): base * multiplier^attempt."""
    return min(RETRY_BASE_SECONDS * (RETRY_MULTIPLIER**attempt), RETRY_MAX_SECONDS)


def parse_retry_after_header(exc: BaseException) -> float | None:
    response = getattr(exc, "response", None)
    headers = getattr(response, "headers", None) if response is not None else None
    if not headers:
        return None
    retry_after = headers.get("retry-after") or headers.get("Retry-After")
    if not retry_after:
        return None
    try:
        return min(float(retry_after), RETRY_MAX_SECONDS)
    except ValueError:
        return None


def retry_wait_seconds(exc: BaseException, attempt: int) -> float:
    """Exponential backoff, bumped up by Retry-After when the server asks for longer."""
    wait = exponential_backoff_seconds(attempt)
    header_wait = parse_retry_after_header(exc)
    if header_wait is not None:
        wait = max(wait, header_wait)
    # Jitter spreads out retries when many workers hit 429 at once.
    wait += random.uniform(0, min(wait * 0.25, 5.0))
    return min(wait, RETRY_MAX_SECONDS)


def call_with_retries(
    label: str,
    fn: Callable[[], T],
    *,
    max_retries: int = MAX_API_RETRIES,
) -> T:
    for attempt in range(max_retries):
        try:
            return fn()
        except RateLimitError as exc:
            if attempt + 1 >= max_retries:
                raise
            wait = retry_wait_seconds(exc, attempt)
            print(
                f"  {label}: rate limited (429), exponential backoff {wait:.1f}s "
                f"(attempt {attempt + 1}/{max_retries})"
            )
            time.sleep(wait)
        except APIStatusError as exc:
            if exc.status_code not in RETRYABLE_HTTP_STATUS or attempt + 1 >= max_retries:
                raise
            wait = retry_wait_seconds(exc, attempt)
            print(
                f"  {label}: HTTP {exc.status_code}, exponential backoff {wait:.1f}s "
                f"(attempt {attempt + 1}/{max_retries})"
            )
            time.sleep(wait)
        except (APITimeoutError, APIConnectionError) as exc:
            if attempt + 1 >= max_retries:
                raise
            wait = retry_wait_seconds(exc, attempt)
            print(
                f"  {label}: {type(exc).__name__}, exponential backoff {wait:.1f}s "
                f"(attempt {attempt + 1}/{max_retries})"
            )
            time.sleep(wait)
        except HttpError as exc:
            status = getattr(getattr(exc, "resp", None), "status", None)
            if status not in RETRYABLE_HTTP_STATUS or attempt + 1 >= max_retries:
                raise
            wait = retry_wait_seconds(exc, attempt)
            print(
                f"  {label}: Sheets HTTP {status}, exponential backoff {wait:.1f}s "
                f"(attempt {attempt + 1}/{max_retries})"
            )
            time.sleep(wait)
    raise RuntimeError(f"{label}: exceeded retry limit")


def call_chatgpt(client: OpenAI, prompt: str, model: str) -> str:
    def _request() -> str:
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

    return call_with_retries("OpenAI", _request)


@dataclass
class RowJob:
    row: int
    essay: str


@dataclass
class RowResult:
    row: int
    updates: list[tuple[int, str, str | int]] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)
    dry_run: bool = False


def score_row(
    job: RowJob,
    *,
    client: OpenAI,
    positive_template: str,
    negative_template: str,
    model: str,
    dry_run: bool,
) -> RowResult:
    row = job.row
    essay = job.essay.strip()
    non_latin_ratio = non_latin_letter_ratio(essay)
    if should_skip_non_latin(essay):
        print(
            f"Row {row}: {non_latin_ratio:.0%} non-Latin letters (>20%), "
            "writing -1 to BD and BE"
        )
        return skip_row_result(row, "Skipped: >20% non-Latin text")

    essay_for_gpt = strip_non_english(essay)
    if not has_english_text(essay_for_gpt):
        print(f"Row {row}: no English text left after stripping, writing -1 to BD and BE")
        return skip_row_result(row, "Skipped: no English text after stripping")

    if len(essay_for_gpt) < len(essay):
        print(
            f"Row {row}: stripped non-English text "
            f"({len(essay)} -> {len(essay_for_gpt)} chars)"
        )

    print(f"Row {row}: scoring ({len(essay_for_gpt)} chars)...")
    if dry_run:
        return RowResult(row=row, dry_run=True)

    positive_raw = call_chatgpt(
        client, render_prompt(positive_template, essay_for_gpt), model
    )
    negative_raw = call_chatgpt(
        client, render_prompt(negative_template, essay_for_gpt), model
    )

    positive_total = extract_total(positive_raw)
    negative_total = extract_total(negative_raw)
    warnings: list[str] = []
    if positive_total is None:
        warnings.append(f"could not parse positive total from row {row}")
    if negative_total is None:
        warnings.append(f"could not parse negative total from row {row}")
    for warning in warnings:
        print(f"  warning: {warning}")

    return RowResult(
        row=row,
        updates=[
            (row, COL_POSITIVE_RAW, positive_raw),
            (row, COL_NEGATIVE_RAW, negative_raw),
            (row, COL_POSITIVE_TOTAL, positive_total if positive_total is not None else ""),
            (row, COL_NEGATIVE_TOTAL, negative_total if negative_total is not None else ""),
        ],
        warnings=warnings,
    )


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


def write_row_updates(
    service,
    sheet_id: str,
    tab: str,
    updates: list[tuple[int, str, str | int]],
) -> None:
    if not updates:
        return
    call_with_retries(
        "Google Sheets write",
        lambda: batch_write_cells(service, sheet_id, tab, updates),
    )


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Score essays on Google Sheets with ChatGPT.")
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
        default=int(os.environ.get("ESSAYS_START_ROW", str(DEFAULT_START_ROW))),
        help=f"First data row (default: {DEFAULT_START_ROW})",
    )
    parser.add_argument(
        "--end-row",
        type=int,
        default=None,
        help=f"Last row to process (default: last non-empty {DEFAULT_ESSAY_COLUMN} cell)",
    )
    parser.add_argument(
        "--model",
        default=os.environ.get("OPENAI_MODEL", "gpt-4.1"),
        help="OpenAI chat model (default: gpt-4.1)",
    )
    parser.add_argument(
        "--skip-filled",
        action="store_true",
        help="Skip rows where both BD and BE already have values",
    )
    parser.add_argument(
        "--row",
        type=int,
        default=None,
        help="Process only this row number",
    )
    parser.add_argument(
        "--concurrency",
        type=int,
        default=int(os.environ.get("ESSAYS_CONCURRENCY", str(DEFAULT_CONCURRENCY))),
        help=f"Rows to score in parallel (default: {DEFAULT_CONCURRENCY})",
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


def find_last_row(service, sheet_id: str, tab: str, essay_col: str) -> int:
    result = (
        service.spreadsheets()
        .values()
        .get(spreadsheetId=sheet_id, range=f"'{tab}'!{essay_col}:{essay_col}")
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

    end_row = args.end_row or find_last_row(
        service, args.sheet_id, args.tab, DEFAULT_ESSAY_COLUMN
    )
    start_row = args.row if args.row else args.start_row
    if args.row:
        end_row = args.row
    if start_row > end_row:
        print("No rows to process.")
        return

    essays = read_column_values(
        service, args.sheet_id, args.tab, DEFAULT_ESSAY_COLUMN, start_row, end_row
    )
    skip_flags = read_column_values(
        service, args.sheet_id, args.tab, COL_SKIP_FLAG, start_row, end_row
    )
    existing = read_existing_outputs(
        service, args.sheet_id, args.tab, OUTPUT_COLUMNS, start_row, end_row
    )

    jobs: list[RowJob] = []
    skipped = 0

    for offset, essay in enumerate(essays):
        row = start_row + offset
        essay = essay.strip()
        if not essay:
            skipped += 1
            continue

        if (skip_flags[offset] or "").strip().upper() == "Y":
            print(f"Row {row}: skip (AZ is Y)")
            skipped += 1
            continue

        if args.skip_filled:
            p_val = (existing[COL_POSITIVE_TOTAL][offset] or "").strip()
            q_val = (existing[COL_NEGATIVE_TOTAL][offset] or "").strip()
            if p_val and q_val:
                print(f"Row {row}: skip (BD and BE already filled)")
                skipped += 1
                continue

        jobs.append(RowJob(row=row, essay=essay))

    if not jobs:
        print(f"No rows to process (skipped {skipped}).")
        return

    concurrency = max(1, args.concurrency)
    print(f"Processing {len(jobs)} row(s) with concurrency={concurrency}")

    processed = 0
    cells_written = 0
    write_lock = threading.Lock()

    def run_job(job: RowJob) -> RowResult:
        return score_row(
            job,
            client=client,
            positive_template=positive_template,
            negative_template=negative_template,
            model=args.model,
            dry_run=args.dry_run,
        )

    with ThreadPoolExecutor(max_workers=concurrency) as pool:
        futures = [pool.submit(run_job, job) for job in jobs]
        for future in as_completed(futures):
            result = future.result()
            processed += 1
            if args.dry_run or not result.updates:
                continue
            with write_lock:
                write_row_updates(service, args.sheet_id, args.tab, result.updates)
                cells_written += len(result.updates)

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
