"""Own one in-container desktop session. EOF, timeout and failures all clean it.

The broker keeps stdin open as a lease. Its death closes the pipe, independently
of Node timers. No credentials, URLs, subprocess output or exceptions are logged.
"""
import fcntl
import json
import os
import pathlib
import select
import shutil
import signal
import subprocess
import sys
import time
import urllib.request

ROOT = pathlib.Path('/run/aoi/session')
HOME = pathlib.Path('/config/aoi-session')
SERVICES = pathlib.Path('/run/service')


def run(args, timeout=20):
    return subprocess.run(args, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                          stderr=subprocess.DEVNULL, timeout=timeout, check=True)


def stop_desktop():
    # Stop the DE (and its Chromium descendants) before its Wayland compositor.
    for name in ('svc-de', 'svc-selkies'):
        service = str(SERVICES / name)
        run(['s6-svc', '-d', service])
        try:
            run(['s6-svwait', '-d', '-t', '12000', service], timeout=15)
        except Exception:
            run(['s6-svc', '-k', service])
            run(['s6-svwait', '-d', '-t', '5000', service], timeout=8)
    # Crash handlers may outlive the browser's process group. Only this dedicated
    # container's browser user is targeted; there are no other browser sessions.
    subprocess.run(['pkill', '-KILL', '-u', 'abc', '-f', '/usr/lib/chromium/'],
                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def reset():
    stop_desktop()
    for directory in (ROOT, HOME):
        if directory.exists():
            shutil.rmtree(directory)
    pathlib.Path('/config/aoi-start').unlink(missing_ok=True)


def create_private(directory, uid=0, gid=0):
    directory.mkdir(mode=0o700)
    os.chown(directory, uid, gid)


def main():
    if len(sys.argv) > 1 and sys.argv[1] == 'reset':
        reset()
        return
    # bounded single-line input; keep stdin exclusively as the parent lease
    config = json.loads(sys.stdin.buffer.readline(32769))
    ttl = config['ttl']
    if not isinstance(ttl, (int, float)) or not 30 <= ttl <= 1800:
        raise ValueError()
    import pwd
    user = pwd.getpwnam('abc')
    reset()
    create_private(ROOT)
    create_private(HOME, user.pw_uid, user.pw_gid)
    fd = os.open(ROOT / 'input.json', os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, 'w') as stream:
        json.dump(config, stream)
    # with-contenv reads these before each internal service starts. This also
    # resets the stream's frame and clipboard memory between login sessions.
    for name, value in {'AOI_BROWSER_MOBILE': 'true' if config.get('mobile') else 'false',
                        'SELKIES_MANUAL_WIDTH': 390 if config.get('mobile') else 1280,
                        'SELKIES_MANUAL_HEIGHT': 844 if config.get('mobile') else 800}.items():
        (pathlib.Path('/run/s6/container_environment') / name).write_text(str(value))
    pathlib.Path('/config/aoi-start').touch(mode=0o644)
    deadline = time.monotonic() + 90
    for name in ('svc-selkies', 'svc-de'):
        run(['s6-svc', '-u', str(SERVICES / name)])
    worker = None
    try:
        while time.monotonic() < deadline:
            if select.select([sys.stdin.buffer], [], [], 0)[0]:
                return
            try:
                with urllib.request.urlopen('http://127.0.0.1:9222/json/version', timeout=1) as response:
                    if response.status == 200:
                        break
            except Exception:
                time.sleep(.25)
        else:
            raise ValueError()
        worker = subprocess.Popen(['python3', '/opt/aoi/browser-worker.py'],
                                  stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        # Worker confirms navigation was scheduled. Do not return a usable stream
        # while the initialization could still be modifying another session.
        while time.monotonic() < deadline and not (ROOT / 'ready').exists():
            if worker.poll() is not None or select.select([sys.stdin.buffer], [], [], .1)[0]:
                raise ValueError()
        if not (ROOT / 'ready').exists():
            raise ValueError()
        print('{"ready":true}', flush=True)
        select.select([sys.stdin.buffer], [], [], ttl)
    finally:
        if worker and worker.poll() is None:
            worker.terminate()
            try:
                worker.wait(timeout=5)
            except subprocess.TimeoutExpired:
                worker.kill()
                worker.wait()
        reset()


if __name__ == '__main__':
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))
    pathlib.Path('/run/aoi').mkdir(mode=0o700, exist_ok=True)
    lease = open('/run/aoi/session.lock', 'w')
    fcntl.flock(lease.fileno(), fcntl.LOCK_EX)
    try:
        main()
    except BaseException:
        try:
            reset()
        except BaseException:
            pass
        sys.exit(1)
