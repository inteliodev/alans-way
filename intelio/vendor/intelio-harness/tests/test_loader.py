import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

from intelio_harness.loader import (
    PROFILE_FIELDS,
    HarnessRefused,
    default_pin_path,
    load_profile,
    repo_root,
)

ROOT = repo_root()
PIN = ROOT / "pin" / "hermes.yaml"
EXAMPLE = ROOT / "examples" / "example-client"
VERIFIED_COMMIT = "5d3c05977bb3c8b7cfd6b3e39d96f6e35a9e0662"


def test_example_profile_loads_verified_pin():
    profile, pin = load_profile(EXAMPLE, PIN)
    assert profile.name == "Example Client"
    assert profile.panels == ("sample-panel",)
    assert profile.skills == ("sample-skill",)
    assert profile.allowed_folders == ("sample-notes",)
    assert pin.upstream == "NousResearch/hermes-agent"
    assert pin.repository == "https://github.com/NousResearch/hermes-agent"
    assert pin.commit == VERIFIED_COMMIT
    assert pin.verified_on == "2026-10-03"
    assert default_pin_path() == PIN


def test_missing_profile_refuses(tmp_path: Path):
    with pytest.raises(HarnessRefused, match="profile.yaml is missing"):
        load_profile(tmp_path, PIN)


def test_missing_pin_refuses(tmp_path: Path):
    (tmp_path / "profile.yaml").write_text(
        "name: Example Client\npanels: []\nskills: []\nallowed_folders: []\n",
        encoding="utf-8",
    )
    with pytest.raises(HarnessRefused, match="pin file is missing"):
        load_profile(tmp_path, tmp_path / "pin" / "hermes.yaml")


def test_machine_path_folder_refuses(tmp_path: Path):
    (tmp_path / "profile.yaml").write_text(
        "name: Example Client\npanels: []\nskills: []\nallowed_folders:\n  - /tmp/secret\n",
        encoding="utf-8",
    )
    with pytest.raises(HarnessRefused, match="relative folder names"):
        load_profile(tmp_path, PIN)


def test_schema_required_fields_match_loader():
    schema = json.loads((ROOT / "schema" / "profile.schema.json").read_text(encoding="utf-8"))
    assert tuple(schema["required"]) == PROFILE_FIELDS
    assert schema["additionalProperties"] is False


def test_env_example_lists_names_only():
    text = (EXAMPLE / ".env.example").read_text(encoding="utf-8")
    names = []
    for line in text.splitlines():
        stripped = line.strip()
        if stripped == "" or stripped.startswith("#"):
            continue
        name, separator, value = stripped.partition("=")
        assert separator == "="
        assert name.isidentifier() and name.isupper()
        assert value == ""
        names.append(name)
    assert names == ["SAMPLE_API_KEY", "SAMPLE_SIGNING_SECRET"]


def test_cli_loads_example_profile():
    result = _run([str(EXAMPLE), "--pin", str(PIN)])
    assert result.returncode == 0, result.stderr
    assert "profile: Example Client" in result.stdout
    assert f"hermes_commit: {VERIFIED_COMMIT}" in result.stdout
    assert result.stderr == ""


def test_cli_json_loads_example_profile():
    result = _run([str(EXAMPLE), "--pin", str(PIN), "--json"])
    assert result.returncode == 0, result.stderr
    payload = json.loads(result.stdout)
    assert payload["profile"]["name"] == "Example Client"
    assert payload["profile"]["panels"] == ["sample-panel"]
    assert payload["profile"]["skills"] == ["sample-skill"]
    assert payload["profile"]["allowed_folders"] == ["sample-notes"]
    assert payload["profile"]["directory"] == str(EXAMPLE.resolve())
    assert payload["pin"]["upstream"] == "NousResearch/hermes-agent"
    assert payload["pin"]["repository"] == "https://github.com/NousResearch/hermes-agent"
    assert payload["pin"]["commit"] == VERIFIED_COMMIT
    assert payload["pin"]["verified_on"] == "2026-10-03"
    assert result.stderr == ""


def test_cli_json_refuses_when_pin_is_missing(tmp_path: Path):
    result = _run([str(EXAMPLE), "--pin", str(tmp_path / "hermes.yaml"), "--json"])
    assert result.returncode == 1
    assert "refused to start" in result.stderr
    assert "pin file is missing" in result.stderr
    assert result.stdout == ""


def test_cli_refuses_when_pin_is_missing(tmp_path: Path):
    result = _run([str(EXAMPLE), "--pin", str(tmp_path / "hermes.yaml")])
    assert result.returncode == 1
    assert "refused to start" in result.stderr
    assert "pin file is missing" in result.stderr
    assert result.stdout == ""


def test_repo_has_no_hermes_checkout():
    assert not (ROOT / ".gitmodules").exists()
    assert not (ROOT / "hermes-agent").exists()
    assert not (ROOT / "vendor").exists()
    pin_text = PIN.read_text(encoding="utf-8")
    assert "NousResearch/hermes-agent" in pin_text
    assert len(pin_text) < 2000
    assert (ROOT / "brand" / "window-title.txt").read_text(encoding="utf-8").strip() == "Intelio"


def _run(args: list[str]) -> subprocess.CompletedProcess[str]:
    env = os.environ.copy()
    env["PYTHONPATH"] = str(ROOT / "src")
    return subprocess.run(
        [sys.executable, "-m", "intelio_harness", *args],
        cwd=ROOT,
        env=env,
        capture_output=True,
        text=True,
        check=False,
    )
