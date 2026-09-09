#!/usr/bin/env python3
"""Local, resumable PDF OCR. JSONL stdout contains progress only, never document text."""
import argparse
import hashlib
import importlib.metadata
import json
import math
import multiprocessing
import os
from pathlib import Path
import queue
import signal
import sys
import time

SCHEMA = 1
POLICY = {"base_dpi": 150, "retry_dpi": 300, "jpeg_quality": 80,
          "line_threshold": 0.90, "max_regions": 8, "batch_pages": 5,
          "max_page_chars": 200000}


def emit(event):
    print(json.dumps(event, ensure_ascii=False), flush=True)


def atomic_json(path, value):
    path = Path(path)
    temp = path.with_suffix(path.suffix + '.tmp')
    with temp.open('w', encoding='utf-8') as handle:
        json.dump(value, handle, ensure_ascii=False)
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(temp, path)


def sha_file(path):
    digest = hashlib.sha256()
    with open(path, 'rb') as handle:
        for chunk in iter(lambda: handle.read(8 * 1024 * 1024), b''):
            digest.update(chunk)
    return digest.hexdigest()


def page_ranges(pages):
    groups = []
    for number in sorted(set(pages)):
        if groups and number == groups[-1][1] + 1:
            groups[-1][1] = number
        else:
            groups.append([number, number])
    return ', '.join(str(a) if a == b else f'{a}-{b}' for a, b in groups)


def quality(lines):
    weights = [max(1, len(line['text'].strip())) for line in lines]
    return sum(line['confidence'] * weight for line, weight in zip(lines, weights)) / max(1, sum(weights))


def unclear(lines):
    return [line for line in lines if line['confidence'] < POLICY['line_threshold']]


def normalize_lines(result, width, height):
    lines = []
    for box, text, confidence in (result or [])[:4000]:
        if not text.strip():
            continue
        xs, ys = [float(p[0]) for p in box], [float(p[1]) for p in box]
        lines.append({'text': text, 'confidence': float(confidence),
                      'box': [max(0, min(xs) / width), max(0, min(ys) / height),
                              min(1, max(xs) / width), min(1, max(ys) / height)]})
    return lines


def retry_regions(lines):
    regions = []
    for line in unclear(lines):
        x0, y0, x1, y1 = line['box']
        box = [max(0, x0 - .015), max(0, y0 - .008), min(1, x1 + .015), min(1, y1 + .008)]
        for region in regions:
            if box[1] <= region[3] and box[3] >= region[1]:
                region[:] = [min(region[0], box[0]), min(region[1], box[1]), max(region[2], box[2]), max(region[3], box[3])]
                break
        else:
            regions.append(box)
    if len(regions) > POLICY['max_regions']:
        return [[min(r[0] for r in regions), min(r[1] for r in regions), max(r[2] for r in regions), max(r[3] for r in regions)]]
    return regions


def choose_retry(original, candidate):
    """Never replace a whole region with an implausibly short, confident fragment."""
    old_chars = sum(len(x['text'].strip()) for x in original)
    new_chars = sum(len(x['text'].strip()) for x in candidate)
    if not candidate or new_chars < old_chars * .8:
        return original, False
    if not original:
        return candidate, True
    if quality(candidate) <= quality(original) or len(unclear(candidate)) > len(unclear(original)):
        return original, False
    return candidate, True


def render(page, clip, dpi):
    import fitz
    # Crop coordinates use the rotated page rect, matching the baseline raster.
    area = max(1, clip.width * clip.height)
    dpi = min(dpi, 72 * math.sqrt(12_000_000 / area))
    pix = page.get_pixmap(matrix=fitz.Matrix(dpi / 72, dpi / 72), clip=clip, colorspace=fitz.csGRAY, alpha=False)
    return pix


def can_use_native(text, images, page_area):
    # A searchable header does not prove a raster body has been read.
    image_area = sum(max(0, b[2]-b[0]) * max(0, b[3]-b[1]) for b in images)
    return (len(text) >= 50 and text.count("\ufffd") < max(1, len(text) * .01)
            and image_area < max(1, page_area) * .1)


