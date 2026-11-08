#!/usr/bin/env python3
"""Tests for scripts/claw-decider-report (training-data review 2026-11-07, T2/T3).

The report must count what it cannot read instead of dropping it in silence:
unparseable lines, rows without a readable time, and a container read error.
It must also show the new reviewer rows: decider_dropped (the in-flight cap),
audit_write_error (an outage of the audit writer) and kind "l1_only".
It must print aggregates only, never row content.

Run directly:  python3 scripts/tests/test_claw_decider_report.py
Stdlib only.
"""

from __future__ import annotations

import contextlib
import datetime as dt
import importlib.machinery
import importlib.util
import io
import json
import subprocess
import sys
import unittest
from pathlib import Path
from unittest import mock

SCRIPT = Path(__file__).resolve().parent.parent / "claw-decider-report"
_loader = importlib.machinery.SourceFileLoader("claw_decider_report", str(SCRIPT))
_spec = importlib.util.spec_from_loader("claw_decider_report", _loader)
report = importlib.util.module_from_spec(_spec)
_loader.exec_module(report)

NOW = dt.datetime(2026, 11, 7, 12, 0, tzinfo=dt.timezone.utc)
SINCE = NOW - dt.timedelta(hours=24)
RECENT = "2026-11-07T11:00:00.000Z"
OLD = "2026-11-01T11:00:00.000Z"
SECRET = "SENTINEL-ROW-CONTENT-7f3a"


def line(**row) -> str:
    return json.dumps(row)


def sample() -> str:
    return "\n".join([
        line(ts=RECENT, phase="before_tool_call", params=SECRET),
        line(ts=RECENT, phase="decider_shadow", kind="tool_call", l2Verdict="allow", decVerdict="allow",
             decVerdictP=0.95, decAgreesWithL2=True, decTimeoutMs=60000, decClipped=["params"],
             decState={"params": SECRET}),
        line(ts=RECENT, phase="decider_shadow", kind="l1_only", l1Verdict="allow", decVerdict="escalate",
             decVerdictP=0.6, decAgreesWithL1=False, decTimeoutMs=60000, decClipped=[],
             decState={"params": SECRET}),
        line(ts=RECENT, phase="decider_shadow", kind="l1_only", l1Verdict="deny", decVerdict="deny",
             decVerdictP=0.9, decAgreesWithL1=True, decTimeoutMs=60000, decClipped=["params", "operator_request"]),
        line(ts=OLD, phase="decider_shadow", kind="tool_call", l2Verdict="deny", decVerdict="allow"),
        line(ts=RECENT, phase="decider_dropped", kind="l1_only", dropReason="inflight_cap"),
        line(ts=RECENT, phase="decider_dropped", kind="tool_call", dropReason="inflight_cap"),
        line(ts=RECENT, phase="audit_write_error", failedWrites=5, lostRows=2, recoveredRows=3),
        '{"ts":"2026-11-07T11:00:00Z","phase":"decider_shadow","kind":"tool_c',  # cut mid-row
        "[1, 2]",  # valid JSON, not a row
        "",  # blank: skipped, not counted
        "   ",
        line(phase="decider_shadow", kind="tool_call"),  # no ts
        line(ts="not-a-time", phase="decider_dropped"),
    ])


class ParseAudit(unittest.TestCase):
    def test_counts_what_it_cannot_read(self):
        p = report.parse_audit(sample(), SINCE)
        self.assertEqual(p["unparseable"], 2)
        self.assertEqual(p["bad_ts"], 2)
        self.assertEqual(p["lines"], 12)

    def test_splits_phases_and_applies_the_window(self):
        p = report.parse_audit(sample(), SINCE)
        self.assertEqual(len(p["decider_shadow"]), 3)  # the OLD row is outside the window
        self.assertEqual(len(p["decider_dropped"]), 2)
        self.assertEqual(len(p["audit_write_error"]), 1)

    def test_naive_timestamp_is_read_as_utc(self):
        p = report.parse_audit(line(ts="2026-11-07T11:00:00", phase="decider_shadow"), SINCE)
        self.assertEqual(len(p["decider_shadow"]), 1)
        self.assertEqual(p["bad_ts"], 0)


