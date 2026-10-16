"""The command line entry points start and describe their options."""

import subprocess
import sys

import pytest


@pytest.mark.parametrize("module", ["capacity_atlas.pipeline", "capacity_atlas.tiles", "capacity_atlas.quality"])
def test_command_line_help(module):
    result = subprocess.run([sys.executable, "-m", module, "--help"], capture_output=True, text=True)
    assert result.returncode == 0, result.stderr
    assert "usage:" in result.stdout


def test_pipeline_rejects_an_unknown_source():
    result = subprocess.run([sys.executable, "-m", "capacity_atlas.pipeline", "--source", "con_ed"],
                            capture_output=True, text=True)
    assert result.returncode == 2 and "invalid choice" in result.stderr
