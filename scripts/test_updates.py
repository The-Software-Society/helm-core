from contextlib import contextmanager
import importlib.util
import json
import os
from pathlib import Path
import sqlite3
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('updater', Path(__file__).with_name('helm-update.py'))
u = importlib.util.module_from_spec(spec)
spec.loader.exec_module(u)


@contextmanager
def database(path):
    conn = sqlite3.connect(path)
    try:
        with conn:
            yield conn
    finally:
        conn.close()


class Child:
    pid = 7654321
    def __init__(self, running=True):
        self.running = running
    def poll(self):
        return None if self.running else 1
    def terminate(self):
        self.running = False
    def wait(self, timeout=None):
        return 0


class Updates(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.data = self.root / 'workspace'
        self.data.mkdir()
        self.app = self.root / 'candidate/Helm Core.app'
        (self.app / 'Contents/MacOS').mkdir(parents=True)
        (self.app / 'Contents/MacOS/Helm Core').write_text('executable fixture')
        (self.app / 'Contents/Resources').mkdir()
        self.target = self.root / 'Applications/Helm Core.app'
        self.target.mkdir(parents=True)
        (self.target / 'old-build').write_text('previous')
        with database(self.data / 'helm.db') as db:
            db.execute('CREATE TABLE tasks (value TEXT)')
            db.execute("INSERT INTO tasks VALUES ('original task')")
        u.seal(self.app)

    def tearDown(self):
        self.temp.cleanup()

    def job(self):
        return u.prepare(self.app, self.data, self.target, 0)

    def test_rejects_modified_release(self):
        (self.app / 'Contents/MacOS/Helm Core').write_text('changed after checks')
        with self.assertRaisesRegex(ValueError, 'changed after preparation'):
            self.job()
        self.assertTrue((self.target / 'old-build').exists())

    def test_rejects_escaping_symlink(self):
        (self.app / 'Contents/escape').symlink_to(self.root / 'workspace')
        with self.assertRaisesRegex(ValueError, 'escapes app'):
            u.fingerprint(self.app)

    def test_staged_build_is_independent(self):
        path = self.job()
        staged = Path(json.loads(path.read_text())['app'])
        (self.app / 'Contents/MacOS/Helm Core').write_text('next development build')
        u.verify(staged)
        self.assertTrue((self.target / 'old-build').exists())

    def test_database_backup_includes_live_wal(self):
        db = sqlite3.connect(self.data / 'helm.db')
        db.execute('PRAGMA journal_mode=WAL')
        db.execute("INSERT INTO tasks VALUES ('committed in WAL')")
        db.commit()
        backup = self.root / 'backup.sqlite'
        u.backup_database(self.data, backup)
        with database(backup) as saved:
            self.assertEqual(saved.execute('SELECT COUNT(*) FROM tasks').fetchone()[0], 2)
        db.close()

    def test_backup_after_clean_wal_shutdown(self):
        with database(self.data / 'helm.db') as db:
            db.execute('PRAGMA journal_mode=WAL')
            db.execute("INSERT INTO tasks VALUES ('saved before shutdown')")
            db.commit()
            db.execute('PRAGMA wal_checkpoint(TRUNCATE)')
        # Model better-sqlite3 closing the last connection and removing sidecars.
        for suffix in ('-wal', '-shm'):
            (self.data / ('helm.db' + suffix)).unlink(missing_ok=True)
        self.assertFalse((self.data / 'helm.db-wal').exists())
        backup = self.root / 'cold-backup.sqlite'
        u.backup_database(self.data, backup)
        with database(backup) as saved:
            self.assertEqual(saved.execute('SELECT COUNT(*) FROM tasks').fetchone()[0], 2)

    def test_success_preserves_live_service_and_previous_app(self):
        path = self.job()
        info = {'pid': 987654}
        def launch(app, data, receipt=None, require_daemon=False):
            self.assertTrue(require_daemon)
            u.write_json(receipt, {'pid': Child.pid, 'daemonPid': info['pid'], 'app': str(app.resolve())})
            return Child()
        with patch.object(u, 'daemon_info', return_value=info), patch.object(u, 'launch', side_effect=launch), patch.object(u.time, 'sleep'):
            u.run_job(path)
        job = json.loads(path.read_text())
        self.assertEqual(job['state'], 'complete')
        self.assertTrue(job['daemonPreserved'])
        self.assertTrue((Path(job['previous']) / 'old-build').exists())
        self.assertEqual(self.target.resolve(), Path(job['app']))

    def test_failed_ui_preserves_live_database_and_rolls_back_app(self):
        path = self.job()
        def launch(app, data, receipt=None, require_daemon=False):
            if receipt:
                with database(self.data / 'helm.db') as db:
                    db.execute("INSERT INTO tasks VALUES ('work during update')")
            return Child(False)
        with patch.object(u, 'daemon_info', return_value={'pid': 987654}), patch.object(u, 'launch', side_effect=launch):
            with self.assertRaisesRegex(RuntimeError, 'startup check'):
                u.run_job(path)
        self.assertTrue((self.target / 'old-build').exists())
        with database(self.data / 'helm.db') as db:
            self.assertEqual(db.execute('SELECT COUNT(*) FROM tasks').fetchone()[0], 2)
        self.assertEqual(json.loads(path.read_text())['state'], 'rolled-back')

    def test_failed_cold_start_restores_database(self):
        path = self.job()
        def launch(app, data, receipt=None, require_daemon=False):
            if receipt:
                with database(self.data / 'helm.db') as db:
                    db.execute('DROP TABLE tasks')
            return Child(False)
        with patch.object(u, 'daemon_info', return_value=None), patch.object(u, 'launch', side_effect=launch):
            with self.assertRaisesRegex(RuntimeError, 'startup check'):
                u.run_job(path)
        with database(self.data / 'helm.db') as db:
            self.assertEqual(db.execute('SELECT value FROM tasks').fetchone()[0], 'original task')
        self.assertTrue((self.target / 'old-build').exists())

    def test_second_update_keeps_immutable_previous_release(self):
        path = self.job()
        def launch(app, data, receipt=None, require_daemon=False):
            u.write_json(receipt, {'pid': Child.pid, 'daemonPid': 987654, 'app': str(app.resolve())})
            return Child()
        with patch.object(u, 'daemon_info', return_value={'pid': 987654}), patch.object(u, 'launch', side_effect=launch), patch.object(u.time, 'sleep'):
            u.run_job(path)
            old = self.target.resolve()
            second = self.job()
            u.run_job(second)
        self.assertTrue(old.exists())
        self.assertEqual(json.loads(second.read_text())['previous'], str(old))
        self.assertNotEqual(old, self.target.resolve())

    def test_rejects_tampering_after_staging(self):
        path = self.job()
        app = Path(json.loads(path.read_text())['app'])
        (app / 'Contents/MacOS/Helm Core').write_text('tampered')
        with self.assertRaisesRegex(ValueError, 'changed after preparation'):
            u.run_job(path)
        self.assertTrue((self.target / 'old-build').exists())


if __name__ == '__main__':
    unittest.main()
