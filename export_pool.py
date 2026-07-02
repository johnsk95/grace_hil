#!/usr/bin/env python3
"""
Export the M3 annotation pool to a browser-safe pool.json for the web annotator.

Reads   annotation_pool.jsonl   (produced by `run_hitl prepare`, module M3)
Writes  docs/pool.json          (the static payload the GitHub Pages app loads)

Hard rule: the oracle label NEVER reaches the browser (spec 3.5). On a static
site the client downloads the whole file, so we strip `oracle_label` here.
`s_centrality` / `s_novelty` are dropped too (not shown, not needed downstream).
`cc_score` is kept because M5's label record echoes it; `priority_score` is kept
for the optional meta display that mirrors the M4 TUI.

Usage:
    python export_pool.py \
        --pool ../raw/Graph-based-Uncertainty/hitl_experiment/experiments/hitl_quality/annotation_pool.jsonl \
        --out  docs/pool.json
    # add --hide-scores to also strip cc/priority from the display payload
"""

import argparse
import json
from pathlib import Path

# Fields kept in the public payload. `oracle_label` is intentionally absent.
PUBLIC_FIELDS = [
    "claim_id",
    "doc_id",
    "round",
    "claim_text",
    "source_chunk_id",
    "source_chunk_text",
    "is_calibration",
    "cc_score",
    "priority_score",
]


def load_pool(pool_path: Path) -> list[dict]:
    records = []
    with open(pool_path) as f:
        for line in f:
            line = line.strip()
            if line:
                records.append(json.loads(line))
    return records


def to_public(rec: dict, hide_scores: bool) -> dict:
    out = {k: rec[k] for k in PUBLIC_FIELDS if k in rec}
    if "oracle_label" in out:                      # belt and suspenders
        del out["oracle_label"]
    if hide_scores:
        out.pop("cc_score", None)
        out.pop("priority_score", None)
    return out


def main() -> None:
    ap = argparse.ArgumentParser(description="Export M3 pool to browser-safe pool.json")
    ap.add_argument("--pool", required=True, help="Path to annotation_pool.jsonl (M3 output)")
    ap.add_argument("--out", default="docs/pool.json", help="Output path for pool.json")
    ap.add_argument("--hide-scores", action="store_true",
                    help="Also strip cc_score/priority_score from the display payload")
    args = ap.parse_args()

    pool_path = Path(args.pool)
    if not pool_path.exists():
        raise SystemExit(f"ERROR: pool not found: {pool_path}\n"
                         f"Run `python run_hitl_experiment.py prepare` first.")

    records = load_pool(pool_path)
    public = [to_public(r, args.hide_scores) for r in records]

    # Sanity: no oracle labels leaked.
    leaked = [r for r in public if "oracle_label" in r]
    assert not leaked, "oracle_label leaked into public payload"

    calib = sum(1 for r in public if r.get("is_calibration"))
    docs = sorted({r.get("doc_id") for r in public})

    payload = {
        "version": 1,
        "n_claims": len(public),
        "n_calibration": calib,
        "doc_ids": docs,
        "claims": public,
    }

    out_path = Path(args.out)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    with open(out_path, "w") as f:
        json.dump(payload, f, ensure_ascii=False, indent=0)

    print(f"[export_pool] {len(public)} claims ({calib} calibration) across "
          f"{len(docs)} docs -> {out_path}")
    print(f"[export_pool] oracle_label stripped; scores {'hidden' if args.hide_scores else 'kept'}")


if __name__ == "__main__":
    main()
