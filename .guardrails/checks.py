#!/usr/bin/env python3
"""Shared local/CI checks. Invoke from a plugin repository root."""
import json
import os
from pathlib import Path
import subprocess
import sys


def run(*args):
    subprocess.run(args, check=True)


def quality():
    npm_major = int(subprocess.check_output(["npm", "--version"], text=True).split(".")[0])
    if npm_major < 11:
        raise RuntimeError("Use Node 24 with npm 11: npm 10 runs prepare during pack --ignore-scripts.")
    package = json.loads(Path("package.json").read_text())
    commands = {"dsh-lark-bot": "ci:local", "dsh-codex-connect": "check",
                "dsh-mnemon": "verify"}
    script = commands[package["name"]]
    if script not in package.get("scripts", {}):
        raise RuntimeError(f"Missing upstream quality command: {script}")
    run("pnpm", "run", script)


def scan_history(revision):
    run("gitleaks", "git", "--redact", "--no-banner", "--log-opts=-m " + revision, ".")


def pre_push():
    head = subprocess.check_output(["git", "rev-parse", "HEAD"], text=True).strip()
    if subprocess.check_output(["git", "status", "--porcelain"], text=True).strip():
        raise RuntimeError("Commit or clean up your own working changes before pre-push validation.")
    baseline = Path(".guardrails/baseline-ref").read_text().strip()
    lines = sys.stdin.read().splitlines()
    if not lines:
        raise RuntimeError("No push references supplied; refusing an unchecked push.")
    for line in lines:
        local_ref, local_sha, remote_ref, remote_sha = line.split()
        if remote_ref in {"refs/heads/main", "refs/heads/master", "refs/heads/production"}:
            raise RuntimeError("Push a feature branch and use a PR for protected branches.")
        if not remote_ref.startswith("refs/heads/") or local_sha != head:
            raise RuntimeError("This hook checks only a feature branch pointing at the current HEAD.")
        run("git", "merge-base", "--is-ancestor", baseline, head)
        if remote_sha != "0" * 40:
            run("git", "merge-base", "--is-ancestor", remote_sha, head)
        scan_history(baseline + ".." + head)
    run("pre-commit", "run", "--from-ref", baseline, "--to-ref", head)
    quality()
    if subprocess.check_output(["git", "rev-parse", "HEAD"], text=True).strip() != head:
        raise RuntimeError("HEAD changed during validation; rerun the push on the intended revision.")
    if subprocess.check_output(["git", "status", "--porcelain"], text=True).strip():
        raise RuntimeError("Validation changed the working tree; review those changes before pushing.")


if __name__ == "__main__":
    try:
        mode = sys.argv[1]
        if mode == "pre-push":
            pre_push()
        elif mode == "quality":
            quality()
        elif mode == "secrets":
            base, head = os.environ["BASE_SHA"], os.environ["HEAD_SHA"]
            if not all(len(s) == 40 and all(c in "0123456789abcdef" for c in s) for s in (base, head)):
                raise RuntimeError("Expected full commit SHAs for secret scan.")
            scan_history(base + ".." + head)
        else:
            raise RuntimeError("Unknown check mode")
    except (RuntimeError, KeyError, ValueError, subprocess.CalledProcessError) as exc:
        print(f"Guardrail check failed: {exc}", file=sys.stderr)
        sys.exit(1)