class Summarize(unittest.TestCase):
    def setUp(self):
        p = report.parse_audit(sample(), SINCE)
        p["read_error"] = None
        self.s = report.summarize(p)

    def test_loss_counters(self):
        s = self.s
        self.assertEqual(s["unparseable_lines"], 2)
        self.assertEqual(s["bad_ts"], 2)
        self.assertEqual(s["dropped"], 2)
        self.assertEqual(s["dropped_by_kind"], {"l1_only": 1, "tool_call": 1})
        self.assertEqual(s["write_error_rows"], 1)
        self.assertEqual(s["write_failed_writes"], 5)
        self.assertEqual(s["write_lost_rows"], 2)

    def test_l1_only_rows(self):
        s = self.s
        self.assertEqual(s["l1_only"], 2)
        self.assertEqual(s["l1_only_agree"], 0.5)
        self.assertEqual(s["l1_only_confusion"], {"allow->escalate": 1, "deny->deny": 1})
        self.assertEqual(s["by_kind"], {"tool_call": 1, "l1_only": 2})
        # The judge agreement still uses tool_call rows only.
        self.assertEqual(s["paired_with_judge"], 1)
        self.assertEqual(s["agree"], 1.0)

    def test_clip_and_timeout_fields(self):
        self.assertEqual(self.s["clipped_fields"], {"params": 2, "operator_request": 1})
        self.assertEqual(self.s["timeout_ms"], {"60000": 3})

    def test_merge_adds_counts_over_bots(self):
        a = report.parse_audit(sample(), SINCE)
        b = report.parse_audit(sample(), SINCE)
        a["read_error"], b["read_error"] = None, "exit 1: no such container"
        m = report.merge([a, b])
        self.assertEqual(m["unparseable"], 4)
        self.assertEqual(len(m["decider_dropped"]), 4)
        self.assertEqual(m["read_error"], "1 bot(s)")


class RowsFor(unittest.TestCase):
    def test_missing_docker_is_a_read_error(self):
        with mock.patch.object(report.subprocess, "run", side_effect=FileNotFoundError("docker")):
            p = report.rows_for("oasis-claw-vega", SINCE)
        self.assertEqual(p["read_error"], "FileNotFoundError")
        self.assertEqual(p["decider_shadow"], [])

    def test_nonzero_exit_is_a_read_error(self):
        done = subprocess.CompletedProcess(args=[], returncode=1, stdout="", stderr="Error: No such container\n")
        with mock.patch.object(report.subprocess, "run", return_value=done):
            p = report.rows_for("oasis-claw-vega", SINCE)
        self.assertTrue(p["read_error"].startswith("exit 1: Error: No such container"))

    def test_success_has_no_read_error(self):
        done = subprocess.CompletedProcess(args=[], returncode=0, stdout=sample(), stderr="")
        with mock.patch.object(report.subprocess, "run", return_value=done):
            p = report.rows_for("oasis-claw-vega", SINCE)
        self.assertIsNone(p["read_error"])
        self.assertEqual(p["unparseable"], 2)


class Main(unittest.TestCase):
    def run_main(self, *args: str) -> str:
        done = subprocess.CompletedProcess(args=[], returncode=0, stdout=sample(), stderr="")
        buf = io.StringIO()
        with mock.patch.object(report.subprocess, "run", return_value=done), \
                mock.patch.object(sys, "argv", ["claw-decider-report", "--hours", "1e6", "--bot", "vega", *args]), \
                contextlib.redirect_stdout(buf):
            self.assertEqual(report.main(), 0)
        return buf.getvalue()

    def test_text_output_shows_loss_counters_and_no_row_content(self):
        out = self.run_main()
        self.assertIn("unparseable 2", out)
        self.assertIn("dropped 2", out)
        self.assertIn("l1-only", out)
        self.assertNotIn(SECRET, out)

    def test_json_output_has_no_row_content(self):
        out = self.run_main("--json")
        self.assertNotIn(SECRET, out)
        self.assertEqual(json.loads(out)["vega"]["unparseable_lines"], 2)


if __name__ == "__main__":
    unittest.main()
