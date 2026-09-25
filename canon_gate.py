"""
quilt-jev-toolkit: canon_gate — score Quilt content for canon promotion.

Usage:
    python3 canon_gate.py /path/to/file.md
    python3 canon_gate.py --batch /path/to/repo/
"""
import argparse
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from jev_client import canon_gate


def gate_file(path):
    text = open(path).read()
    if len(text) < 200:
        return {"path": path, "error": "too short (need 200+ chars)"}
    try:
        result = canon_gate(text)
        result["path"] = path
        result["len"] = len(text)
        return result
    except Exception as e:
        return {"path": path, "error": str(e)}


def gate_batch(directory, extensions=(".md", ".txt")):
    """Walk a directory and gate all matching files."""
    results = []
    for root, dirs, files in os.walk(directory):
        # Skip hidden dirs
        dirs[:] = [d for d in dirs if not d.startswith(".") and d not in ("__pycache__", "node_modules")]
        for f in files:
            if f.endswith(extensions):
                full = os.path.join(root, f)
                print(f"  gating: {full}")
                results.append(gate_file(full))
    return results


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("path", nargs="?", help="file or directory to gate")
    ap.add_argument("--batch", action="store_true", help="walk a directory")
    ap.add_argument("--json", action="store_true", help="output JSON")
    ap.add_argument("--threshold", type=float, default=0.7)
    args = ap.parse_args()

    if not args.path:
        ap.print_help()
        return

    if args.batch:
        results = gate_batch(args.path)
    else:
        results = [gate_file(args.path)]

    if args.json:
        print(json.dumps(results, indent=2))
    else:
        print(f"\n=== RESULTS ({len(results)} files) ===\n")
        for r in results:
            if "error" in r:
                print(f"  ✗ {r['path']}  ERROR: {r['error']}")
                continue
            canon = "✓ CANON" if r["is_canon"] else "  draft"
            print(f"  {canon}  p={r['canon_p']:.2f}  depth={r['depth']:.1f}  domain={r['domain']:10s}  {r['path']}")


if __name__ == "__main__":
    main()
