"""Shared HTTP server for the Quicksilver Chrome harnesses."""
from __future__ import annotations

import json
import time
from collections import Counter
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from threading import Lock, Thread
from urllib.parse import parse_qs, urlsplit


ROOT = Path(__file__).resolve().parents[2]


class HarnessHandler(SimpleHTTPRequestHandler):
    counts: Counter[str] = Counter()
    counts_lock = Lock()

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def log_message(self, fmt, *args):
        pass

    @classmethod
    def increment(cls, name: str) -> int:
        with cls.counts_lock:
            cls.counts[name] += 1
            return cls.counts[name]

    @classmethod
    def snapshot(cls) -> dict[str, int]:
        with cls.counts_lock:
            return dict(cls.counts)

    def send_bytes(self, body: bytes, content_type: str, **headers: str) -> None:
        self.send_response(200)
        self.send_header('Content-Type', content_type)
        self.send_header('Content-Length', str(len(body)))
        for key, value in headers.items():
            self.send_header(key.replace('_', '-'), value)
        self.end_headers()
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def do_GET(self):
        parsed = urlsplit(self.path)
        base = '/test/quicksilver-chrome/dynamic/'

        if parsed.path == base + 'count':
            query = parse_qs(parsed.query)
            name = query.get('name', [''])[0]
            counts = self.snapshot()
            payload = {'count': counts.get(name, 0), 'counts': counts}
            self.send_bytes(json.dumps(payload).encode(), 'application/json', Cache_Control='no-store')
            return

        if parsed.path == base + 'coalesce.js':
            request_number = self.increment('coalesce')
            time.sleep(0.25)
            body = f'window.__qsCoalesceRequest = {request_number};\n'.encode()
            self.send_bytes(body, 'application/javascript', Cache_Control='max-age=60')
            return

        if parsed.path == base + 'variant.js':
            self.increment('variant')
            time.sleep(0.25)
            variant = self.headers.get('X-QS-Variant', 'missing')
            body = f'window.__qsVariant = {json.dumps(variant)};\n'.encode()
            self.send_bytes(
                body,
                'application/javascript',
                Cache_Control='max-age=60',
                Vary='X-QS-Variant',
            )
            return

        if parsed.path == base + 'slow.js':
            self.increment('slow')
            time.sleep(1.25)
            self.send_bytes(
                b'window.__qsSlow = true;\n',
                'application/javascript',
                Cache_Control='max-age=60',
            )
            return

        if parsed.path == base + 'cache-mode.js':
            self.increment('cache-mode')
            self.send_bytes(
                b'window.__qsCacheMode = true;\n',
                'application/javascript',
                Cache_Control='max-age=60',
            )
            return

        super().do_GET()


def start_server(port: int) -> ThreadingHTTPServer:
    HarnessHandler.counts.clear()
    server = ThreadingHTTPServer(('127.0.0.1', port), HarnessHandler)
    Thread(target=server.serve_forever, daemon=True).start()
    return server
