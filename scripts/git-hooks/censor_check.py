#!/usr/bin/env python3
"""Keep private names out of commits. The code uses "the operator" instead.

The standard: tracked files and commit messages call the human who runs a
deployment "the operator". A personal name, handle, e-mail address or home path
stays in private settings.

The terms are private, so this file holds none of them. The term file is
${OASIS_CENSOR_FILE:-~/.config/oasis-x/censor-names.txt}, with one rule on each
line (lines that start with # are notes):

    <term>==><replacement>

A term that holds only letters matches a whole word in any case, and also a
camelCase part of an identifier. Any other term matches its exact text.

Modes:
    (run as pre-commit)   refuse a commit when a staged added line or a new
                          path holds a term
    (run as commit-msg)   refuse a commit when the message holds a term
    --fix [path ...]      replace the terms in working-tree files (default: the
                          staged files)
    --scan <dir>          report the terms in a directory tree
    --install [repo]      install this file as the two hooks of a repo

Without a term file the check prints one warning and passes, because a
container or another contributor does not have the file. To pass the check on
purpose, use `git commit --no-verify`.

This file uses only the standard library, so it runs under any python3.
"""
from __future__ import annotations

import os
import re
import shutil
import stat
import subprocess
import sys
from pathlib import Path
from typing import Iterable, List, Optional, Tuple

MARKER = "censor_check.py: keep private names out of commits"  # identifies an installed copy
SKIP_DIRS = {".git", "node_modules", ".venv", "__pycache__", "dist", "vendor"}
SENTENCE_MARKERS = ("//", "#", "*", "/*", "<!--", "-", ">", "►", '"""')

Rule = Tuple[str, str, "re.Pattern[str]"]


def term_file() -> Path:
    env = os.environ.get("OASIS_CENSOR_FILE")
    return Path(env).expanduser() if env else Path.home() / ".config/oasis-x/censor-names.txt"


def compile_term(term: str) -> "re.Pattern[str]":
    escaped = re.escape(term)
    if not term.isalpha():
        return re.compile(escaped)
    capitalized = re.escape(term[0].upper() + term[1:])
    lowered = re.escape(term[0].lower() + term[1:])
    return re.compile(
        rf"(?<![A-Za-z0-9])(?i:{escaped})(?![A-Za-z0-9])"  # a whole word, in any case
        rf"|(?<=[a-z]){capitalized}(?![a-z0-9])"  # isName
        rf"|(?<![A-Za-z0-9]){lowered}(?=[A-Z])"  # nameBody
    )


def load_rules(path: Path) -> List[Rule]:
    rules: List[Rule] = []
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "==>" not in line:
            continue
        term, replacement = line.split("==>", 1)
        rules.append((term, replacement, compile_term(term)))
    # A longer term goes first, so that a handle is not cut by a shorter name.
    rules.sort(key=lambda r: -len(r[0]))
    return rules


def find_terms(text: str, rules: List[Rule]) -> List[str]:
    return sorted({term for term, _, pattern in rules if pattern.search(text)})


def staged_additions() -> List[Tuple[str, int, str]]:
    """Return (path, line number, text) for each added line in the index."""
    diff = subprocess.run(
        ["git", "diff", "--cached", "-U0", "--no-color", "--no-ext-diff", "--diff-filter=ACMR"],
        capture_output=True, text=True, errors="replace", check=True,
    ).stdout
    rows: List[Tuple[str, int, str]] = []
    path, number = "", 0
    for line in diff.splitlines():
        if line.startswith("+++ "):
            target = line[4:]
            path = target[2:] if target.startswith("b/") else target
        elif line.startswith("@@"):
            found = re.search(r"\+(\d+)", line)
            number = int(found.group(1)) if found else 0
        elif line.startswith("+"):
            rows.append((path, number, line[1:]))
            number += 1
    return rows


def staged_paths() -> List[str]:
    out = subprocess.run(
        ["git", "diff", "--cached", "--name-only", "--diff-filter=ACMR", "-z"],
        capture_output=True, text=True, check=True,
    ).stdout
    return [p for p in out.split("\0") if p]


def check_commit(rules: List[Rule]) -> int:
    hits = [
        (path, number, term)
        for path, number, text in staged_additions()
        for term in find_terms(text, rules)
    ]
    hits += [(path, 0, term) for path in staged_paths() for term in find_terms(path, rules)]
    if not hits:
        return 0
    print("Commit refused: staged lines hold a private name. Write \"the operator\".", file=sys.stderr)
    for path, number, term in hits[:40]:
        print(f"  {path}:{number}: {term}", file=sys.stderr)
    if len(hits) > 40:
        print(f"  ... and {len(hits) - 40} more", file=sys.stderr)
    print("To replace the names: python3 scripts/git-hooks/censor_check.py --fix", file=sys.stderr)
    print("Then read the result, stage it and commit again.", file=sys.stderr)
    return 1


