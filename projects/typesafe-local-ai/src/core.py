from __future__ import annotations

import json
import subprocess
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable


@dataclass(frozen=True)
class Completion:
    task_id: str
    task: str
    status: str
    summary: str
    changed_files: list[str]
    tests_claimed: list[str] = field(default_factory=list)
    blockers: list[str] = field(default_factory=list)

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "Completion":
        required = ("taskId", "task", "status", "summary", "changedFiles")
        missing = [key for key in required if key not in data]
        if missing:
            raise ValueError(f"missing fields: {', '.join(missing)}")
        if data["status"] not in {"done", "blocked", "in_progress"}:
            raise ValueError("status must be done, blocked, or in_progress")
        if not isinstance(data["changedFiles"], list) or not all(
            isinstance(item, str) for item in data["changedFiles"]
        ):
            raise ValueError("changedFiles must be a list of strings")
        return cls(
            task_id=data["taskId"],
            task=data["task"],
            status=data["status"],
            summary=data["summary"],
            changed_files=data["changedFiles"],
            tests_claimed=data.get("testsClaimed", []),
            blockers=data.get("blockers", []),
        )


@dataclass(frozen=True)
class Check:
    name: str
    passed: bool
    detail: str


@dataclass(frozen=True)
class Review:
    accepted: bool
    score: float
    problems: list[dict[str, str]] = field(default_factory=list)
    suggested_fixes: list[str] = field(default_factory=list)
    source: str = "none"


@dataclass(frozen=True)
class VerificationReport:
    ready: bool
    checks: list[Check]
    review: Review | None
    issues: list[str]


def _path_is_allowed(path: str, allowed_prefixes: tuple[str, ...]) -> bool:
    candidate = Path(path)
    return not candidate.is_absolute() and ".." not in candidate.parts and any(
        candidate == Path(prefix) or Path(prefix) in candidate.parents
        for prefix in allowed_prefixes
    )


def run_verification(command: str, workspace: Path, runner: Callable[..., Any] = subprocess.run) -> Check:
    try:
        result = runner(
            command,
            cwd=workspace,
            shell=True,
            capture_output=True,
            text=True,
            timeout=120,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired) as error:
        return Check(command, False, str(error))
    output = (result.stdout + result.stderr).strip()
    return Check(command, result.returncode == 0, output[-1000:])


def verify(
    completion: Completion,
    workspace: Path,
    allowed_prefixes: tuple[str, ...] = ("src", "tests"),
    verification_commands: tuple[str, ...] = (),
    review: Review | None = None,
) -> VerificationReport:
    checks: list[Check] = []
    issues: list[str] = []

    invalid_files = [
        path for path in completion.changed_files
        if not _path_is_allowed(path, allowed_prefixes)
    ]
    checks.append(Check("file_policy", not invalid_files, "ok" if not invalid_files else ", ".join(invalid_files)))
    if invalid_files:
        issues.append("FILE_OUTSIDE_ALLOWED_PREFIX")

    for command in verification_commands:
        check = run_verification(command, workspace)
        checks.append(check)
        if not check.passed:
            issues.append(f"CHECK_FAILED:{command}")

    if completion.status != "done":
        issues.append("COMPLETION_NOT_DONE")
    if completion.status == "done" and not completion.summary.strip():
        issues.append("EMPTY_SUMMARY")

    if review is not None and not review.accepted:
        issues.append("LOCAL_REVIEW_REJECTED")

    deterministic_passed = all(check.passed for check in checks)
    ready = deterministic_passed and not issues
    return VerificationReport(ready, checks, review, issues)


def load_completion(path: Path) -> Completion:
    return Completion.from_dict(json.loads(path.read_text()))

