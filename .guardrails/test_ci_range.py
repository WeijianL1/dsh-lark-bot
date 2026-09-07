"""Execute the workflow's range-selection shell in isolated Git histories."""
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

WORKFLOW = Path(__file__).resolve().parents[1] / '.github/workflows/fork-guardrails.yml'


class CiRangeTests(unittest.TestCase):
    def test_ranges(self):
        workflow = WORKFLOW.read_text()
        self.assertIn('BASE_SHA: ${{ github.event.pull_request.base.sha }}', workflow)
        block = workflow.split('      - name: Scan new history and check changed files\n', 1)[1]
        script = block.split('        run: |\n', 1)[1].split('  quality:\n', 1)[0]
        script = '\n'.join(line[10:] for line in script.splitlines())
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            env = dict(os.environ, GIT_AUTHOR_NAME='Fixture', GIT_AUTHOR_EMAIL='fixture@example.test',
                       GIT_COMMITTER_NAME='Fixture', GIT_COMMITTER_EMAIL='fixture@example.test')
            def git(*args):
                return subprocess.check_output(['git', *args], cwd=root, env=env, text=True,
                                               stderr=subprocess.DEVNULL).strip()
            git('init', '-q')
            (root / 'file').write_text('base\n')
            git('add', 'file')
            git('commit', '-qm', 'base')
            base = git('rev-parse', 'HEAD')
            (root / 'file').write_text('feature\n')
            git('commit', '-qam', 'feature')
            head = git('rev-parse', 'HEAD')
            tree = git('rev-parse', base + '^{tree}')
            diverged = git('commit-tree', tree, '-p', base, '-m', 'target advanced')
            (root / '.guardrails').mkdir()
            (root / '.guardrails/baseline-ref').write_text(base)
            bins = root / 'bin'
            bins.mkdir()
            # Stand-ins validate that both consumers receive the selected Git range.
            for name, body in {
                'python3': 'git log "$BASE_SHA..$HEAD_SHA" --oneline >/dev/null\nprintf "%s" "$BASE_SHA" > selected-base\n',
                'pre-commit': 'git diff --name-only "$3" "$5" >/dev/null\n',
            }.items():
                p = bins / name
                p.write_text('#!/bin/sh\nset -eu\n' + body)
                p.chmod(0o755)
            env.update(PATH=str(bins) + ':' + env['PATH'], HEAD_SHA=head)
            # Force push: event.before is unavailable; baseline must be used.
            env['BASE_SHA'] = ''
            subprocess.run(['bash', '-e', '-c', script], cwd=root, env=env, check=True)
            self.assertEqual((root / 'selected-base').read_text(), base)
            # PR: target advanced independently, and need not be an ancestor.
            env['BASE_SHA'] = diverged
            subprocess.run(['bash', '-e', '-c', script], cwd=root, env=env, check=True)
            self.assertEqual((root / 'selected-base').read_text(), diverged)
            # A broken push baseline must fail closed.
            env['BASE_SHA'] = ''
            (root / '.guardrails/baseline-ref').write_text(diverged)
            result = subprocess.run(['bash', '-e', '-c', script], cwd=root, env=env)
            self.assertNotEqual(result.returncode, 0)


if __name__ == '__main__':
    unittest.main()
