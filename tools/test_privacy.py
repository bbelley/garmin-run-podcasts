"""Exercise the public-repository privacy guard with synthetic data."""

import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import unittest


SCRIPT = Path(__file__).with_name("check_privacy.py").resolve()
spec = importlib.util.spec_from_file_location("privacy", SCRIPT)
privacy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(privacy)


class ContentChecks(unittest.TestCase):
    def test_credentials_and_private_urls_are_reported_without_echoing_values(self):
        examples = [
            "gh" + "p_" + "A" * 35,
            "eyJ" + "A" * 18 + "." + "B" * 30 + "." + "C" * 30,
            "https://audio.example.com/a?" + "token=" + "fixture-value",
            "pass" + "word = " + repr("long-fixture-password"),
        ]
        for text in examples:
            with self.subTest(kind=len(text)):
                self.assertTrue(privacy.scan_text(text))

    def test_private_account_ids_emails_and_known_values_are_detected(self):
        self.assertIn("personal email", privacy.scan_text("reader@" + "private.invalid"))
        account_id = "12345678-" + "1234-1234-1234-123456789abc"
        self.assertIn("account or episode UUID", privacy.scan_text(account_id))
        self.assertIn("known local private value", privacy.scan_text("local fixture marker", ["fixture marker"]))

    def test_documentation_guids_and_synthetic_examples_are_allowed(self):
        self.assertEqual(privacy.scan_text("https://www8.garmin.com/manuals/webhelp/GUID-676967A0-1B23-4384-9BC9-76F3D643F1C8/page"), [])
        self.assertEqual(privacy.scan_text("00000000-0000-0000-0000-000000000001 reader@example.com"), [])

    def test_known_cloudflare_credentials_and_account_config_are_included(self):
        with tempfile.TemporaryDirectory(prefix="pacejams-private-values-") as directory:
            root = Path(directory)
            config = root / ".spike-tools/cloudflare"
            config.mkdir(parents=True)
            secret = "fixture-watch-" * 4
            account = "fixture-account-value"
            (config / "secrets.json").write_text(json.dumps({"PACEJAMS_WATCH_TOKEN": secret}))
            (config / "current.json").write_text(json.dumps({"account_id": account}))
            values = privacy.private_values(root)
            self.assertIn(secret, values)
            self.assertIn(account, values)
            self.assertIn("known local private value", privacy.scan_text(secret, values))

    def test_malformed_url_is_reported_without_crashing_the_review(self):
        malformed = "https" + "://[invalid"
        self.assertIn("malformed URL", privacy.scan_text(malformed))


class GitChecks(unittest.TestCase):
    def test_staged_blob_is_checked_even_when_working_copy_is_cleaned(self):
        with tempfile.TemporaryDirectory(prefix="pacejams-privacy-") as directory:
            root = Path(directory)
            def git(*args):
                return subprocess.run(("git", *args), cwd=root, check=True, capture_output=True)
            git("init")
            git("config", "user.name", "Fixture")
            git("config", "user.email", "fixture@users.noreply.github.com")
            source = root / "app.py"
            source.write_text("value = " + repr("gh" + "p_" + "A" * 35), encoding="utf-8")
            git("add", "app.py")
            source.write_text("value = 'safe'", encoding="utf-8")
            result = subprocess.run(("python", str(SCRIPT), "--staged"), cwd=root, capture_output=True, text=True)
            self.assertEqual(result.returncode, 1)
            self.assertIn("access token", result.stdout)
            self.assertNotIn("A" * 35, result.stdout)
            git("add", "app.py")
            result = subprocess.run(("python", str(SCRIPT), "--staged"), cwd=root, capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_outgoing_history_includes_a_secret_deleted_by_a_later_commit(self):
        with tempfile.TemporaryDirectory(prefix="pacejams-privacy-") as directory:
            root = Path(directory)
            def git(*args):
                return subprocess.run(("git", *args), cwd=root, check=True, capture_output=True)
            git("init")
            git("config", "user.name", "Fixture")
            git("config", "user.email", "fixture@users.noreply.github.com")
            source = root / "app.py"
            source.write_text("value = 'safe'", encoding="utf-8")
            git("add", "app.py")
            git("commit", "-m", "Fixture base")
            base = git("rev-parse", "HEAD").stdout.decode().strip()
            source.write_text("value = " + repr("gh" + "p_" + "B" * 35), encoding="utf-8")
            git("add", "app.py")
            git("commit", "-m", "Fixture secret")
            source.write_text("value = 'safe again'", encoding="utf-8")
            git("add", "app.py")
            git("commit", "-m", "Fixture cleanup")
            result = subprocess.run(("python", str(SCRIPT), "--outgoing", base), cwd=root, capture_output=True, text=True)
            self.assertEqual(result.returncode, 1)
            self.assertIn("access token", result.stdout)
            self.assertNotIn("B" * 35, result.stdout)


if __name__ == "__main__":
    unittest.main()
