#!/usr/bin/env python3
"""Canonical PDF OCR entry: session-bound bridge or the same local worker."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import sys
import urllib.request
import urllib.error
from urllib.parse import urlparse


def parse_pages(value, total):
    if not value:
        return None
    pages = set()
    for part in value.split(','):
        if '-' in part:
            first, last = part.split('-', 1)
            start, end = int(first or 1), int(last or total)
            if start < 1 or end > total or start > end:
                raise ValueError('Invalid page range')
            pages.update(range(start, end + 1))
        else:
            pages.add(int(part))
    if not pages or len(pages) > 5000 or any(p < 1 or p > total for p in pages):
        raise ValueError('Invalid page selection')
    return sorted(pages)


def discovery_files():
    roots = []
    if os.environ.get('DSH_LARK_HOME'):
        roots.append(Path(os.environ['DSH_LARK_HOME']))
    if os.environ.get('DSH_HOME'):
        roots.append(Path(os.environ['DSH_HOME']) / 'lark')
    roots.append(Path.home() / '.dsh-lark')
    return sorted(set(path for root in roots for path in root.glob('profiles/*/ocr-bridge.json')))


def read_config(path):
    try:
        value = json.loads(path.read_text())
        return value if isinstance(value, dict) else {}
    except (OSError, ValueError):
        return {}


def ensure_pdf_runtime():
    try:
        import fitz
        return fitz
    except ModuleNotFoundError:
        # The shell may use system Python while the bot uses a dedicated venv.
        candidates = [os.environ.get('DSH_LARK_OCR_PYTHON')]
        candidates += [read_config(path).get('python') for path in discovery_files()]
        for python in dict.fromkeys(candidates):
            if not isinstance(python, str) or not python or os.environ.get('DSH_OCR_REEXEC'):
                continue
            try:
                check = subprocess.run([python, '-c', 'import fitz'], capture_output=True, timeout=10)
                if check.returncode == 0:
                    os.execvpe(python, [python, str(Path(__file__).resolve()), *sys.argv[1:]],
                               {**os.environ, 'DSH_OCR_REEXEC': '1'})
            except (OSError, subprocess.TimeoutExpired):
                continue
        raise RuntimeError('PyMuPDF is missing; configure DSH_LARK_OCR_PYTHON to the OCR venv interpreter')


def bridge_request(source, pages):
    session = os.environ.get('DSH_SESSION_ID')
    if not session:
        return None
    unbound = False
    for path in discovery_files():
        config = read_config(path)
        if not isinstance(config.get('endpoint'), str) or not isinstance(config.get('token'), str):
            continue
        endpoint = urlparse(config['endpoint'])
        if endpoint.scheme != 'http' or endpoint.hostname != '127.0.0.1' or endpoint.path != '/ocr':
            continue
        payload = {'token': config['token'], 'sessionId': session, 'path': str(source)}
        if pages:
            payload['pages'] = pages
        request = urllib.request.Request(config['endpoint'], data=json.dumps(payload).encode(),
                                         headers={'Content-Type': 'application/json'}, method='POST')
        try:
            # Whitespace heartbeats keep this read alive without document text.
            with urllib.request.urlopen(request, timeout=90) as response:
                result = json.load(response)
        except urllib.error.HTTPError as error:
            if error.code in (401, 404):
                continue
            raise RuntimeError('OCR bridge rejected the request') from error
        except urllib.error.URLError as error:
            if isinstance(error.reason, ConnectionRefusedError):
                continue
            raise RuntimeError('OCR bridge connection failed; retry the same command to resume') from error
        if result.get('ok'):
            return result
        if result.get('error') == 'No active Lark binding for this session':
            unbound = True
            continue
        raise RuntimeError(result.get('error', 'OCR failed'))
    if unbound:
        # A Web-only session has no Lark destination; use the same local worker.
        return None
    raise RuntimeError('OCR bridge is unavailable; start the bot with PDF OCR enabled, or use --local without a card')


def local_run(source, pages):
    worker = Path(__file__).resolve().parents[3] / 'src/media/pdf-ocr-worker.py'
    if not worker.is_file():
        raise RuntimeError('Packaged OCR worker is missing')
    suffix = hashlib.sha256(json.dumps(pages, separators=(',', ':')).encode()).hexdigest()[:16] if pages else ''
    output = Path(str(source) + '.ocr' + ('-' + suffix if suffix else ''))
    command = [sys.executable, str(worker), '--source', str(source), '--output', str(output)]
    if pages:
        command += ['--pages', ','.join(map(str, pages))]
    child = subprocess.Popen(command, stdout=subprocess.PIPE, text=True, start_new_session=os.name != 'nt',
                             env={**os.environ, 'OMP_NUM_THREADS': '2', 'OPENBLAS_NUM_THREADS': '2'})
    complete = None
    try:
        for line in child.stdout:
            event = json.loads(line)
            print(line.strip(), file=sys.stderr, flush=True)
            if event.get('type') == 'complete':
                complete = event
        if child.wait() or complete is None:
            raise RuntimeError('OCR did not finish; rerun the same command to resume')
    finally:
        if child.poll() is None:
            if os.name != 'nt':
                os.killpg(child.pid, signal.SIGTERM)
            else:
                subprocess.run(['taskkill', '/PID', str(child.pid), '/T', '/F'], capture_output=True)
            child.wait(timeout=10)
    return {'textPath': str(output / 'document.md'), 'reportPath': str(output / 'report.json'),
            'reviewPages': complete['reviewPages'], 'totalPages': complete['totalPages']}


def main():
    parser = argparse.ArgumentParser(description='Resumable PDF OCR with automatic Lark progress')
    parser.add_argument('pdf')
    parser.add_argument('--pages')
    parser.add_argument('--output', '-o')
    parser.add_argument('--json', action='store_true')
    parser.add_argument('--local', action='store_true', help='Run locally without a Lark card')
    args = parser.parse_args()
    source = Path(args.pdf).resolve(strict=True)
    if args.output and Path(args.output).resolve() == source:
        raise ValueError('Output must not overwrite the original PDF')
    fitz = ensure_pdf_runtime()
    with fitz.open(source) as doc:
        if doc.needs_pass or not 1 <= len(doc) <= 5000:
            raise ValueError('PDF must be unencrypted and contain 1–5000 pages')
        pages = parse_pages(args.pages, len(doc))
    result = None if args.local else bridge_request(source, pages)
    result = result or local_run(source, pages)
    text = Path(result['textPath']).read_text()
    if args.output:
        target = Path(args.output)
        target.parent.mkdir(parents=True, exist_ok=True)
        # Keep a completed previous output until the new extraction succeeds.
        import tempfile
        with tempfile.NamedTemporaryFile(dir=target.parent, delete=False) as temp:
            temporary = Path(temp.name)
        try:
            shutil.copyfile(result['textPath'], temporary)
            os.replace(temporary, target)
        finally:
            temporary.unlink(missing_ok=True)
    if args.json:
        print(json.dumps({**result, 'engine': 'resumable-ocr', 'text': text, 'markdown': text}, ensure_ascii=False))
    elif not args.output:
        print(text)
    print(json.dumps({'output': args.output or result['textPath'], 'report': result['reportPath'],
                      'reviewPages': result['reviewPages']}, ensure_ascii=False), file=sys.stderr)


if __name__ == '__main__':
    try:
        main()
    except KeyboardInterrupt:
        sys.exit(130)
    except Exception as error:
        # Never print bridge tokens, request bodies, or private dependency tracebacks.
        detail = str(error)[:500] if isinstance(error, RuntimeError) else 'check the PDF, page range and local OCR environment, then retry the same command'
        print(f'OCR failed ({type(error).__name__}): {detail}', file=sys.stderr)
        sys.exit(1)
