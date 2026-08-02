#!/usr/bin/env python3
"""Serve repo root and run Quicksilver Chrome harness via headless Chrome."""
from __future__ import annotations

import json
import os
import signal
import subprocess
import sys
import tempfile
import time
import urllib.request
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from pathlib import Path
from threading import Thread

ROOT = Path(__file__).resolve().parents[2]
PORT = int(os.environ.get('QS_TEST_PORT', '8765'))
CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
HARNESS = f'http://127.0.0.1:{PORT}/test/quicksilver-chrome/index.html'


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def log_message(self, fmt, *args):
        pass


def main() -> int:
    if not Path(CHROME).exists():
        print('FAIL: Google Chrome not found at', CHROME)
        return 2

    server = ThreadingHTTPServer(('127.0.0.1', PORT), Handler)
    thread = Thread(target=server.serve_forever, daemon=True)
    thread.start()

    # Wait for server
    for _ in range(50):
        try:
            urllib.request.urlopen(HARNESS, timeout=0.2)
            break
        except Exception:
            time.sleep(0.05)
    else:
        print('FAIL: harness server did not start')
        return 2

    profile = tempfile.mkdtemp(prefix='qs-chrome-')
    dump_path = Path(profile) / 'dom.html'
    cmd = [
        CHROME,
        '--headless=new',
        '--disable-gpu',
        '--no-first-run',
        '--no-default-browser-check',
        f'--user-data-dir={profile}',
        '--virtual-time-budget=15000',
        f'--dump-dom={dump_path}',
        HARNESS,
    ]
    # Newer Chrome uses --dump-dom writing to stdout; support both.
    proc = subprocess.run(cmd, capture_output=True, text=True, timeout=60)
    html = proc.stdout or ''
    if dump_path.exists() and dump_path.stat().st_size > 0:
        html = dump_path.read_text(errors='replace')

    server.shutdown()

    # Parse results from title / pre#results
    title = ''
    pre = ''
    if '<title>' in html:
        title = html.split('<title>', 1)[1].split('</title>', 1)[0]
    if 'id="results"' in html:
        chunk = html.split('id="results"', 1)[1]
        # class may be present
        chunk = chunk.split('>', 1)[1]
        pre = chunk.split('</pre>', 1)[0]
        pre = pre.replace('&amp;', '&').replace('&lt;', '<').replace('&gt;', '>')

    print('Chrome exit:', proc.returncode)
    print('Title:', title)
    print('--- results ---')
    print(pre.strip() or '(empty — check stderr)')
    if proc.stderr:
        err = proc.stderr.strip().splitlines()[-20:]
        print('--- chrome stderr (tail) ---')
        print('\n'.join(err))

    ok = title.startswith('PASS') or ('ALL PASSED' in pre)
    return 0 if ok else 1


if __name__ == '__main__':
    sys.exit(main())