def recognize_page(doc, page_number, engine, notify):
    import fitz
    from PIL import Image, ImageStat
    page = doc[page_number - 1]
    native = page.get_text().strip()
    if can_use_native(native, [item['bbox'] for item in page.get_image_info()], page.rect.get_area()):
        return {'status': 'native', 'text': native[:POLICY['max_page_chars']], 'lines': [],
                'retries': 0, 'unresolved': [], 'truncated': len(native) > POLICY['max_page_chars']}
    pix = render(page, page.rect, POLICY['base_dpi'])
    gray = Image.frombytes('L', (pix.width, pix.height), pix.samples)
    # Only nearly white pages can be accepted as blank without OCR.
    histogram = gray.histogram()
    ink_fraction = sum(histogram[:220]) / max(1, pix.width * pix.height)
    if ink_fraction < .001 and ImageStat.Stat(gray).stddev[0] < 5:
        return {'status': 'blank', 'text': '', 'lines': [], 'retries': 0, 'unresolved': []}
    compressed = pix.tobytes('jpeg', jpg_quality=POLICY['jpeg_quality'])
    result, _ = engine(compressed)
    lines = normalize_lines(result, pix.width, pix.height)
    del pix, gray, compressed
    regions = retry_regions(lines) if lines else [[0, 0, 1, 1]]
    retries = 0
    for region in regions:
        retries += 1
        notify({'type': 'retry', 'page': page_number, 'region': retries, 'regions': len(regions), 'dpi': POLICY['retry_dpi']})
        x0, y0, x1, y1 = region
        rect = page.rect
        clip = fitz.Rect(rect.x0 + x0 * rect.width, rect.y0 + y0 * rect.height,
                         rect.x0 + x1 * rect.width, rect.y0 + y1 * rect.height)
        pix = render(page, clip, POLICY['retry_dpi'])
        result, _ = engine(pix.tobytes('png'))
        candidate = normalize_lines(result, pix.width, pix.height)
        for line in candidate:
            a, b, c, d = line['box']
            line['box'] = [x0 + a * (x1-x0), y0 + b * (y1-y0), x0 + c * (x1-x0), y0 + d * (y1-y0)]
        def inside(line):
            a, b, c, d = line['box']
            return x0 <= (a+c)/2 <= x1 and y0 <= (b+d)/2 <= y1
        original = [line for line in lines if inside(line)]
        chosen, accepted = choose_retry(original, candidate)
        if accepted:
            lines = [line for line in lines if not inside(line)] + chosen
        del pix
    lines.sort(key=lambda line: (round(line['box'][1], 2), line['box'][0]))
    text = '\n'.join(line['text'] for line in lines)
    unresolved = [line['box'] for line in unclear(lines)]
    if not lines:
        unresolved = [[0, 0, 1, 1]]
    return {'status': 'needs_review' if unresolved else 'ocr', 'text': text[:POLICY['max_page_chars']],
            'lines': lines, 'retries': retries, 'unresolved': unresolved,
            'truncated': len(text) > POLICY['max_page_chars'], 'quality': quality(lines)}


def worker_main(source, incoming, outgoing):
    import fitz
    from rapidocr_onnxruntime import RapidOCR
    engine = None
    doc = fitz.open(source)
    def recognize(data):
        nonlocal engine
        if engine is None:
            engine = RapidOCR(intra_op_num_threads=2, inter_op_num_threads=1)
        return engine(data)
    while True:
        number = incoming.get()
        if number is None:
            break
        try:
            result = recognize_page(doc, number, recognize, outgoing.put)
            outgoing.put({'type': 'result', 'page': number, 'result': result})
        except Exception as error:
            outgoing.put({'type': 'result', 'page': number, 'result': {'status': 'error', 'text': '',
                          'reason': type(error).__name__, 'retries': 0, 'unresolved': [[0, 0, 1, 1]]}})
        fitz.TOOLS.store_shrink(100)
    doc.close()


class PageRunner:
    def __init__(self, source, timeout):
        self.source, self.timeout = source, timeout
        self.child = None
        self.count = 0

    def close(self):
        if self.child is not None:
            self.child.terminate()
            self.child.join(3)
            if self.child.is_alive():
                self.child.kill()
                self.child.join()
            self.incoming.close()
            self.outgoing.close()
            self.child = None

    def process(self, number, notify):
        if self.child is None or self.count >= POLICY['batch_pages']:
            self.close()
            context = multiprocessing.get_context('spawn')
            self.incoming, self.outgoing = context.Queue(), context.Queue()
            self.child = context.Process(target=worker_main, args=(self.source, self.incoming, self.outgoing))
            self.child.start()
            self.count = 0
        self.incoming.put(number)
        deadline = time.monotonic() + self.timeout
        while time.monotonic() < deadline:
            try:
                event = self.outgoing.get(timeout=min(.5, max(.01, deadline-time.monotonic())))
            except queue.Empty:
                if not self.child.is_alive():
                    self.close()
                    raise RuntimeError('OCR worker exited')
                continue
            if event['type'] == 'result':
                self.count += 1
                return event['result']
            notify(event)
        self.close()
        raise TimeoutError('OCR page exceeded deadline')


def record_path(output, page):
    return output / f'page-{page:05d}.json'


def cached_page(output, page, fingerprint):
    path = record_path(output, page)
    try:
        if path.stat().st_size > 4 * 1024 * 1024:
            return None
        value = json.loads(path.read_text())
        digest = value.pop('digest')
        expected = hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True).encode()).hexdigest()
        if digest != expected or value['fingerprint'] != fingerprint or value['page'] != page:
            return None
        if value['status'] not in ('native', 'blank', 'ocr', 'needs_review') or not isinstance(value['text'], str):
            return None
        return value
    except (OSError, ValueError, KeyError, TypeError):
        return None


