#!/usr/bin/env python3
"""Check parenthesis balance in WAT files.

Usage:
  python3 tools/check-parens.py                    # basic balance check
  python3 tools/check-parens.py --range 4100-4220  # show depth for line range
  python3 tools/check-parens.py --funcs            # show function boundaries
  python3 tools/check-parens.py --depth 1          # show lines at specific depth
"""
import sys

file = "src/main.wat"
show_range = None
show_funcs = False
show_depth = None

args = sys.argv[1:]
while args:
    a = args.pop(0)
    if a == "--range" and args:
        lo, hi = args.pop(0).split("-")
        show_range = (int(lo), int(hi))
    elif a == "--funcs":
        show_funcs = True
    elif a == "--depth" and args:
        show_depth = int(args.pop(0))
    elif not a.startswith("-"):
        file = a

lines = open(file).read().split("\n")
depth = 0
for i, line in enumerate(lines, 1):
    stripped = line.split(";;")[0]
    old = depth
    for c in stripped:
        if c == "(": depth += 1
        elif c == ")": depth -= 1

    if show_range and show_range[0] <= i <= show_range[1]:
        print(f"{i:4d} [{old:2d}->{depth:2d}] {line.rstrip()[:100]}")
    if show_funcs and "(func " in stripped:
        print(f"{i:4d} depth={depth:2d}  {line.rstrip()[:100]}")
    if show_funcs and old >= 2 and depth == 1:
        print(f"{i:4d} CLOSE depth={old}->{depth}  {line.rstrip()[:80]}")
    if show_depth is not None and depth == show_depth and old != depth:
        print(f"{i:4d} [{old:2d}->{depth:2d}] {line.rstrip()[:100]}")

    if depth < 0:
        print(f"ERROR: unbalanced ) at line {i}, depth {old}->{depth}")
        print(f"  {line.rstrip()}")
        sys.exit(1)
    if not (show_range or show_funcs or show_depth is not None):
        if abs(depth - old) > 6:
            print(f"WARN: large depth change at line {i}: {old}->{depth}")

if depth != 0:
    print(f"ERROR: final depth {depth} (expected 0)")
    sys.exit(1)
if not (show_range or show_funcs or show_depth is not None):
    print(f"OK: {len(lines)} lines, balanced")
