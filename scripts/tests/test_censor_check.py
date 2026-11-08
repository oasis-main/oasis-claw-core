"""Tests for scripts/git-hooks/censor_check.py. The names here are invented."""
import importlib.util
import os
import subprocess
import sys
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[1] / "git-hooks" / "censor_check.py"
spec = importlib.util.spec_from_file_location("censor_check", SCRIPT)
censor = importlib.util.module_from_spec(spec)
sys.modules["censor_check"] = censor
spec.loader.exec_module(censor)

RULES = [
    ("AliceBHandle", "operator-account", censor.compile_term("AliceBHandle")),
    ("Alice", "the operator", censor.compile_term("Alice")),
    ("/home/alice", "/home/operator", censor.compile_term("/home/alice")),
]


def fix(text):
    return censor.fix_text(text, RULES)


def test_terms_match_words_and_camel_case_but_not_other_words():
    assert censor.find_terms("ask Alice", RULES) == ["Alice"]
    assert censor.find_terms("ALICE_ID", RULES) == ["Alice"]
    assert censor.find_terms("isAlice(x)", RULES) == ["Alice"]
    assert censor.find_terms("aliceBody", RULES) == ["Alice"]
    assert censor.find_terms("malice and palace", RULES) == []
    assert censor.find_terms("Alicent", RULES) == []
    assert "/home/alice" in censor.find_terms("at /home/alice/x", RULES)


def test_fix_keeps_prose_correct():
    assert fix("ask Alice now") == "ask the operator now"
    assert fix("needs Alice's approval") == "needs the operator's approval"
    assert fix('reason: "Alice denied it"') == 'reason: "The operator denied it"'
    assert fix("Done. Alice approved.") == "Done. The operator approved."
    assert fix("// Alice approved this") == "// The operator approved this"


def test_fix_keeps_a_continued_sentence_in_lower_case():
    assert fix("// confirm this with\n// Alice tomorrow") == "// confirm this with\n// the operator tomorrow"


def test_fix_handles_tokens_identifiers_capitals_and_dates():
    assert fix('proposer === "alice"') == 'proposer === "operator"'
    assert fix("isAlice(a)") == "isOperator(a)"
    assert fix("aliceBody(a)") == "operatorBody(a)"
    assert fix("NEEDS FROM ALICE:") == "NEEDS FROM THE OPERATOR:"
    assert fix("const ALICE = 1") == "const OPERATOR = 1"
    assert fix("rule (Alice, 2026-01-02)") == "rule (operator, 2026-01-02)"


def test_load_rules_reads_rules_and_puts_the_longer_term_first(tmp_path):
    terms = tmp_path / "terms.txt"
    terms.write_text("# a note\nAlice==>the operator\nAliceBHandle==>operator-account\nno rule here\n", encoding="utf-8")
    rules = censor.load_rules(terms)
    assert [r[0] for r in rules] == ["AliceBHandle", "Alice"]
    assert censor.fix_text("owner AliceBHandle", rules) == "owner operator-account"


def run(repo, env, *args):
    return subprocess.run(["git", "-C", str(repo), *args], capture_output=True, text=True, env=env)


def make_repo(tmp_path, with_terms=True):
    repo = tmp_path / "repo"
    repo.mkdir()
    terms = tmp_path / "terms.txt"
    if with_terms:
        terms.write_text("# a note\nAlice==>the operator\n", encoding="utf-8")
    env = {**os.environ, "OASIS_CENSOR_FILE": str(terms), "GIT_AUTHOR_NAME": "t", "GIT_AUTHOR_EMAIL": "t@example.com", "GIT_COMMITTER_NAME": "t", "GIT_COMMITTER_EMAIL": "t@example.com"}
    assert run(repo, env, "init", "-q").returncode == 0
    assert subprocess.run([sys.executable, str(SCRIPT), "--install", str(repo)], capture_output=True, env=env).returncode == 0
    return repo, env


def test_hook_refuses_a_staged_name_and_passes_clean_text(tmp_path):
    repo, env = make_repo(tmp_path)
    (repo / "a.txt").write_text("hello Alice\n", encoding="utf-8")
    run(repo, env, "add", "a.txt")
    refused = run(repo, env, "commit", "-q", "-m", "add a")
    assert refused.returncode != 0
    assert "a.txt:1: Alice" in refused.stderr
    (repo / "a.txt").write_text("hello the operator\n", encoding="utf-8")
    run(repo, env, "add", "a.txt")
    assert run(repo, env, "commit", "-q", "-m", "add a").returncode == 0


def test_hook_checks_only_added_lines(tmp_path):
    repo, env = make_repo(tmp_path)
    (repo / "a.txt").write_text("Alice\nkeep\n", encoding="utf-8")
    run(repo, env, "add", "a.txt")
    assert run(repo, env, "commit", "-q", "--no-verify", "-m", "old").returncode == 0
    (repo / "a.txt").write_text("Alice\nkeep\nnew line\n", encoding="utf-8")
    run(repo, env, "add", "a.txt")
    assert run(repo, env, "commit", "-q", "-m", "new").returncode == 0


def test_hook_refuses_a_name_in_the_message_or_the_path(tmp_path):
    repo, env = make_repo(tmp_path)
    (repo / "a.txt").write_text("clean\n", encoding="utf-8")
    run(repo, env, "add", "a.txt")
    assert run(repo, env, "commit", "-q", "-m", "from Alice").returncode != 0
    (repo / "alice-notes.txt").write_text("clean\n", encoding="utf-8")
    run(repo, env, "add", "alice-notes.txt")
    assert "alice-notes.txt:0: Alice" in run(repo, env, "commit", "-q", "-m", "notes").stderr


def test_hook_passes_with_a_warning_when_the_term_file_is_absent(tmp_path):
    repo, env = make_repo(tmp_path, with_terms=False)
    (repo / "a.txt").write_text("Alice\n", encoding="utf-8")
    run(repo, env, "add", "a.txt")
    result = run(repo, env, "commit", "-q", "-m", "add a")
    assert result.returncode == 0
    assert "did not run" in result.stderr


def test_install_does_not_replace_another_hook(tmp_path):
    repo = tmp_path / "repo"
    repo.mkdir()
    subprocess.run(["git", "-C", str(repo), "init", "-q"], check=True)
    (repo / ".git/hooks/pre-commit").write_text("#!/bin/sh\nexit 0\n", encoding="utf-8")
    result = subprocess.run([sys.executable, str(SCRIPT), "--install", str(repo)], capture_output=True, text=True)
    assert result.returncode == 1
    assert "did not install" in result.stderr
