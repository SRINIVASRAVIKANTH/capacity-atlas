"""Checks on the locked development tools, so a known security fix cannot be undone by accident."""

import json
from pathlib import Path

LOCK = Path(__file__).resolve().parents[1] / "package-lock.json"


def _versions(lock, name):
    return [entry["version"] for path, entry in lock["packages"].items()
            if path == f"node_modules/{name}" or path.endswith(f"/node_modules/{name}")]


def test_the_lint_tools_use_a_minimatch_without_the_globparts_bug():
    """minimatch before 11.0.1 can be made to hang on some glob patterns (GHSA-g3hv-75wg-m249).

    ESLint still asks for minimatch 10, so package.json overrides it. When ESLint accepts
    11.0.1 or newer on its own, the override can go and this test still holds.
    """
    lock = json.loads(LOCK.read_text(encoding="utf-8"))
    versions = _versions(lock, "minimatch")
    assert versions, "minimatch is no longer in the lockfile: drop this test and the override"
    old = [v for v in versions if tuple(int(p) for p in v.split("-")[0].split(".")) < (11, 0, 1)]
    assert not old, f"minimatch {old} has the globparts bug; keep the override in package.json"
