"""Exercise the real history scanner against synthetic merge commits."""
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


CHECKS = Path(__file__).with_name("checks.py")


class SecretHistoryTests(unittest.TestCase):
    def scan_merge(self, add_secret):
        with tempfile.TemporaryDirectory(prefix="guardrails-merge-") as directory:
            root = Path(directory)

            def git(*args):
                return subprocess.run(
                    ["git", *args], cwd=root, check=True,
                    capture_output=True, text=True,
                ).stdout.strip()

            git("init", "-b", "main")
            git("config", "user.email", "guardrails-test@example.com")
            git("config", "user.name", "Guardrails Test")
            git("config", "commit.gpgsign", "false")
            git("config", "core.hooksPath", "/dev/null")
            (root / "base.txt").write_text("baseline\n")
            git("add", ".")
            git("commit", "-m", "baseline")
            base = git("rev-parse", "HEAD")
            git("checkout", "-b", "feature")
            (root / "feature.txt").write_text("feature\n")
            git("add", ".")
            git("commit", "-m", "feature")
            git("checkout", "main")
            (root / "main.txt").write_text("main\n")
            git("add", ".")
            git("commit", "-m", "main")
            git("merge", "--no-commit", "--no-ff", "feature")
            # A deliberately fake token assembled only inside the temporary repo.
            token = "ghp_" + "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8"
            if add_secret:
                (root / "merge-only.txt").write_text("GITHUB_TOKEN=" + token + "\n")
                git("add", ".")
            git("commit", "-m", "merge")
            env = dict(os.environ, BASE_SHA=base, HEAD_SHA=git("rev-parse", "HEAD"))
            for key in ("GITLEAKS_CONFIG", "GITLEAKS_CONFIG_TOML"):
                env.pop(key, None)
            result = subprocess.run(
                [sys.executable, str(CHECKS), "secrets"], cwd=root,
                env=env, capture_output=True, text=True,
            )
            self.assertNotIn(token, result.stdout + result.stderr)
            return result

    def test_secret_introduced_only_by_merge_is_blocked(self):
        result = self.scan_merge(add_secret=True)
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
        self.assertIn("leaks found", result.stderr)

    def test_clean_merge_passes(self):
        result = self.scan_merge(add_secret=False)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("no leaks found", result.stderr)


if __name__ == "__main__":
    unittest.main()
