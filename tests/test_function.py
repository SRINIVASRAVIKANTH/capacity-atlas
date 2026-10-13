"""Runs the JavaScript tests for the AI search function when Node.js is installed."""

import shutil
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]


@pytest.mark.skipif(shutil.which("node") is None, reason="Node.js is not installed")
def test_ai_search_function():
    result = subprocess.run(
        ["node", "--test", str(ROOT / "tests" / "js" / "ask.test.mjs")],
        capture_output=True, text=True, cwd=ROOT,
    )
    assert result.returncode == 0, result.stdout[-3000:] + result.stderr[-2000:]
