"""Tests for scripts/release/build_public_tree.py. The names here are invented."""
import importlib.util
import sys
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[1] / "release" / "build_public_tree.py"
spec = importlib.util.spec_from_file_location("build_public_tree", SCRIPT)
build = importlib.util.module_from_spec(spec)
sys.modules["build_public_tree"] = build
spec.loader.exec_module(build)


def rules(tmp_path, text):
    path = tmp_path / "map.txt"
    path.write_text(text, encoding="utf-8")
    return build.load_map(path)


def test_map_keeps_the_case_of_the_source(tmp_path):
    table, _ = rules(tmp_path, "cloudbot==>orion\nmr. tower==>mr. vega\n")
    assert build.apply_map("cloudbot Cloudbot CLOUDBOT_ID", table) == "orion Orion ORION_ID"
    assert build.apply_map("ask Mr. Tower", table) == "ask Mr. Vega"
    assert build.apply_map("isCloudbot and cloudbotState", table) == "isOrion and orionState"
    assert build.apply_map("cloudbots stay", table) == "cloudbots stay"


def test_transform_changes_contents_and_paths_and_drops_excluded(tmp_path):
    table, excluded = rules(tmp_path, "cloudbot==>orion\nexclude:private\n")
    root = tmp_path / "tree"
    (root / "cloudbot-dir").mkdir(parents=True)
    (root / "private").mkdir()
    (root / "private/a.txt").write_text("x", encoding="utf-8")
    script = root / "cloudbot-dir/run-cloudbot.sh"
    script.write_text("start cloudbot\n", encoding="utf-8")
    script.chmod(0o755)
    build.transform(str(root), table, [], excluded)
    moved = root / "orion-dir/run-orion.sh"
    assert moved.read_text(encoding="utf-8") == "start orion\n"
    assert moved.stat().st_mode & 0o100
    assert not (root / "private").exists()


def test_scan_reports_a_term_a_home_path_and_a_key(tmp_path, capsys):
    table, _ = rules(tmp_path, "cloudbot==>orion\n")
    root = tmp_path / "tree"
    root.mkdir()
    (root / "a.txt").write_text("cloudbot\n/Us" + "ers/someone/x\n" + "AKIA" + "ABCDEFGHIJKLMNOP\n/Users/operator/ok\n", encoding="utf-8")
    assert build.scan(str(root), table, []) == 1
    out = capsys.readouterr().out
    assert "a.txt:1: cloudbot" in out
    assert "a.txt:2: path under /Users" in out
    assert "a.txt:3: AWS access key ID" in out
    assert "3 hit(s)" in out


def test_scan_passes_a_clean_tree(tmp_path):
    table, _ = rules(tmp_path, "cloudbot==>orion\n")
    root = tmp_path / "tree"
    root.mkdir()
    (root / "a.txt").write_text("orion\n", encoding="utf-8")
    assert build.scan(str(root), table, []) == 0
