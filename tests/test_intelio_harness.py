"""Real harness loader, fork sidecar, Hermes pin check, and safety defaults."""

from __future__ import annotations

import json
import os
from pathlib import Path
import stat
import subprocess
import sys
import tempfile
import textwrap
import unittest

ROOT = Path(__file__).resolve().parents[1]
HARNESS = ROOT / "intelio" / "vendor" / "intelio-harness"
sys.path.insert(0, str(HARNESS / "src"))
sys.path.insert(0, str(ROOT / "intelio" / "python"))

from alans_way.files import FileBound, bind_folders, read_text  # noqa: E402
from alans_way.report import ForkRefusal, load_report  # noqa: E402
from alans_way.safety import classify_url, enforce, navigation_allowed, redact  # noqa: E402
from intelio_harness.loader import HarnessRefused, load_profile  # noqa: E402

EXAMPLE = ROOT / "intelio" / "profiles" / "example"
PIN = "5d3c05977bb3c8b7cfd6b3e39d96f6e35a9e0662"
SENTINEL = "super-secret-vault-value"


def _empty_env(path: Path) -> dict:
    return {"PATH": str(path), "LANG": "C"}


def _python_path() -> str:
    return os.pathsep.join([str(ROOT / "intelio" / "python"), str(HARNESS / "src")])


