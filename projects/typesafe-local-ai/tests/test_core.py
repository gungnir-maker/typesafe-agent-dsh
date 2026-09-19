import tempfile
import unittest
from pathlib import Path

from src.core import Completion, Review, verify


class CoreTests(unittest.TestCase):
    def test_rejects_file_outside_policy(self):
        completion = Completion("1", "task", "done", "done", ["../secret.txt"])
        report = verify(completion, Path("."))
        self.assertFalse(report.ready)
        self.assertIn("FILE_OUTSIDE_ALLOWED_PREFIX", report.issues)

    def test_accepts_valid_completion_and_check(self):
        completion = Completion("1", "task", "done", "done", ["src/core.py"])
        with tempfile.TemporaryDirectory() as directory:
            report = verify(completion, Path(directory), verification_commands=("python3 -c 'exit(0)'",))
        self.assertTrue(report.ready)

    def test_local_rejection_blocks_ready(self):
        completion = Completion("1", "task", "done", "done", ["src/core.py"])
        report = verify(completion, Path("."), review=Review(False, 0.3))
        self.assertFalse(report.ready)
        self.assertIn("LOCAL_REVIEW_REJECTED", report.issues)


if __name__ == "__main__":
    unittest.main()

