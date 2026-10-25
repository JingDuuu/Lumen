"""Previs persistence contracts and genuine Blender format roundtrips, temporary files only."""
import io
import json
import os
from pathlib import Path
import struct
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch
import zipfile
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
import app as backend
import format_bridge as bridge
from previs_store import PrevisStore


def glb_json(path):
    raw=Path(path).read_bytes()
    assert raw[:4]==b'glTF'
    length=struct.unpack('<I',raw[12:16])[0]
    return json.loads(raw[20:20+length])


def moving_targets(path):
    raw=Path(path).read_bytes(); length=struct.unpack('<I',raw[12:16])[0]; data=json.loads(raw[20:20+length]); binary=raw[28+length:]; moving=set()
    for animation in data.get('animations',[]):
        for channel in animation['channels']:
            target=channel['target']
            if 'node' not in target or target.get('path') not in {'translation','rotation','scale'}: continue
            accessor=data['accessors'][animation['samplers'][channel['sampler']]['output']]; view=data['bufferViews'][accessor['bufferView']]
            size={'VEC3':3,'VEC4':4}[accessor['type']]; offset=view.get('byteOffset',0)+accessor.get('byteOffset',0)
            values=struct.unpack_from('<'+'f'*(accessor['count']*size),binary,offset)
            if any(abs(values[index]-values[index%size])>1e-5 for index in range(len(values))): moving.add((data['nodes'][target['node']].get('name'),target['path']))
    return moving


class StoreTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.store=PrevisStore(self.temp.name)
        self.scene={'version':3,'objects':[{'id':'group','parentId':None,'type':'group'},{'id':'cube','parentId':'group','type':'cube','position':[1.125,-2.5,4.25],'custom':{'retained':True}}], 'sequence':{'tracks':[{'targetId':'cube','property':'position','keys':[{'time':0,'value':[1,2,3]}]}]},'unknownFutureField':[1,2,{'value':'保留'}]}

    def test_exact_save_open_save_as_recent_and_prefab(self):
        first=self.store.save(dict(kind='scene',name='场景',scene=self.scene))
        self.assertEqual(self.store.open(first['id'])['scene'],self.scene)
        other=self.store.save(dict(kind='prefab',name='层级预制体',scene=self.scene))
        self.assertNotEqual(first['id'],other['id']); self.assertEqual(len(self.store.list()),2)
        self.assertEqual(len(self.store.list('prefab')),1)
        self.store.open(first['id']); self.assertEqual(self.store.list(recent=True)[0]['id'],first['id'])
        self.store.delete(other['id']); self.assertEqual(len(self.store.list()),1)

    def test_atomic_failure_preserves_saved_document(self):
        saved=self.store.save(dict(name='旧名称',scene=self.scene)); before=self.store._document_path(saved['id']).read_bytes()
        with patch('previs_store.os.replace',side_effect=OSError('simulated disk error')):
            with self.assertRaises(OSError): self.store.save(dict(id=saved['id'],name='新名称',scene=self.scene))
        self.assertEqual(self.store._document_path(saved['id']).read_bytes(),before)
        self.assertEqual(list(self.store.root.rglob('*.tmp')),[])

    def test_external_paths_and_invalid_json_rejected(self):
        for url in ['https://example.com/private.glb','file:///C:/secret.glb','C:/secret.glb','blob:temporary','/input/unmanaged.glb','/api/previs/assets/'+'a'*32+'/../secret.glb']:
            scene=dict(self.scene,objects=[{'asset':{'url':url}}])
            with self.assertRaises(ValueError,msg=url): self.store.save(dict(name='bad',scene=scene))
        with self.assertRaises(ValueError): self.store.save(dict(name='bad',scene=dict(self.scene,invalid=float('nan'))))

    def test_portable_package_collects_assets_and_reopens_in_another_library(self):
        asset_id='a'*32; asset=self.store.asset_path(asset_id,'model.glb'); asset.parent.mkdir(parents=True); asset.write_bytes(b'portable-test-asset')
        source=f'/api/previs/assets/{asset_id}/model.glb'; scene=dict(self.scene,objects=[{'id':'imported','asset':{'url':source}}])
        saved=self.store.save(dict(kind='template',name='portable',scene=scene)); self.assertEqual(saved['scene'],scene)
        self.assertNotEqual(saved['assets'][0]['url'],source)
        other=PrevisStore(self.store.root/'other'); reopened=other.import_package(self.store.package(saved['id']))
        self.assertEqual(other.resolve_asset(reopened['scene']['objects'][0]['asset']['url']).read_bytes(),asset.read_bytes())
        self.assertEqual(reopened['scene']['sequence'],scene['sequence'])

    def test_zip_traversal_rejected(self):
        data=io.BytesIO()
        with zipfile.ZipFile(data,'w') as archive: archive.writestr('../secret','x'); archive.writestr('previs.json','{}')
        data.seek(0)
        with self.assertRaises(ValueError): self.store.import_package(data)

    def test_gltf_dependencies_are_portable_without_changing_json(self):
        asset_id='b'*32; asset=self.store.asset_path(asset_id,'model.gltf'); asset.parent.mkdir(parents=True)
        asset.write_text(json.dumps({'asset':{'version':'2.0'},'buffers':[{'uri':'model.bin','byteLength':4}],'images':[{'uri':'textures/color.png'}]}))
        (asset.parent/'model.bin').write_bytes(b'1234'); (asset.parent/'textures').mkdir(); (asset.parent/'textures/color.png').write_bytes(b'png')
        source=f'/api/previs/assets/{asset_id}/model.gltf'; scene=dict(self.scene,objects=[{'asset':{'url':source}}])
        saved=self.store.save(dict(name='glTF bundle',scene=scene)); self.assertEqual(saved['scene'],scene)
        self.assertEqual(len(saved['assets']),3)
        other=PrevisStore(self.store.root/'other'); reopened=other.import_package(self.store.package(saved['id']))
        restored=other.resolve_asset(reopened['scene']['objects'][0]['asset']['url'])
        self.assertEqual((restored.parent/'model.bin').read_bytes(),b'1234')
        self.assertEqual((restored.parent/'textures/color.png').read_bytes(),b'png')

    def test_api_contract_and_missing_blender(self):
        with patch.dict(backend.app.config,TESTING=True,PREVIS_ROOT=self.temp.name):
            client=backend.app.test_client(); response=client.post('/api/previs/documents',json={'name':'api','kind':'scene','scene':self.scene}); self.assertEqual(response.status_code,200)
            document=response.json['document']; self.assertEqual(client.get('/api/previs/documents/'+document['id']).json['document']['scene'],self.scene)
            self.assertEqual(len(client.get('/api/previs/recent').json['documents']),1)
            with patch.object(bridge,'blender_path',return_value=None):
                self.assertFalse(client.get('/api/previs/capabilities').json['blender_available'])
                response=client.post('/api/previs/import',data={'file':(io.BytesIO(b'invalid'),'invalid.glb')}); self.assertEqual(response.status_code,400)
        bridge.shutdown_jobs()


