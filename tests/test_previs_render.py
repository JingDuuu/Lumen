"""Fixed-duration PNG sequence encoding, temporary input directory only."""
import io
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch
import av
from PIL import Image
from werkzeug.datastructures import MultiDict
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
import app as backend
import lumen_core as core
import previs_render


def png(color=(20,50,80),size=(320,180)):
    output=io.BytesIO();Image.new('RGB',size,color).save(output,format='PNG');return output.getvalue()


class RenderVideoTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup);self.root=Path(self.temp.name)
        context=patch.object(core,'INPUT_DIR',str(self.root));context.start();self.addCleanup(context.stop)
        config=patch.dict(backend.app.config,TESTING=True);config.start();self.addCleanup(config.stop);self.client=backend.app.test_client()

    def post(self,frames,fps=24):
        data=MultiDict([('fps',str(fps))]+[('frames',(io.BytesIO(content),name)) for name,content in frames])
        response=self.client.post('/api/previs/render-video',data=data,content_type='multipart/form-data')
        response.request.environ['wsgi.input'].close();return response

    def test_real_48_frames_are_exactly_two_seconds(self):
        frames=[(f'frame{index:06d}.png',png((index*4,50,80))) for index in range(48)]
        response=self.post(list(reversed(frames)));self.assertEqual(response.status_code,200,response.json)
        result=response.json;self.assertEqual(result['frames'],48);self.assertEqual(result['duration'],2);self.assertEqual(result['fps'],24)
        output=self.root/result['name'];self.assertTrue(output.is_file());self.assertEqual(output.suffix,'.mp4')
        with av.open(str(output)) as container:
            stream=container.streams.video[0];self.assertEqual(stream.codec_context.name,'h264');self.assertEqual(float(stream.average_rate),24)
            decoded=list(container.decode(video=0));self.assertEqual(len(decoded),48);self.assertAlmostEqual(float(stream.duration*stream.time_base),2,places=6)
            self.assertAlmostEqual(float(decoded[0].pts*decoded[0].time_base),0,places=6);self.assertAlmostEqual(float(decoded[-1].pts*decoded[-1].time_base),47/24,places=6)
            self.assertLess(decoded[0].to_image().getpixel((10,10))[0],10);self.assertGreater(decoded[-1].to_image().getpixel((10,10))[0],175)
        self.assertEqual([path.name for path in self.root.iterdir()],[result['name']])

    def test_invalid_and_partial_frames_leave_no_output(self):
        for frames in [[],[('frame000001.png',png())],[('frame000000.png',png()),('frame000000.png',png())],[('../frame000000.png',png())],[('frame000000.png',b'not PNG')],[('frame000000.png',png()),('frame000001.png',b'broken')],[('frame000000.png',png(size=(320,180))),('frame000001.png',png(size=(322,180)))]]:
            with self.subTest(names=[name for name,_ in frames]):
                response=self.post(frames);self.assertEqual(response.status_code,400,response.json);self.assertEqual(list(self.root.iterdir()),[])

    def test_pixel_count_frame_count_fps_and_duration_bounds(self):
        for size in [(962,540),(960,542),(321,180),(320,181)]:
            response=self.post([('frame000000.png',png(size=size))]);self.assertEqual(response.status_code,400,response.json)
        for fps in [0,31,'24.5','bad']:
            response=self.post([('frame000000.png',png())],fps);self.assertEqual(response.status_code,400,response.json)
        response=self.post([(f'frame{index:06d}.png',png(size=(2,2))) for index in range(361)]);self.assertEqual(response.status_code,400)
        response=self.post([(f'frame{index:06d}.png',png(size=(2,2))) for index in range(16)],1);self.assertEqual(response.status_code,400)
        self.assertEqual(list(self.root.iterdir()),[])

    def test_byte_limits_and_busy_encoder_are_explicit(self):
        response=self.post([('frame000000.png',b'x'*(previs_render.MAX_FRAME_BYTES+1))]);self.assertEqual(response.status_code,413,response.json)
        with patch.object(previs_render,'MAX_TOTAL_BYTES',100):
            response=self.post([('frame000000.png',png())]);self.assertEqual(response.status_code,413)
        previs_render._ENCODING.acquire()
        try:
            response=self.post([('frame000000.png',png())]);self.assertEqual(response.status_code,409,response.json)
        finally:previs_render._ENCODING.release()
        self.assertEqual(list(self.root.iterdir()),[])

    def test_final_atomic_move_failure_cleans_temp_and_releases_encoder(self):
        with patch.object(previs_render.os,'replace',side_effect=OSError('disk unavailable')):
            response=self.post([('frame000000.png',png())]);self.assertEqual(response.status_code,503,response.json)
        self.assertEqual(list(self.root.iterdir()),[])
        response=self.post([('frame000000.png',png())]);self.assertEqual(response.status_code,200,response.json)

if __name__=='__main__':unittest.main(verbosity=2)
