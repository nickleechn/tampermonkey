#!/usr/bin/env python3
"""Drive system Google Chrome via CDP and print Quicksilver harness results."""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import tempfile
import time
import urllib.request

PORT = int(os.environ.get('QS_TEST_PORT', '8765'))
DEBUG_PORT = int(os.environ.get('QS_DEBUG_PORT', '9335'))
CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
HARNESS = f'http://127.0.0.1:{PORT}/test/quicksilver-chrome/index.html'


def main() -> int:
    import websocket

    urllib.request.urlopen(HARNESS, timeout=2)

    profile = tempfile.mkdtemp(prefix='qs-chrome-profile-')
    chrome = subprocess.Popen([
        CHROME,
        f'--remote-debugging-port={DEBUG_PORT}',
        '--remote-allow-origins=*',
        '--headless=new',
        '--disable-gpu',
        '--no-first-run',
        '--no-default-browser-check',
        f'--user-data-dir={profile}',
        'about:blank',
    ], stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)

    try:
        page_ws = None
        for _ in range(50):
            try:
                tabs = json.loads(urllib.request.urlopen(
                    f'http://127.0.0.1:{DEBUG_PORT}/json/list', timeout=1).read())
                for t in tabs:
                    if t.get('type') == 'page':
                        page_ws = t['webSocketDebuggerUrl']
                        break
                if page_ws:
                    break
            except Exception:
                time.sleep(0.1)
        if not page_ws:
            err = chrome.stderr.read().decode(errors='replace') if chrome.stderr else ''
            print('FAIL: no page target\n' + err)
            return 2

        ws = websocket.create_connection(page_ws, timeout=10)
        state = {'id': 0}

        def cdp(method, params=None):
            state['id'] += 1
            req_id = state['id']
            ws.send(json.dumps({'id': req_id, 'method': method, 'params': params or {}}))
            while True:
                data = json.loads(ws.recv())
                if data.get('id') == req_id:
                    if 'error' in data:
                        raise RuntimeError(data['error'])
                    return data.get('result', {})

        cdp('Runtime.enable')
        cdp('Page.enable')
        cdp('Page.navigate', {'url': HARNESS})

        result = None
        text = None
        title = None
        for _ in range(120):
            ev = cdp('Runtime.evaluate', {
                'expression': 'window.__QS_TEST_RESULTS__ || null',
                'returnByValue': True,
            })
            result = ev.get('result', {}).get('value')
            if result is not None:
                title = cdp('Runtime.evaluate', {
                    'expression': 'document.title',
                    'returnByValue': True,
                }).get('result', {}).get('value')
                text = cdp('Runtime.evaluate', {
                    'expression': 'document.getElementById("results").textContent',
                    'returnByValue': True,
                }).get('result', {}).get('value')
                break
            time.sleep(0.15)
        ws.close()

        ver = json.loads(urllib.request.urlopen(
            f'http://127.0.0.1:{DEBUG_PORT}/json/version').read())
        print('Browser:', ver.get('Browser'))
        print('Title:', title)
        print(text or '')
        if result and result.get('failed') == 0:
            print('ALL PASSED on Google Chrome')
            return 0
        print('FAIL on Google Chrome')
        return 1
    finally:
        chrome.terminate()
        try:
            chrome.wait(timeout=5)
        except Exception:
            chrome.kill()
        shutil.rmtree(profile, ignore_errors=True)


if __name__ == '__main__':
    raise SystemExit(main())