@unittest.skipUnless(bridge.blender_path(), 'Local Blender required for genuine format acceptance')
class BlenderRoundtripTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp=tempfile.TemporaryDirectory(); cls.root=Path(cls.temp.name); cls.input=cls.root/'animated.glb'
        result=subprocess.run([str(bridge.blender_path()),'--background','--factory-startup','--disable-autoexec','--threads','2','--python',str(Path(__file__).with_name('previs_blender_fixture.py')),'--',str(cls.input)],capture_output=True,text=True,timeout=60,creationflags=getattr(subprocess,'CREATE_NO_WINDOW',0))
        if result.returncode: raise RuntimeError(result.stdout+result.stderr)
        cls.config=patch.dict(backend.app.config,TESTING=True,PREVIS_ROOT=str(cls.root/'library')); cls.config.start(); cls.client=backend.app.test_client()
        cls.base=glb_json(cls.input)

    @classmethod
    def tearDownClass(cls):
        bridge.shutdown_jobs(); cls.config.stop(); cls.temp.cleanup()

    def job(self,endpoint,source,format=None):
        data={'file':(io.BytesIO(Path(source).read_bytes()),Path(source).name)}
        if format: data['format']=format
        started=time.monotonic(); response=self.client.post('/api/previs/'+endpoint,data=data); response.request.environ['wsgi.input'].close(); self.assertEqual(response.status_code,202,response.json); self.assertLess(time.monotonic()-started,5)
        job_id=response.json['job']['id']; statuses=set()
        while time.monotonic()-started<100:
            job=self.client.get('/api/previs/jobs/'+job_id).json['job']; statuses.add(job['status'])
            if job['status'] not in {'queued','running'}: break
            time.sleep(.1)
        self.assertEqual(job['status'],'done',job)
        result=job['result']; result['local']=PrevisStore(self.root/'library').resolve_asset(result['url']); result['download']=PrevisStore(self.root/'library').resolve_asset(result['download_url']); return result,job

    def test_all_formats_real_roundtrip(self):
        evidence=[]
        for format in ('glb','gltf','obj','fbx','abc'):
            with self.subTest(format=format):
                exported,job=self.job('export',self.input,format)
                if format=='fbx': self.assertTrue(exported['local'].read_bytes().startswith(b'Kaydara FBX Binary'))
                if format=='abc': self.assertTrue(exported['local'].read_bytes().startswith(b'Ogawa'))
                if format=='obj': self.assertIn('\nv ',exported['local'].read_text())
                imported,import_job=self.job('import',exported['download'])
                actual=glb_json(imported['local']); self.assertGreaterEqual(len(actual.get('meshes',[])),1)
                if format!='obj':
                    self.assertGreater(len(actual.get('animations',[])),0,'Animation silently lost in '+format)
                    self.assertTrue(any(node.get('children') for node in actual['nodes']),'Hierarchy lost in '+format)
                if format in {'glb','gltf','fbx','obj'}:
                    self.assertGreater(len(actual.get('materials',[])),0)
                    self.assertGreater(len(actual.get('images',[])),0,'Texture lost in '+format)
                if format=='abc': self.assertTrue(any(primitive.get('targets') for mesh in actual['meshes'] for primitive in mesh['primitives']),'Alembic deformation samples missing')
                evidence.append({'format':format,'size_bytes':exported['local'].stat().st_size,'statistics':imported['statistics'],'warnings':job['warnings']+import_job['warnings']})
        print('REAL_ROUNDTRIP='+json.dumps(evidence,ensure_ascii=False))

    def test_bad_glb_and_zip_rejected_before_worker(self):
        response=self.client.post('/api/previs/import',data={'file':(io.BytesIO(b'not a real glb'),'fake.glb')}); self.assertEqual(response.status_code,400)
        buffer=io.BytesIO()
        with zipfile.ZipFile(buffer,'w') as archive: archive.writestr('../secret','x')
        response=self.client.post('/api/previs/import',data={'file':(io.BytesIO(buffer.getvalue()),'evil.zip')}); self.assertEqual(response.status_code,400)

    def test_actual_previs_character_fbx_abc_and_focal_animation(self):
        source=Path(__file__).resolve().parents[1]/'diagnostics/previs-animated-export.glb'
        if not source.exists(): self.skipTest('Real editor export fixture not yet available')
        evidence=[]
        for format in ('fbx','abc'):
            with self.subTest(format=format):
                exported,job=self.job('export',source,format)
                camera=next(item for item in exported['statistics']['camera_lens'] if item['node']=='Lumen_ShotCamera')
                self.assertAlmostEqual(camera['start_mm'],35,places=3); self.assertAlmostEqual(camera['end_mm'],70,places=3)
                # A bare file tests native camera support separately from Lumen's
                # companion metadata (Blender 4.5 Alembic needs that companion).
                imported,returned=self.job('import',exported['local'])
                camera=next(item for item in imported['statistics']['camera_lens'] if item['node']=='Lumen_ShotCamera')
                self.assertAlmostEqual(camera['start_mm'],35,places=2)
                if format=='abc':
                    self.assertAlmostEqual(camera['end_mm'],35,places=2)
                    self.assertTrue(any('首帧焦距' in warning for warning in returned['warnings']))
                    imported,returned=self.job('import',exported['download'])
                    camera=next(item for item in imported['statistics']['camera_lens'] if item['node']=='Lumen_ShotCamera')
                self.assertAlmostEqual(camera['end_mm'],70,places=2)
                gltf=glb_json(imported['local']); self.assertTrue(gltf.get('animations')); self.assertGreater(len(gltf['nodes']),100)
                required={('Lumen_0_57','rotation'),('Lumen_0_216','translation'),('Lumen_1_0','translation'),('Lumen_2_0','translation'),('Lumen_ShotCamera','translation')}
                self.assertTrue(required.issubset(moving_targets(imported['local'])),required-moving_targets(imported['local']))
                evidence.append({'format':format,'size_bytes':exported['local'].stat().st_size,'statistics':imported['statistics'],'native_focal_roundtrip':format=='fbx','sidecar_required_for_focal':format=='abc','checked_motion_targets':sorted(required),'warnings':job['warnings']+returned['warnings']})
        output=Path(__file__).resolve().parents[1]/'diagnostics/previs-character-roundtrip.json'
        output.write_text(json.dumps(evidence,ensure_ascii=False,indent=2),encoding='utf-8')
        print('ACTUAL_CHARACTER_ROUNDTRIP='+json.dumps([{'format':item['format'],'camera_lens':item['statistics']['camera_lens'],'objects':item['statistics']['objects']} for item in evidence]))

    def test_queue_limit_and_cancellation(self):
        ids=[]
        for _ in range(4):
            response=self.client.post('/api/previs/import',data={'file':(io.BytesIO(self.input.read_bytes()),'scene.glb')})
            self.assertEqual(response.status_code,202,response.json); ids.append(response.json['job']['id'])
        rejected=self.client.post('/api/previs/import',data={'file':(io.BytesIO(self.input.read_bytes()),'scene.glb')})
        self.assertEqual(rejected.status_code,409,rejected.json)
        for job_id in ids: self.client.post('/api/previs/jobs/'+job_id+'/cancel')
        deadline=time.monotonic()+12
        while time.monotonic()<deadline:
            jobs=[self.client.get('/api/previs/jobs/'+job_id).json['job'] for job_id in ids]
            if all(job['status']=='cancelled' for job in jobs): break
            time.sleep(.1)
        self.assertTrue(all(job['status']=='cancelled' for job in jobs),jobs)

    def test_timeout_stops_blender_and_reports_failure(self):
        manager=bridge.manager_for(self.root/'library'); previous=manager.timeout; manager.timeout=.001
        try:
            response=self.client.post('/api/previs/import',data={'file':(io.BytesIO(self.input.read_bytes()),'scene.glb')}); job_id=response.json['job']['id']
            deadline=time.monotonic()+10
            while time.monotonic()<deadline:
                job=self.client.get('/api/previs/jobs/'+job_id).json['job']
                if job['status'] not in {'queued','running'}: break
                time.sleep(.1)
            self.assertEqual(job['status'],'failed',job); self.assertIn('已停止',job['error'])
        finally: manager.timeout=previous

if __name__=='__main__': unittest.main(verbosity=2)
