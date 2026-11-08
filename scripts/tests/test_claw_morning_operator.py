"""The operator-name setting in the morning prompts. The names here are invented."""
import importlib.machinery
import importlib.util
from pathlib import Path

PATH = Path(__file__).resolve().parents[1] / "claw-morning"
loader = importlib.machinery.SourceFileLoader("claw_morning", str(PATH))
spec = importlib.util.spec_from_loader("claw_morning", loader)
morning = importlib.util.module_from_spec(spec)
loader.exec_module(morning)


def test_sources_apply_in_order():
    settings = {"profile": {"callThem": "Sam", "name": "Full Name"}}
    assert morning.resolve_operator_name("Alex", "OASIS_OPERATOR_NAME=Pat\n", settings) == "Alex"
    assert morning.resolve_operator_name(None, "OASIS_OPERATOR_NAME=Pat\n", settings) == "Pat"
    assert morning.resolve_operator_name(None, "", settings) == "Sam"
    assert morning.resolve_operator_name(None, "", None) == "the operator"


def test_a_value_that_is_not_a_plain_name_is_ignored():
    for bad in ("", "operator", "a: b", "{x}", "x" * 41):
        assert morning.clean_operator_name(bad) == ""
    assert morning.clean_operator_name("Dr. O'Neil") == "Dr. O'Neil"


def test_the_templates_take_the_name():
    for template in (morning.WORK_TEMPLATE, morning.REPORT_TEMPLATE, morning.BRIEF_TEMPLATE):
        assert "the operator" not in template.replace("{operator}", "")
    assert "NEEDS FROM {OPERATOR}" in morning.WORK_TEMPLATE