def check_message(path: str, rules: List[Rule]) -> int:
    body = "\n".join(
        line for line in Path(path).read_text(encoding="utf-8", errors="replace").splitlines()
        if not line.startswith("#")
    )
    terms = find_terms(body, rules)
    if not terms:
        return 0
    print(f"Commit refused: the message holds a private name: {', '.join(terms)}.", file=sys.stderr)
    print("Write \"the operator\" in the message.", file=sys.stderr)
    return 1


def starts_sentence(before: str, previous_line: str) -> bool:
    stripped = before.rstrip()
    if re.search(r"[.!?]$|\\n$", stripped):
        return True
    if before and before[-1] in "\"'`":
        return True
    remainder = stripped.strip()
    for marker in SENTENCE_MARKERS:
        if remainder.startswith(marker):
            remainder = remainder[len(marker):].strip()
    if remainder:
        return False
    # The word is the first word of a line. A sentence can continue from the last line.
    last = previous_line.strip()
    return not last or bool(re.search(r"[.!?:;]$", last)) or last in ("//", "#", "*", "/*", "/**", "<!--")


def replacement_for(match: "re.Match[str]", replacement: str, line: str, previous_line: str) -> str:
    word = match.group(0)
    if not word.isalpha():
        return replacement
    bare = replacement[4:] if replacement.startswith("the ") else replacement
    start, end = match.start(), match.end()
    before, after = line[:start], line[end:]
    if word.isupper() and len(word) > 1:
        # A word in a capital-letter heading takes the full phrase. A constant takes one word.
        heading = re.search(r"[A-Z]{2,}\s+$", before) or re.match(r"'S\b|\s+[A-Z]{2,}", after)
        return (replacement if heading else bare).upper()
    if word[0].islower():
        return bare
    if before and before[-1].islower():  # isName
        return bare[0].upper() + bare[1:]
    if before.endswith("(") and re.match(r",|\s+20\d\d", after):  # an attribution with a date
        return bare
    if starts_sentence(before, previous_line):
        return replacement[0].upper() + replacement[1:]
    return replacement


def fix_text(text: str, rules: List[Rule]) -> str:
    lines = text.split("\n")
    for index, line in enumerate(lines):
        previous = lines[index - 1] if index else ""
        for _, replacement, pattern in rules:
            line = pattern.sub(lambda m, l=line: replacement_for(m, replacement, l, previous), line)
        lines[index] = line
    return "\n".join(lines)


def fix_files(paths: Iterable[str], rules: List[Rule]) -> int:
    changed = 0
    for name in paths:
        path = Path(name)
        try:
            text = path.read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError):
            continue
        fixed = fix_text(text, rules)
        if fixed != text:
            path.write_text(fixed, encoding="utf-8")
            changed += 1
            print(f"fixed {name}")
    print(f"{changed} file(s) changed. Read each change before you commit: a sentence can need new words.")
    return 0


def scan_tree(root: str, rules: List[Rule]) -> int:
    count = 0
    for folder, dirs, files in os.walk(root):
        dirs[:] = [d for d in dirs if d not in SKIP_DIRS]
        for name in files + dirs:
            relative = os.path.relpath(os.path.join(folder, name), root)
            for term in find_terms(relative, rules):
                print(f"{relative}:0: {term}")
                count += 1
        for name in files:
            if name in SKIP_DIRS:  # a worktree has a .git file
                continue
            path = os.path.join(folder, name)
            relative = os.path.relpath(path, root)
            try:
                text = Path(path).read_text(encoding="utf-8")
            except (OSError, UnicodeDecodeError):
                continue
            for number, line in enumerate(text.splitlines(), 1):
                for term in find_terms(line, rules):
                    print(f"{relative}:{number}: {term}")
                    count += 1
    print(f"{count} hit(s)")
    return 1 if count else 0


def install(repo: str) -> int:
    common = subprocess.run(
        ["git", "-C", repo, "rev-parse", "--path-format=absolute", "--git-common-dir"],
        capture_output=True, text=True, check=True,
    ).stdout.strip()
    hooks = Path(common) / "hooks"
    hooks.mkdir(exist_ok=True)
    for name in ("pre-commit", "commit-msg"):
        target = hooks / name
        if target.exists() and MARKER not in target.read_text(encoding="utf-8", errors="replace"):
            print(f"Stopped: {target} exists and this tool did not install it.", file=sys.stderr)
            return 1
        shutil.copyfile(__file__, target)
        target.chmod(target.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)
        print(f"installed {target}")
    return 0


def main(argv: List[str]) -> int:
    if len(argv) > 1 and argv[1] == "--install":
        return install(argv[2] if len(argv) > 2 else ".")
    path = term_file()
    if not path.is_file():
        print(f"censor_check: no term file at {path}. The name check did not run.", file=sys.stderr)
        return 0
    rules = load_rules(path)
    invoked = Path(argv[0]).name
    if len(argv) > 1 and argv[1] == "--fix":
        return fix_files(argv[2:] or staged_paths(), rules)
    if len(argv) > 2 and argv[1] == "--scan":
        return scan_tree(argv[2], rules)
    if invoked == "commit-msg" and len(argv) > 1:
        return check_message(argv[1], rules)
    return check_commit(rules)


if __name__ == "__main__":
    sys.exit(main(sys.argv))
