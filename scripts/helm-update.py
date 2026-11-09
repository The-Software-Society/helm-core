#!/usr/bin/env python3
"""Local, detached Helm updater. Uses only the macOS Python standard library."""
import argparse
from contextlib import closing
import fcntl
import hashlib
import json
import os
from pathlib import Path
import shutil
import signal
import sqlite3
import subprocess
import sys
import time
import urllib.request
import uuid

MANIFEST = 'Contents/Resources/helm-release.json'
# Re-signing the outer bundle after the manifest is written changes only these; the signature itself then covers them.
OUTER_SIGNATURE = ('Contents/MacOS/Helm Core', 'Contents/_CodeSignature/CodeResources')


def write_json(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_suffix('.tmp')
    temp.write_text(json.dumps(value, indent=2) + '\n')
    os.replace(temp, path)


def fingerprint(app, skip=()):
    """Include binaries, dependencies, modes and internal symlinks, not just UI JS."""
    app = Path(app).resolve()
    digest = hashlib.sha256()
    for root, dirs, files in os.walk(app, followlinks=False):
        for name in sorted(dirs + files):
            p = Path(root) / name
            rel = p.relative_to(app).as_posix()
            if rel == MANIFEST or rel in skip:
                continue
            digest.update((rel + '\0' + str(p.lstat().st_mode & 0o777) + '\0').encode())
            if p.is_symlink():
                if not p.resolve().is_relative_to(app):
                    raise ValueError('Release symlink escapes app: ' + rel)
                digest.update(('link:' + os.readlink(p)).encode())
            elif p.is_file():
                with p.open('rb') as f:
                    for chunk in iter(lambda: f.read(1024 * 1024), b''):
                        digest.update(chunk)
        dirs.sort()
    return digest.hexdigest()


def signer(app):
    """Leaf certificate hash of a stable local signature (scripts/sign-macos.sh), or None when unsigned or ad-hoc."""
    r = subprocess.run(['/usr/bin/codesign', '-dr', '-', str(app)], capture_output=True, text=True)
    out = r.stdout + r.stderr
    if r.returncode or 'certificate leaf = H"' not in out:
        return None
    return out.split('certificate leaf = H"', 1)[1].split('"', 1)[0]


def signature_valid(app, leaf):
    req = '=identifier "io.helm-core.app" and certificate leaf = H"%s"' % leaf
    return subprocess.run(['/usr/bin/codesign', '--verify', '--deep', '--strict', '-R', req, str(app)],
                          capture_output=True).returncode == 0


def seal(app):
    app = Path(app)
    manifest = {'format': 1, 'channel': 'stable', 'sha256': fingerprint(app),
                'createdAt': time.time(), 'checks': ['typecheck', 'regression', 'recovery', 'updater', 'package', 'packaged-update-continuity']}
    leaf = signer(app)
    if leaf:
        manifest.update(signer=leaf, core=fingerprint(app, OUTER_SIGNATURE))
    write_json(app / MANIFEST, manifest)
    return manifest


def verify(app):
    app = Path(app)
    manifest = json.loads((app / MANIFEST).read_text())
    if manifest.get('format') != 1 or manifest.get('channel') != 'stable':
        raise ValueError('Not a prepared stable Helm release. Run pnpm update:prepare.')
    full = manifest.get('sha256') == fingerprint(app)
    # A re-signed install: everything but the outer signature matches, and that signature verifies with the sealed identity.
    resigned = not full and manifest.get('signer') and manifest.get('core') == fingerprint(app, OUTER_SIGNATURE) \
        and signature_valid(app, manifest['signer'])
    if not (full or resigned):
        raise ValueError('Release changed after preparation. Run pnpm update:prepare again.')
    if not (app / 'Contents/MacOS/Helm Core').is_file():
        raise ValueError('Helm executable missing')
    return manifest


def alive(pid):
    if not pid:
        return False
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False


def daemon_info(data):
    try:
        info = json.loads((Path(data) / 'daemon.json').read_text())
        req = urllib.request.Request('http://127.0.0.1:%s/status' % info['port'],
                                     headers={'Authorization': 'Bearer ' + info['token']})
        with urllib.request.urlopen(req, timeout=2) as response:
            status = json.load(response)
        return {**info, 'live': status.get('live', 0), 'headless': status.get('headless', 0)} if status['pid'] == info['pid'] else None
    except (OSError, ValueError, KeyError):
        return None


def backup_database(data, dest):
    source = Path(data) / 'helm.db'
    if not source.exists():
        return False
    # SQLite backup includes committed WAL contents while the daemon keeps working.
    # macOS system SQLite needs a writable connection to initialize WAL bookkeeping
    # after a clean shutdown removed -wal/-shm. query_only prevents SQL writes;
    # mode=rw still refuses to create a missing source database.
    with closing(sqlite3.connect(source.as_uri() + '?mode=rw', uri=True, timeout=10)) as src:
        src.execute('PRAGMA query_only=ON')
        with closing(sqlite3.connect(dest)) as dst:
            src.backup(dst)
    return True


def finish_signing(app):
    """The manifest lands after signing, so re-seal the outer bundle to cover it. Keeps the same identity, so macOS
    permissions (Full Disk Access etc.) carry across updates. Nested helpers keep their signatures."""
    manifest = json.loads((Path(app) / MANIFEST).read_text())
    leaf = manifest.get('signer')
    if not leaf or signature_valid(app, leaf):
        return
    r = subprocess.run(['/usr/bin/codesign', '--force', '--sign', leaf, str(app)], capture_output=True, text=True)
    if r.returncode or not signature_valid(app, leaf):
        # Still runs without it; macOS may just ask for permissions again.
        print('Re-signing skipped: ' + (r.stderr.strip() or 'signature did not verify'), file=sys.stderr)
        return
    verify(app)


def prepare(app, data, target, parent):
    app, data, target = Path(app).resolve(), Path(data).resolve(), Path(target).absolute()
    manifest = verify(app)
    job_dir = data / 'updates' / 'releases' / (manifest['sha256'][:12] + '-' + uuid.uuid4().hex[:8])
    job_dir.mkdir(parents=True)
    staged = job_dir / 'Helm Core.app'
    # APFS clones keep each retained release independent while sharing unchanged bytes. This matters when
    # several live bundles must be retained for terminal continuity. Fall back to a regular copy across volumes.
    cloned = False
    if sys.platform == 'darwin' and app.stat().st_dev == job_dir.stat().st_dev:
        cloned = subprocess.run(['/bin/cp', '-cR', str(app), str(staged)], capture_output=True).returncode == 0
        if not cloned and staged.exists():
            shutil.rmtree(staged)
    if not cloned:
        shutil.copytree(app, staged, symlinks=True)
    verify(staged)
    previous = str(target.resolve()) if target.exists() else None
    job = {'app': str(staged), 'data': str(data), 'target': str(target), 'parent': parent,
           'previous': previous, 'id': job_dir.name, 'state': 'prepared'}
    path = job_dir / 'job.json'
    write_json(path, job)
    os.chmod(path, 0o600)
    return path


def link_app(app, target):
    target = Path(target)
    target.parent.mkdir(parents=True, exist_ok=True)
    temp = target.with_name('.' + target.name + '.update-' + uuid.uuid4().hex)
    temp.symlink_to(app, target_is_directory=True)
    os.replace(temp, target)


def launch(app, data, receipt=None, require_daemon=False):
    env = dict(os.environ)
    for name in list(env):
        if name.startswith('HELM_') or name in ('ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'NODE_OPTIONS'):
            env.pop(name, None)
    env['HELM_DATA_DIR'] = str(data)
    env['HELM_CHANNEL'] = 'stable'
    if receipt:
        env['HELM_UPDATE_RECEIPT'] = str(receipt)
    if require_daemon:
        env['HELM_REQUIRE_DAEMON'] = '1'
    log = open(Path(data) / 'updates' / 'launch.log', 'ab')
    try:
        return subprocess.Popen([str(Path(app) / 'Contents/MacOS/Helm Core')], env=env,
                                stdin=subprocess.DEVNULL, stdout=log, stderr=log, start_new_session=True)
    finally:
        log.close()


def run_job(path, timeout=45):
    path = Path(path)
    job = json.loads(path.read_text())
    data, target, app = Path(job['data']), Path(job['target']), Path(job['app'])
    lock = open(data / 'updates' / 'update.lock', 'a')
    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    previous = job['previous']
    switched = False
    child = None
    old_daemon = None
    backup = path.parent / 'workspace-before.sqlite'
    try:
        verify(app)
        finish_signing(app)
        old_daemon = daemon_info(data)
        if not old_daemon and (data / 'daemon.json').exists():
            recorded = json.loads((data / 'daemon.json').read_text())
            if alive(recorded['pid']):
                raise RuntimeError('The existing service is not responding. Update deferred; no processes were stopped.')
        backup_database(data, backup)
        write_json(path, {**job, 'state': 'waiting-for-window'})
        write_json(path.parent / 'ready.json', {'ready': True})
        deadline = time.monotonic() + timeout
        while alive(job['parent']):
            if time.monotonic() > deadline:
                raise RuntimeError('Helm window did not close; update cancelled.')
            time.sleep(0.1)
        if target.exists() and not target.is_symlink():
            # One-time adoption of the old installer layout. Retain this exact bundle.
            previous = str(target.with_name('Helm.backup.' + job['id'] + '.app'))
            target.rename(previous)
            job['previous'] = previous
            write_json(path, job)
        link_app(app, target)
        switched = True
        write_json(path, {**job, 'state': 'checking-startup'})
        receipt = path.parent / 'healthy.json'
        child = launch(app, data, receipt, bool(old_daemon))
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if receipt.exists():
                ack = json.loads(receipt.read_text())
                if ack.get('pid') == child.pid and ack.get('app') == str(app.resolve()):
                    if old_daemon and ack.get('daemonPid') != old_daemon['pid']:
                        raise RuntimeError('Update unexpectedly changed the terminal service.')
                    # Catch immediate post-startup failures as well.
                    time.sleep(2)
                    current = daemon_info(data)
                    if child.poll() is None and current and (not old_daemon or current['pid'] == old_daemon['pid']):
                        write_json(path, {**job, 'state': 'complete', 'daemonPreserved': bool(old_daemon)})
                        write_json(data / 'updates' / 'latest.json', {**job, 'state': 'complete'})
                        return
            if child.poll() is not None:
                break
            time.sleep(0.2)
        raise RuntimeError('Updated Helm did not pass its workspace startup check.')
    except Exception as error:
        if child and child.poll() is None:
            child.terminate()
            try:
                child.wait(timeout=5)
            except subprocess.TimeoutExpired:
                child.kill()
                child.wait(timeout=5)
        # A UI-only update leaves the old service and live database untouched.
        # A cold start may migrate the database: stop that new service before restoring.
        if switched and not old_daemon:
            try:
                info_file = data / 'starting-service.json'
                if not info_file.exists():
                    info_file = data / 'daemon.json'
                info = json.loads(info_file.read_text())
                if Path(info.get('runtimePath', '')).is_relative_to(app) and alive(info['pid']):
                    os.kill(info['pid'], signal.SIGTERM)
                    deadline = time.monotonic() + 10
                    while alive(info['pid']) and time.monotonic() < deadline:
                        time.sleep(0.1)
                    if alive(info['pid']):
                        write_json(path, {**job, 'state': 'recovery-required', 'error': 'New service would not stop. Database was not overwritten.'})
                        write_json(data / 'updates/latest.json', json.loads(path.read_text()))
                        raise RuntimeError('New service would not stop; database rollback requires manual recovery.')
                elif alive(info['pid']):
                    write_json(path, {**job, 'state': 'recovery-required', 'error': 'Unrecognized service is running. Database was not overwritten.'})
                    write_json(data / 'updates/latest.json', json.loads(path.read_text()))
                    raise RuntimeError('An unrecognized service is running; database rollback requires manual recovery.')
            except FileNotFoundError:
                pass
            if backup.exists():
                for suffix in ('-wal', '-shm'):
                    (data / ('helm.db' + suffix)).unlink(missing_ok=True)
                shutil.copy2(backup, data / 'helm.db')
        if switched or (previous and not target.exists()):
            if previous:
                link_app(previous, target)
                launch(previous, data, require_daemon=bool(old_daemon))
            elif target.is_symlink():
                target.unlink()
        write_json(path, {**job, 'state': 'rolled-back' if switched else 'failed', 'error': str(error)})
        write_json(data / 'updates' / 'latest.json', {**job, 'state': 'rolled-back' if switched else 'failed', 'error': str(error)})
        raise
    finally:
        lock.close()


def install(app, data, target):
    """CLI entry point, including first adoption of the legacy unversioned install."""
    data, target = Path(data).resolve(), Path(target).absolute()
    info = daemon_info(data)
    legacy = info and not info.get('runtimePath')
    if legacy and (info['live'] or info['headless']):
        raise RuntimeError('First-time updater setup needs idle terminals. Finish active work before running install:mac again.')
    candidates = {str(target / 'Contents/MacOS/Helm Core'), str(target.resolve() / 'Contents/MacOS/Helm Core')}
    pids = []
    for row in subprocess.check_output(['/bin/ps', '-axo', 'pid=,comm='], text=True).splitlines():
        fields = row.strip().split(None, 1)
        if len(fields) == 2 and fields[1] in candidates:
            pids.append(int(fields[0]))
    if len(pids) > 1:
        raise RuntimeError('Multiple installed Helm windows found. Quit Helm and retry the install.')
    path = prepare(app, data, target, pids[0] if pids else 0)
    if legacy:
        # Recheck after staging, then close the old UI first so its reconnect loop
        # cannot race us by starting another unversioned service.
        info = daemon_info(data)
        if not info or info['live'] or info['headless']:
            raise RuntimeError('Legacy service became busy while staging. No update was applied.')
        backup_database(data, path.parent / 'legacy-workspace.sqlite')
        for pid in pids:
            if alive(pid):
                os.kill(pid, signal.SIGTERM)
        deadline = time.monotonic() + 10
        while any(alive(pid) for pid in pids) and time.monotonic() < deadline:
            time.sleep(0.1)
        if any(alive(pid) for pid in pids):
            raise RuntimeError('Legacy window did not close; install cancelled.')
        os.kill(info['pid'], signal.SIGTERM)
        deadline = time.monotonic() + 10
        while alive(info['pid']) and time.monotonic() < deadline:
            time.sleep(0.1)
        if alive(info['pid']):
            raise RuntimeError('Legacy service did not stop; install cancelled.')
    with open(data / 'updates' / 'updater.log', 'ab') as log:
        worker = subprocess.Popen([sys.executable, str(Path(json.loads(path.read_text())['app']) / 'Contents/Resources/helm-update.py'),
                                   'run', str(path)], stdin=subprocess.DEVNULL, stdout=log, stderr=log, start_new_session=True)
    deadline = time.monotonic() + 90
    closed = False
    while time.monotonic() < deadline:
        job = json.loads(path.read_text())
        if not closed and (path.parent / 'ready.json').exists():
            for pid in pids:
                if alive(pid):
                    os.kill(pid, signal.SIGTERM)
            closed = True
        if job['state'] == 'complete':
            print('Installed and verified: ' + str(target))
            return
        if job['state'] in ('failed', 'rolled-back', 'recovery-required'):
            raise RuntimeError(job.get('error', job['state']))
        if worker.poll() is not None:
            raise RuntimeError('Updater exited. See ' + str(data / 'updates/updater.log'))
        time.sleep(0.2)
    raise RuntimeError('Updater is still running. See ' + str(path))


def main():
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest='command', required=True)
    for command in ('seal', 'verify'):
        sub.add_parser(command).add_argument('app')
    p = sub.add_parser('prepare')
    p.add_argument('app')
    p.add_argument('--data', required=True)
    p.add_argument('--target', required=True)
    p.add_argument('--parent', type=int, default=0)
    p = sub.add_parser('install')
    p.add_argument('app')
    p.add_argument('--data', required=True)
    p.add_argument('--target', required=True)
    p = sub.add_parser('run')
    p.add_argument('job')
    p = sub.add_parser('backup')
    p.add_argument('data')
    p.add_argument('destination')
    args = parser.parse_args()
    if args.command == 'seal':
        print(json.dumps(seal(args.app)))
    elif args.command == 'verify':
        print(json.dumps(verify(args.app)))
    elif args.command == 'prepare':
        print(prepare(args.app, args.data, args.target, args.parent))
    elif args.command == 'install':
        install(args.app, args.data, args.target)
    elif args.command == 'run':
        run_job(args.job)
    elif args.command == 'backup':
        backup_database(args.data, args.destination)


if __name__ == '__main__':
    main()
