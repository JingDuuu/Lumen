"""Actual Flask multipart ZIP roundtrip, including Python 3.10 upload streams."""
import io
import tempfile
import unittest
from unittest.mock import patch

import app as backend


class MultipartTests(unittest.TestCase):
    def test_exported_scene_package_imports_from_real_multipart(self):
        with tempfile.TemporaryDirectory() as folder, patch.dict(backend.app.config, {"PREVIS_ROOT": folder}):
            client = backend.app.test_client()
            scene = {"version":3,"objects":[{"id":"prop","type":"box","position":[1,2,3]}],"sequence":{"duration":2,"tracks":[]}}
            saved = client.post('/api/previs/documents', json={"name":"独立场景","kind":"scene","scene":scene})
            self.assertEqual(saved.status_code, 200, saved.json)
            original_id = saved.json['document']['id']
            package = client.get('/api/previs/documents/' + original_id + '/package')
            self.assertEqual(package.status_code, 200)
            response = client.post('/api/previs/documents/import', data={'file':(io.BytesIO(package.data),'scene.zip')}, content_type='multipart/form-data')
            self.assertEqual(response.status_code, 200, response.json)
            self.assertEqual(response.json['document']['scene'], scene)
            self.assertNotEqual(response.json['document']['id'], original_id)
            package.close()

    def test_bad_zip_is_a_readable_client_error(self):
        with tempfile.TemporaryDirectory() as folder, patch.dict(backend.app.config, {"PREVIS_ROOT": folder}):
            response = backend.app.test_client().post('/api/previs/documents/import', data={'file':(io.BytesIO(b'bad zip'),'scene.zip')}, content_type='multipart/form-data')
            self.assertEqual(response.status_code,400)
            self.assertIn('ZIP', response.json['error'])


if __name__ == '__main__':
    unittest.main()