class RealLoaderTests(unittest.TestCase):
    def test_example_profile_matches_the_real_schema_and_pin(self):
        schema = json.loads((HARNESS / "schema" / "profile.schema.json").read_text(encoding="utf-8"))
        import yaml
        document = yaml.safe_load((EXAMPLE / "profile.yaml").read_text(encoding="utf-8"))
        self.assertFalse(schema["additionalProperties"])
        self.assertTrue(set(schema["required"]) <= set(document))
        self.assertTrue(set(document) <= set(schema["properties"]))
        self.assertNotIn("browsing_origins", document)
        self.assertNotIn("safety", document)
        self.assertNotIn("hermes_profile", document)
        profile, pin = load_profile(EXAMPLE, HARNESS / "pin" / "hermes.yaml")
        self.assertEqual(profile.name, "Example")
        self.assertEqual(profile.allowed_folders, ("files",))
        self.assertEqual(pin.commit, PIN)
        self.assertEqual(pin.verified_on, "2026-10-03")
        self.assertEqual((HARNESS / "SOURCE_COMMIT.txt").read_text(encoding="utf-8").strip(),
                         "996267ba526254310a029e3c63825561e470c654")
        self.assertNotIn("sync_status", (HARNESS / "pin" / "hermes.yaml").read_text(encoding="utf-8"))

    def test_missing_profile_yaml_refuses(self):
        with tempfile.TemporaryDirectory() as tmp:
            with self.assertRaises(HarnessRefused) as raised:
                load_profile(tmp, HARNESS / "pin" / "hermes.yaml")
        self.assertIn("profile.yaml is missing", str(raised.exception))

    def test_missing_pin_refuses(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            profile = root / "profile"
            profile.mkdir()
            (profile / "profile.yaml").write_text("name: Example\npanels: []\nskills: []\nallowed_folders: []\n", encoding="utf-8")
            with self.assertRaises(HarnessRefused) as raised:
                load_profile(profile, root / "missing-pin.yaml")
        self.assertIn("pin file is missing", str(raised.exception))

    def test_cli_refusal_does_not_print_a_success_report(self):
        env = os.environ.copy()
        env["PYTHONPATH"] = str(HARNESS / "src")
        env["PYTHONDONTWRITEBYTECODE"] = "1"
        with tempfile.TemporaryDirectory() as tmp:
            proc = subprocess.run(
                [sys.executable, "-m", "intelio_harness", tmp, "--pin", str(HARNESS / "pin" / "hermes.yaml")],
                cwd=HARNESS, env=env, capture_output=True, text=True, check=False,
            )
        self.assertEqual(proc.returncode, 1)
        self.assertEqual(proc.stdout, "")
        self.assertIn("refused to start", proc.stderr)
        self.assertNotIn('"ok": true', proc.stdout)

    def test_extra_field_is_rejected_without_echoing_it(self):
        with tempfile.TemporaryDirectory() as tmp:
            profile = Path(tmp) / "profile"
            profile.mkdir()
            text = (EXAMPLE / "profile.yaml").read_text(encoding="utf-8")
            text += f"\napi_token: {SENTINEL}\n"
            (profile / "profile.yaml").write_text(text, encoding="utf-8")
            with self.assertRaises(HarnessRefused) as raised:
                load_profile(profile, HARNESS / "pin" / "hermes.yaml")
        self.assertNotIn(SENTINEL, str(raised.exception))


class ForkReportTests(unittest.TestCase):
    def test_example_profile_loads_without_reading_env(self):
        env_file = EXAMPLE / ".env"
        env_file.write_text(f"API_TOKEN={SENTINEL}\npassword={SENTINEL}\n", encoding="utf-8")
        self.addCleanup(env_file.unlink)
        with tempfile.TemporaryDirectory() as tmp:
            report = load_report(EXAMPLE, pin_path=HARNESS / "pin" / "hermes.yaml", environ=_empty_env(Path(tmp)))
        body = json.dumps(report)
        self.assertNotIn(SENTINEL, body)
        self.assertTrue(report["ok"])
        self.assertEqual(report["profile"]["name"], "Example")
        self.assertEqual(report["profile"]["hermes_profile"], "example")
        self.assertEqual(report["profile"]["allowed_folders"], ["files"])
        self.assertEqual(report["hermes"]["launch_argv"], ["hermes", "-p", "example"])
        self.assertEqual(report["hermes"]["probe_argv"], ["hermes", "-p", "example", "--version"])
        self.assertFalse(report["safety"]["yolo"])
        self.assertEqual(report["safety"]["consequential"], "ask")
        self.assertTrue(report["safety"]["vault_blind"])
        self.assertTrue(report["secrets_file_present"])
        self.assertEqual(report["brand"]["window_title"], "Intelio")
        self.assertEqual(report["brand"]["tokens"]["font"], "Geist")
        self.assertEqual(report["pin"]["commit"], PIN)
        self.assertEqual(report["pin"]["verified_on"], "2026-10-03")
        self.assertNotIn("sync_status", report["pin"])
        self.assertIn("Alex Hansen", report["attribution"])
        self.assertIn("Nous Research", report["attribution"])

    def test_yolo_env_cannot_enable_yolo(self):
        previous = os.environ.get("INTELIO_YOLO")
        os.environ["INTELIO_YOLO"] = "1"
        self.addCleanup(lambda: os.environ.pop("INTELIO_YOLO", None) if previous is None else os.environ.__setitem__("INTELIO_YOLO", previous))
        with tempfile.TemporaryDirectory() as tmp:
            report = load_report(EXAMPLE, pin_path=HARNESS / "pin" / "hermes.yaml", environ=_empty_env(Path(tmp)))
        self.assertFalse(report["safety"]["yolo"])

    def test_sidecar_yolo_refuses(self):
        with tempfile.TemporaryDirectory() as tmp:
            profile = Path(tmp) / "profile"
            profile.mkdir()
            (profile / "profile.yaml").write_text(
                "name: Example\npanels: []\nskills: []\nallowed_folders: []\n", encoding="utf-8")
            (profile / "alans-way.yaml").write_text("safety:\n  yolo: true\n  consequential: ask\n", encoding="utf-8")
            with self.assertRaises(ForkRefusal) as raised:
                load_report(profile, pin_path=HARNESS / "pin" / "hermes.yaml", environ=_empty_env(Path(tmp)))
        self.assertIn("YOLO is not allowed", str(raised.exception))


class PinCheckTests(unittest.TestCase):
    def _stub(self, directory: Path, body: str) -> dict:
        script = directory / "hermes"
        script.write_text("#!/bin/sh\n" + body, encoding="utf-8")
        script.chmod(script.stat().st_mode | stat.S_IXUSR)
        return _empty_env(directory)

    def test_failed_probe_is_not_a_match_and_stderr_is_redacted(self):
        with tempfile.TemporaryDirectory() as tmp:
            env = self._stub(Path(tmp), f"echo password={SENTINEL} >&2\nexit 1\n")
            report = load_report(EXAMPLE, pin_path=HARNESS / "pin" / "hermes.yaml", environ=env)
        hermes = report["hermes"]
        self.assertFalse(hermes["command_ok"])
        self.assertEqual(hermes["match"], "unavailable")
        self.assertNotEqual(hermes["summary"], "installed commit matches the pin")
        self.assertIn("probe failed", hermes["summary"])
        self.assertNotIn(SENTINEL, json.dumps(hermes))

    def test_matching_commit_is_reported_only_after_exit_zero(self):
        with tempfile.TemporaryDirectory() as tmp:
            env = self._stub(Path(tmp), f"echo Hermes Agent upstream {PIN}\nexit 0\n")
            report = load_report(EXAMPLE, pin_path=HARNESS / "pin" / "hermes.yaml", environ=env)
        self.assertTrue(report["hermes"]["command_ok"])
        self.assertEqual(report["hermes"]["match"], "commit")
        self.assertEqual(report["hermes"]["commit"], PIN)
        self.assertEqual(report["hermes"]["summary"], "installed commit matches the pin")

    def test_different_commit_differs(self):
        other = "0123456789abcdef0123456789abcdef01234567"
        with tempfile.TemporaryDirectory() as tmp:
            env = self._stub(Path(tmp), f"echo upstream {other}\nexit 0\n")
            report = load_report(EXAMPLE, pin_path=HARNESS / "pin" / "hermes.yaml", environ=env)
        self.assertEqual(report["hermes"]["match"], "differs")
        self.assertEqual(report["hermes"]["summary"], "installed Hermes does not match the pin")

    def test_success_without_a_commit_is_unverified(self):
        with tempfile.TemporaryDirectory() as tmp:
            env = self._stub(Path(tmp), "echo Hermes Agent v0\nexit 0\n")
            report = load_report(EXAMPLE, pin_path=HARNESS / "pin" / "hermes.yaml", environ=env)
        self.assertEqual(report["hermes"]["match"], "unverified")
        self.assertTrue(report["hermes"]["command_ok"])
        self.assertNotIn("matches the pin", report["hermes"]["summary"])

    def test_missing_binary_is_unavailable(self):
        with tempfile.TemporaryDirectory() as tmp:
            report = load_report(EXAMPLE, pin_path=HARNESS / "pin" / "hermes.yaml", environ=_empty_env(Path(tmp)))
        self.assertFalse(report["hermes"]["present"])
        self.assertEqual(report["hermes"]["summary"], "not on PATH")
        self.assertFalse(report["hermes"]["command_ok"])


class SafetyTests(unittest.TestCase):
    def test_defaults_are_ask_first_and_yolo_is_refused(self):
        defaults = enforce(None)
        self.assertFalse(defaults["yolo"])
        self.assertEqual(defaults["consequential"], "ask")
        self.assertTrue(defaults["vault_blind"])
        self.assertIn("external_message", defaults["consequential_actions"])
        self.assertIn("purchase", defaults["consequential_actions"])
        self.assertIn("destructive", defaults["consequential_actions"])
        with self.assertRaises(ValueError):
            enforce({"yolo": True})
        with self.assertRaises(ValueError):
            enforce({"consequential": "auto"})

    def test_browsing_zone_denies_outside_origins(self):
        origins = ["https://github.com"]
        self.assertTrue(navigation_allowed("https://github.com/intelio/alans-way", origins))
        self.assertFalse(navigation_allowed("https://example.com/", origins))
        self.assertFalse(navigation_allowed("http://github.com/", origins))
        self.assertFalse(navigation_allowed("https://user:pw@github.com/", origins))
        self.assertTrue(navigation_allowed("https://example.com/", []))
        self.assertEqual(classify_url("https://checkout.stripe.com/pay"), "purchase")
        self.assertEqual(classify_url("https://shop.example/checkout"), "purchase")
        self.assertEqual(classify_url("https://github.com/login"), None)
        self.assertIsNone(classify_url("https://github.com/NousResearch/hermes-agent"))

    def test_redact_strips_credential_shapes(self):
        self.assertNotIn(SENTINEL, redact(f"password={SENTINEL} bearer {SENTINEL}"))
        self.assertIn("[redacted]", redact(f"token={SENTINEL}"))


class FileBoundTests(unittest.TestCase):
    def test_reads_stay_inside_allowed_folders_and_skip_vault_files(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            profile = root / "profile"
            folder = profile / "files"
            folder.mkdir(parents=True)
            (folder / "notes.txt").write_text("hello", encoding="utf-8")
            (folder / ".env").write_text(SENTINEL, encoding="utf-8")
            outside = root / "outside.txt"
            outside.write_text(SENTINEL, encoding="utf-8")
            (profile / "profile.yaml").write_text(
                "name: Example\npanels: []\nskills: []\nallowed_folders:\n  - files\n", encoding="utf-8")
            report = load_report(profile, pin_path=HARNESS / "pin" / "hermes.yaml", environ=_empty_env(root))
            folders = bind_folders(profile, report["profile"]["allowed_folders"])
            self.assertEqual(read_text("notes.txt", folders, folders[0]), "hello")
            with self.assertRaises(FileBound):
                read_text("../outside.txt", folders, folders[0])
            with self.assertRaises(FileBound):
                read_text(".env", folders, folders[0])
            self.assertNotIn(SENTINEL, json.dumps(report))


if __name__ == "__main__":
    unittest.main()
