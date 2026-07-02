#!/usr/bin/env python3
"""
Convert the collected labels (Google Sheet, exported to CSV) into the
labels.jsonl that M5 (`run_hitl replay`) reads.

The web app is fire-and-forget, so client retries can duplicate a row. Each
validator labels a given claim exactly once, so (validator_id, claim_id) is the
natural key: we dedupe on it, keeping the LAST write (latest received_at).

Emitted schema matches M4's append_label exactly:
    claim_id, doc_id, validator_id, decision, elapsed_s, is_calibration, cc_score

Usage:
    # In the Sheet: File -> Download -> CSV, save as labels_sheet.csv
    python sheet_to_labels.py --csv labels_sheet.csv \
        --out ../raw/Graph-based-Uncertainty/hitl_experiment/experiments/hitl_quality/labels.jsonl

    # Or merge one-or-more manually-downloaded labels_*.jsonl files instead:
    python sheet_to_labels.py --jsonl labels_V-*.jsonl --out .../labels.jsonl
"""

import argparse
import csv
import glob
import json
from pathlib import Path

OUT_FIELDS = ["claim_id", "doc_id", "validator_id", "decision",
              "elapsed_s", "is_calibration", "cc_score"]


def _coerce(rec: dict) -> dict:
    def as_bool(v):
        return str(v).strip().lower() in ("true", "1", "yes")
    def as_float(v, d=0.0):
        try:
            return float(v)
        except (TypeError, ValueError):
            return d
    return {
        "claim_id": str(rec.get("claim_id", "")),
        "doc_id": str(rec.get("doc_id", "")),
        "validator_id": str(rec.get("validator_id", "")),
        "decision": str(rec.get("decision", "unsure")),
        "elapsed_s": as_float(rec.get("elapsed_s"), 0.0),
        "is_calibration": as_bool(rec.get("is_calibration")),
        "cc_score": as_float(rec.get("cc_score"), 0.0),
        "_received_at": rec.get("received_at", ""),   # for last-write-wins ordering
    }


def read_csv(path: Path) -> list[dict]:
    with open(path, newline="") as f:
        return [_coerce(row) for row in csv.DictReader(f)]


def read_jsonl(paths: list[str]) -> list[dict]:
    out = []
    for pat in paths:
        for fp in glob.glob(pat):
            with open(fp) as f:
                for line in f:
                    line = line.strip()
                    if line:
                        out.append(_coerce(json.loads(line)))
    return out


def dedupe(records: list[dict]) -> list[dict]:
    """Keep the last record per (validator_id, claim_id), ordered by received_at."""
    # Stable order: CSV rows arrive in received order; jsonl has received_at too.
    keyed: dict[tuple, dict] = {}
    for r in sorted(records, key=lambda x: str(x.get("_received_at", ""))):
        keyed[(r["validator_id"], r["claim_id"])] = r
    return list(keyed.values())


def main() -> None:
    ap = argparse.ArgumentParser(description="Build labels.jsonl for M5 from collected labels")
    ap.add_argument("--csv", help="Sheet exported as CSV")
    ap.add_argument("--jsonl", nargs="+", help="One or more labels_*.jsonl files/globs to merge")
    ap.add_argument("--out", required=True, help="Output labels.jsonl path")
    args = ap.parse_args()

    if not args.csv and not args.jsonl:
        raise SystemExit("Provide --csv and/or --jsonl")

    records: list[dict] = []
    if args.csv:
        records += read_csv(Path(args.csv))
    if args.jsonl:
        records += read_jsonl(args.jsonl)

    deduped = dedupe(records)

    out_path = Path(args.out)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    with open(out_path, "w") as f:
        for r in deduped:
            row = {k: r[k] for k in OUT_FIELDS}
            f.write(json.dumps(row) + "\n")

    validators = sorted({r["validator_id"] for r in deduped})
    print(f"[sheet_to_labels] {len(records)} raw -> {len(deduped)} deduped labels "
          f"from {len(validators)} validators -> {out_path}")
    print(f"[sheet_to_labels] validators: {', '.join(validators)}")


if __name__ == "__main__":
    main()
