"""Dedicated login browser adapter. No request/body/page logging."""
import base64
import json
import os
import pathlib
import re
import socket
import sys
import time
import urllib.request
from urllib.parse import urlsplit, parse_qs
from capture import CDP, PIXIV_DOMAINS, pixiv_cookies

ROOT = pathlib.Path('/run/aoi/session')
RESULT = ROOT / 'result.json'

def read_json(file):
    return json.loads(pathlib.Path(file).read_text())

def save_json(file, value):
    fd = os.open(file, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, 'w') as stream:
        json.dump(value, stream)

def main():
    config = read_json(str(ROOT / 'input.json'))
    page = None
    for _ in range(60):
        try:
            pages = json.load(urllib.request.urlopen('http://127.0.0.1:9222/json/list', timeout=2))
            page = next(p for p in pages if p.get('type') == 'page')
            break
        except Exception:
            time.sleep(.5)
    if not page:
        return
    c = CDP(page['webSocketDebuggerUrl'])
    # Only pause the official app callback response, to replace its native-app handoff.
    if config['provider'] == 'pixiv':
        c.call('Fetch.enable', {'patterns': [{'urlPattern': 'https://app-api.pixiv.net/web/v1/users/auth/pixiv/callback*', 'requestStage': 'Response'}]})
    c.call('Page.enable')
    # Explicitly maximize after the compositor is available, not just at process launch.
    window = c.call('Browser.getWindowForTarget')
    c.call('Browser.setWindowBounds', {'windowId': window['windowId'], 'bounds': {'windowState': 'maximized'}})
    cookies = config.get('cookies', [])
    clean = [v for v in cookies if v.get('name') == 'PHPSESSID' and v.get('domain') in PIXIV_DOMAINS and v.get('secure')]
    if clean:
        c.call('Network.setCookies', {'cookies': clean})
    if config.get('mobile'):
        c.call('Emulation.setDeviceMetricsOverride', {'width': 390, 'height': 760, 'deviceScaleFactor': 1, 'mobile': True})
        c.call('Emulation.setTouchEmulationEnabled', {'enabled': True})
        c.call('Emulation.setUserAgentOverride', {'userAgent': 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Mobile Safari/537.36'})
    if config['provider'] != 'pixiv':
        c.serial += 1
        c.send({'id': c.serial, 'method': 'Page.navigate', 'params': {'url': config['url']}})
        (ROOT / 'ready').touch(mode=0o600)
        return
    # Navigation can pause at the callback immediately when the web session is reusable.
    c.serial += 1
    c.send({'id': c.serial, 'method': 'Page.navigate', 'params': {'url': config['url']}})
    (ROOT / 'ready').touch(mode=0o600)
    deadline = time.monotonic() + config['ttl']
    c.sock.settimeout(2)
    while time.monotonic() < deadline:
        try:
            event = c.events.pop(0) if c.events else c.receive()
        except socket.timeout:
            continue
        if event.get('method') != 'Fetch.requestPaused':
            continue
        url = urlsplit(event.get('params', {}).get('request', {}).get('url', ''))
        # The only code accepted is the official mobile app callback observed in this PKCE session.
        if url.scheme != 'https' or url.hostname != 'app-api.pixiv.net' or url.path != '/web/v1/users/auth/pixiv/callback':
            c.call('Fetch.continueRequest', {'requestId': event['params']['requestId']})
            continue
        code = parse_qs(url.query).get('code', [''])[0]
        if not re.fullmatch(r'[A-Za-z0-9._~-]{1,2048}', code):
            c.call('Fetch.continueRequest', {'requestId': event['params']['requestId']})
            continue
        c.sock.settimeout(8)
        cookies = pixiv_cookies(c)
        body = '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>AoI 登录</title><p>授权已完成，正在保存。请返回 AoI 查看结果，无需打开其他应用。</p>'
        c.call('Fetch.fulfillRequest', {'requestId': event['params']['requestId'], 'responseCode': 200, 'responseHeaders': [{'name': 'Content-Type', 'value': 'text/html; charset=utf-8'}, {'name': 'Cache-Control', 'value': 'no-store'}], 'body': base64.b64encode(body.encode()).decode()})
        save_json(str(RESULT), {'code': code, 'cookies': cookies})
        return

if __name__ == '__main__':
    try:
        main()
    except Exception:
        # Detailed browser exceptions can contain URLs/codes; never log them.
        save_json(str(RESULT), {'error': 'browser_unavailable'})
