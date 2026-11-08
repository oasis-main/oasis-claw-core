#!/usr/bin/env python3
"""Build the public source tree from one git ref of the private repo.

The private repo keeps the names of its own deployment. The public repo gets a
copy of the tracked tree in which a private map replaces those names, in file
contents and in paths. The tool then scans the result and fails on any hit, so
a new private name stops the release and cannot reach the public repo.

The map is private, so this file holds no names. The map file is
${OASIS_RELEASE_MAP:-~/.config/oasis-x/release-map.txt}, with one rule on each
line (lines that start with # are notes):

    <term>==><replacement>       replace a term; keep the case of the source
    exclude:<path>               leave out a file or a folder

The tool also applies the rules of the name check (scripts/git-hooks/
censor_check.py) and fails on a path under /Users, an AWS access key ID, or a
term of either file.

Usage:
    build_public_tree.py --ref origin/dev --out <empty folder or public clone>
    build_public_tree.py --scan <folder>

In a public clone the tool replaces every file and keeps .git.

This file uses only the standard library.
"""
from __future__ import annotations

import argparse
import importlib.util
import os
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile
from pathlib import Path
from typing import List, Tuple

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("censor_check", HERE.parent / "git-hooks" / "censor_check.py")
censor = importlib.util.module_from_spec(spec)
sys.modules["censor_check"] = censor
spec.loader.exec_module(censor)

GENERIC_DENY = [
    ("path under /Users", re.compile(r"/Users/(?!operator\b|example\b|test\b|[a-z]\b)[A-Za-z]")),
    ("AWS access key ID", re.compile(r"\bAKIA(?![0-9A-Z]*EXAMPLE\b)[0-9A-Z]{16}\b")),
]
SKIP = {".git", "node_modules"}

MapRule = Tuple[str, str, "re.Pattern[str]"]


def map_file() -> Path:
    env = os.environ.get("OASIS_RELEASE_MAP")
    return Path(env).expanduser() if env else Path.home() / ".config/oasis-x/release-map.txt"


def compile_map_term(term: str) -> "re.Pattern[str]":
    escaped = re.escape(term)
    word = rf"(?<![A-Za-z0-9])(?i:{escaped})(?![A-Za-z0-9])"
    if not term.isalpha():
        return re.compile(word)
    capitalized = re.escape(term[0].upper() + term[1:].lower())
    lowered = re.escape(term.lower())
    return re.compile(rf"{word}|(?<=[a-z]){capitalized}(?![a-z0-9])|(?<![A-Za-z0-9]){lowered}(?=[A-Z])")


def load_map(path: Path) -> Tuple[List[MapRule], List[str]]:
    rules: List[MapRule] = []
    excluded: List[str] = []
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("exclude:"):
            excluded.append(line[len("exclude:"):].strip().rstrip("/"))
        elif "==>" in line:
            term, replacement = line.split("==>", 1)
            rules.append((term, replacement, compile_map_term(term)))
    rules.sort(key=lambda r: -len(r[0]))
    return rules, excluded


def like_source(source: str, target: str) -> str:
    if source.isupper() and len(source) > 1:
        return target.upper()
    if source[0].isupper():
        return " ".join(part[0].upper() + part[1:] if part else part for part in target.split(" "))
    return target


def apply_map(text: str, rules: List[MapRule]) -> str:
    for _, replacement, pattern in rules:
        text = pattern.sub(lambda m, r=replacement: like_source(m.group(0), r), text)
    return text


def export_ref(ref: str, target: str) -> None:
    with tempfile.TemporaryFile() as archive:
        subprocess.run(["git", "archive", "--format=tar", ref], stdout=archive, check=True)
        archive.seek(0)
        with tarfile.open(fileobj=archive) as tar:
            tar.extractall(target, filter="tar")


def walk_files(root: str):
    for folder, dirs, files in os.walk(root):
        dirs[:] = [d for d in dirs if d not in SKIP]
        for name in files:
            if name not in SKIP:
                yield os.path.join(folder, name)


def transform(root: str, rules: List[MapRule], names: list, excluded: List[str]) -> None:
    for item in excluded:
        path = os.path.join(root, item)
        if os.path.isdir(path):
            shutil.rmtree(path)
        elif os.path.exists(path):
            os.remove(path)
    for path in walk_files(root):
        try:
            text = Path(path).read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError):
            continue
        fixed = apply_map(censor.fix_text(text, names), rules)
        if fixed != text:
            mode = os.stat(path).st_mode
            Path(path).write_text(fixed, encoding="utf-8")
            os.chmod(path, mode)
    # The deepest paths go first, so that a rename does not move a later path.
    for folder, dirs, files in os.walk(root, topdown=False):
        for name in files + dirs:
            renamed = apply_map(name, rules)
            if renamed != name:
                os.rename(os.path.join(folder, name), os.path.join(folder, renamed))


def scan(root: str, rules: List[MapRule], names: list) -> int:
    hits = 0

    def report(where: str, what: str) -> None:
        nonlocal hits
        hits += 1
        print(f"{where}: {what}")

    terms = [(term, pattern) for term, _, pattern in rules] + [(term, pattern) for term, _, pattern in names]
    for path in walk_files(root):
        relative = os.path.relpath(path, root)
        for term, pattern in terms:
            if pattern.search(relative):
                report(f"{relative}:0", term)
        try:
            text = Path(path).read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError):
            continue
        for number, line in enumerate(text.splitlines(), 1):
            for term, pattern in terms:
                if pattern.search(line):
                    report(f"{relative}:{number}", term)
            for label, pattern in GENERIC_DENY:
                if pattern.search(line):
                    report(f"{relative}:{number}", label)
    print(f"{hits} hit(s)")
    return 1 if hits else 0


def replace_tree(source: str, out: str) -> None:
    os.makedirs(out, exist_ok=True)
    for name in os.listdir(out):
        if name == ".git":
            continue
        path = os.path.join(out, name)
        if os.path.isdir(path) and not os.path.islink(path):
            shutil.rmtree(path)
        else:
            os.remove(path)
    for name in os.listdir(source):
        shutil.move(os.path.join(source, name), os.path.join(out, name))


def main() -> int:
    parser = argparse.ArgumentParser(description="Build the public tree from a private ref.")
    parser.add_argument("--ref")
    parser.add_argument("--out")
    parser.add_argument("--scan")
    args = parser.parse_args()
    for path in (map_file(), censor.term_file()):
        if not path.is_file():
            print(f"Stopped: the private file {path} is missing.", file=sys.stderr)
            return 2
    rules, excluded = load_map(map_file())
    names = censor.load_rules(censor.term_file())
    if args.scan:
        return scan(args.scan, rules, names)
    if not args.ref or not args.out:
        parser.error("give --ref and --out, or --scan")
    with tempfile.TemporaryDirectory() as work:
        export_ref(args.ref, work)
        transform(work, rules, names, excluded)
        if scan(work, rules, names):
            print("Stopped: the public tree holds private text. Nothing was written.", file=sys.stderr)
            return 1
        replace_tree(work, args.out)
    print(f"Wrote the public tree to {args.out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
