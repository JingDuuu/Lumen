import hashlib
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from flask import Flask
import requests

import model_manager
from runtime_config import load_config


class Response:
    def __init__(self, body, offset, size, code=206, wrong_range=False, cancel=None):
        self.body = body
        self.status_code = code
        self.headers = {"Content-Range": f"bytes {offset}-{size-1}/{size}" if not wrong_range else "bytes 0-1/2"}
        self.cancel = cancel

    def __enter__(self):
        return self

    def __exit__(self, *args):
        pass

    def raise_for_status(self):
        pass

    def iter_content(self, size):
        yield self.body[:100]
        if self.cancel:
            self.cancel()
        yield self.body[100:]


class PortableTests(unittest.TestCase):
    def test_new_checkout_defaults_are_inside_project(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder).resolve()
            config = load_config(root, {})
            self.assertEqual(config.comfy_dir, root / 'runtime/ComfyUI')
            self.assertEqual(config.data_dir, root / 'data')
            self.assertEqual(config.input_dir, root / 'data/input')

    def test_legacy_paths_are_preserved(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder).resolve()
            (root / 'main.py').touch()
            (root / 'comfy').mkdir()
            studio = root / 'studio'
            studio.mkdir()
            config = load_config(studio, {})
            self.assertEqual(config.comfy_dir, root)
            self.assertEqual(config.data_dir, studio)
            self.assertEqual(config.input_dir, root / 'input')
            self.assertEqual(config.output_dir, root / 'output')

    def test_local_config_relative_paths_and_environment_override(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder).resolve()
            (root / 'lumen.local.json').write_text(json.dumps({'comfy_dir':'my-engine','data_dir':'my-data'}))
            config = load_config(root, {'LUMEN_DATA_DIR':str(root / 'override')})
            self.assertEqual(config.comfy_dir, root / 'my-engine')
            self.assertEqual(config.data_dir, root / 'override')
            self.assertEqual(config.input_dir, root / 'override/input')


class InstallerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.body = bytes(range(256)) * 8
        self.model = dict(id='test', label='Test model', path='diffusion_models/test.safetensors',
                          size=len(self.body), sha256=hashlib.sha256(self.body).hexdigest())
        manifest = dict(repository='official/test', revision='a'*40, license_name='test', license_url='https://example.test/license', models=[self.model])
        self.manager = model_manager.ModelInstaller(self.root / 'models', self.root / 'data', manifest)
        self.destination = self.manager.destination(self.model)
        self.partial = self.destination.with_suffix('.safetensors.part')

    def tearDown(self):
        self.temp.cleanup()

    def response(self, url, headers, **kwargs):
        offset = int(headers['Range'].split('=')[1].split('-')[0])
        return Response(self.body[offset:], offset, len(self.body))

    def test_inventory_does_not_download_or_hash(self):
        with patch('model_manager.requests.get', side_effect=AssertionError('network')), patch.object(self.manager, 'verify', side_effect=AssertionError('hash')):
            self.assertFalse(self.manager.inventory()['models'][0]['present'])

    def test_resume_is_exact_and_atomic(self):
        self.partial.parent.mkdir(parents=True)
        self.partial.write_bytes(self.body[:700])
        with patch('model_manager.requests.get', side_effect=self.response) as download:
            self.manager.download(self.model)
        self.assertEqual(download.call_args.kwargs['headers']['Range'], 'bytes=700-')
        self.assertEqual(self.destination.read_bytes(), self.body)
        self.assertFalse(self.partial.exists())

    def test_bad_range_never_appends(self):
        self.partial.parent.mkdir(parents=True)
        self.partial.write_bytes(self.body[:700])
        with patch('model_manager.requests.get', return_value=Response(self.body, 700, len(self.body), wrong_range=True)):
            with self.assertRaises(ValueError):
                self.manager.download(self.model)
        self.assertEqual(self.partial.read_bytes(), self.body[:700])
        self.assertFalse(self.destination.exists())

    def test_bad_hash_preserves_partial_without_activation(self):
        with patch('model_manager.requests.get', return_value=Response(b'x'*len(self.body), 0, len(self.body))):
            with self.assertRaises(ValueError):
                self.manager.download(self.model)
        self.assertFalse(self.destination.exists())
        self.assertTrue(self.partial.exists())

    def test_existing_bad_file_is_not_overwritten(self):
        self.destination.parent.mkdir(parents=True)
        self.destination.write_bytes(b'preserve this')
        with patch('model_manager.requests.get', side_effect=AssertionError('network')):
            with self.assertRaises(ValueError):
                self.manager.download(self.model)
        self.assertEqual(self.destination.read_bytes(), b'preserve this')

    def test_cancel_keeps_prefix_for_next_run(self):
        with patch('model_manager.requests.get', return_value=Response(self.body, 0, len(self.body), cancel=self.manager.cancel_event.set)):
            with self.assertRaises(model_manager.Cancelled):
                self.manager.download(self.model)
        self.assertEqual(self.partial.read_bytes(), self.body[:100])
        self.assertFalse(self.destination.exists())

    def test_low_space_rejects_before_worker_or_network(self):
        with patch('model_manager.shutil.disk_usage') as disk:
            disk.return_value.free = 1
            with self.assertRaises(ValueError):
                self.manager.start(['test'])
        self.assertIsNone(self.manager.worker)

    def test_install_requires_explicit_license_and_valid_ids(self):
        app = Flask(__name__)
        app.register_blueprint(model_manager.create_blueprint(self.manager))
        app.register_error_handler(ValueError, lambda error: ({'error':str(error)},400))
        client = app.test_client()
        with patch.object(self.manager, 'start') as start:
            self.assertEqual(client.post('/api/models/install',json={'models':['test']}).status_code,400)
            start.assert_not_called()
        with self.assertRaises(ValueError):
            self.manager.start(['../../private'])
        self.assertIsNone(self.manager.worker)

    def test_manifest_paths_cannot_escape(self):
        with self.assertRaises(ValueError):
            self.manager.destination(dict(self.model,path='../outside.safetensors'))

    def test_two_installers_cannot_share_model_write_lock(self):
        with model_manager.installation_lock(self.manager.models_dir):
            with self.assertRaises(RuntimeError):
                with model_manager.installation_lock(self.manager.models_dir):
                    self.fail('second installer acquired the lock')
        with model_manager.installation_lock(self.manager.models_dir):
            pass


if __name__ == '__main__':
    unittest.main()