def save_page(output, page, fingerprint, result):
    value = {**result, 'page': page, 'fingerprint': fingerprint}
    value['digest'] = hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True).encode()).hexdigest()
    atomic_json(record_path(output, page), value)
    return value


def process_pages(output, pages, fingerprint, runner, notify):
    results = {}
    for number in pages:
        cached = cached_page(output, number, fingerprint)
        if cached:
            results[number] = cached
    notify({'type': 'started', 'total': len(pages), 'done': len(results), 'cached': len(results)})
    try:
        for number in pages:
            if number in results:
                continue
            notify({'type': 'page', 'page': number, 'done': len(results), 'total': len(pages)})
            try:
                result = runner.process(number, notify)
            except Exception as error:
                result = {'status': 'error', 'text': '', 'reason': type(error).__name__, 'unresolved': [[0, 0, 1, 1]], 'retries': 0}
            results[number] = save_page(output, number, fingerprint, result)
            notify({'type': 'progress', 'page': number, 'done': len(results), 'total': len(pages),
                    'reviewPages': [p for p, r in results.items() if r['status'] in ('needs_review', 'error') or r.get('truncated')]})
    finally:
        runner.close()
    return results


def write_report(output, results, total_pages):
    review = sorted(p for p, result in results.items() if result['status'] in ('needs_review', 'error') or result.get('truncated'))
    report = {'schema': SCHEMA, 'totalPages': total_pages, 'processedPages': sorted(results),
              'reviewPages': review, 'reviewRanges': page_ranges(review),
              'errorPages': [p for p, r in results.items() if r['status'] == 'error'],
              'retryPages': [p for p, r in results.items() if r.get('retries', 0)]}
    atomic_json(output / 'report.json', report)
    text_path = output / 'document.md'
    temp = output / 'document.md.tmp'
    with temp.open('w', encoding='utf-8') as handle:
        handle.write('# PDF 提取文本\n\n')
        handle.write(f'原文件共 {total_pages} 页；本次覆盖 {page_ranges(results)}。\n\n')
        if review:
            handle.write(f'⚠️ 第 {page_ranges(review)} 页仍有识别不清或未成功处理的区域，需要复核；不要把这些页视为已准确读取。\n\n')
        for number, result in sorted(results.items()):
            handle.write(f'## 原文件第 {number} 页 [{result["status"]}]\n\n{result["text"]}\n\n')
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(temp, text_path)
    return report


def main():
    os.umask(0o077)
    parser = argparse.ArgumentParser()
    parser.add_argument('--source', required=True)
    parser.add_argument('--output', required=True)
    parser.add_argument('--pages', help='Comma-separated 1-based page numbers, for explicit partial processing')
    parser.add_argument('--page-timeout', type=int, default=120)
    args = parser.parse_args()
    output = Path(args.output)
    output.mkdir(parents=True, exist_ok=True, mode=0o700)
    with (output / '.lock').open('a+b') as lock:
        if os.name == 'nt':
            import msvcrt
            lock.write(b'0'); lock.flush(); lock.seek(0)
            msvcrt.locking(lock.fileno(), msvcrt.LK_NBLCK, 1)
        else:
            import fcntl
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        emit({'type': 'preparing'})
        import fitz
        versions = {name: importlib.metadata.version(name) for name in ('PyMuPDF', 'rapidocr-onnxruntime', 'onnxruntime')}
        doc = fitz.open(args.source)
        if doc.needs_pass:
            raise ValueError('Encrypted PDF requires a password')
        total = len(doc)
        doc.close()
        if total < 1 or total > 5000:
            raise ValueError('PDF page count must be between 1 and 5000')
        pages = sorted(set(int(p) for p in args.pages.split(','))) if args.pages else list(range(1, total + 1))
        if not pages or any(p < 1 or p > total for p in pages):
            raise ValueError('Invalid page selection')
        metadata = {'schema': SCHEMA, 'sourceSha256': sha_file(args.source), 'workerSha256': sha_file(__file__),
                    'policy': POLICY, 'versions': versions, 'totalPages': total}
        fingerprint = hashlib.sha256(json.dumps(metadata, sort_keys=True).encode()).hexdigest()
        atomic_json(output / 'manifest.json', {**metadata, 'fingerprint': fingerprint})
        runner = PageRunner(args.source, args.page_timeout)
        results = process_pages(output, pages, fingerprint, runner, emit)
        report = write_report(output, results, total)
        emit({'type': 'complete', **report, 'output': str(output / 'document.md')})


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        emit({'type': 'fatal', 'reason': type(error).__name__})
        sys.exit(1)
