"""Run with the configured Python: python -m unittest discover -s test -p '*_test.py'."""
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import types
import unittest
from unittest.mock import patch, Mock, MagicMock

spec = importlib.util.spec_from_file_location('bridge', Path(__file__).parents[1] / 'scripts' / 'analyze-video.py')
bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)


class BridgeTests(unittest.TestCase):
    def test_local_transcription_passes_language_and_model(self):
        module = types.ModuleType('video_analyzer.audio_processor')
        module.AudioProcessor = Mock()
        module.AudioProcessor.return_value.extract_audio.return_value = Path('audio.wav')
        module.AudioProcessor.return_value.transcribe.return_value = types.SimpleNamespace(text='你好', language='zh')
        with patch.dict(sys.modules, {'video_analyzer.audio_processor': module}):
            for language in ('auto', 'zh', 'en'):
                output = bridge.transcribe_video(Path('video.mp4'), Path('work'), dict(analysisLanguage=language, analysisWhisperModel='small'))
                module.AudioProcessor.assert_called_with(language=None if language == 'auto' else language, model_size_or_path='small', device='cpu')
                self.assertEqual(output.text, '你好')

    def cloud_fixture(self, directory):
        settings = dict(analysisAudioProvider='cloud', analysisLanguage='auto', analysisAudioUrl='https://voice.example/v1/', analysisAudioModel='speech-model', analysisAudioApiKey='voice-secret', analysisApiKey='vision-secret', analysisTimeoutSeconds=90)
        for index in range(2):
            (Path(directory) / f'speech-{index:04d}.wav').write_bytes(b'audio')
        requests = types.ModuleType('requests')
        requests.RequestException = type('RequestException', (Exception,), {})
        response = MagicMock(status_code=200)
        response.json.return_value = dict(text='你好', language='zh')
        requests.post = Mock(return_value=response)
        return settings, requests, response

    def test_cloud_chunks_credentials_language_and_progress(self):
        with tempfile.TemporaryDirectory() as work:
            settings, requests, response = self.cloud_fixture(work)
            events = []
            with patch.dict(sys.modules, {'requests': requests}), patch.object(bridge.subprocess, 'run') as run, patch.object(bridge, 'emit', events.append):
                output = bridge.transcribe_video(Path('video.mp4'), Path(work), settings)
                self.assertEqual(output.text, '你好\n你好')
                self.assertEqual(output.language, 'zh')
                self.assertEqual(requests.post.call_count, 2)
                args, kwargs = requests.post.call_args
                self.assertEqual(args[0], 'https://voice.example/v1/audio/transcriptions')
                self.assertEqual(kwargs['data'], dict(model='speech-model', response_format='json'))
                self.assertEqual(kwargs['headers'], {'Authorization': 'Bearer voice-secret'})
                self.assertFalse(kwargs['allow_redirects'])
                self.assertEqual(kwargs['timeout'], (10, 90))
                self.assertTrue(kwargs['files']['file'][1].closed)
                self.assertIn('600', run.call_args.args[0])
                self.assertEqual(events[-1], dict(type='progress', stage='audio_cloud', completed=2, total=2))
                settings['analysisLanguage'] = 'en'
                response.json.return_value = dict(text='hello')
                output = bridge.cloud_transcribe(Path('video.mp4'), Path(work), settings)
                self.assertEqual(requests.post.call_args.kwargs['data']['language'], 'en')
                self.assertEqual(output.language, 'en')
                settings['analysisLanguage'] = 'auto'
                self.assertIsNone(bridge.cloud_transcribe(Path('video.mp4'), Path(work), settings).language)

    def test_cloud_failures_are_sanitized_and_partial_transcripts_are_not_published(self):
        with tempfile.TemporaryDirectory() as work:
            settings, requests, response = self.cloud_fixture(work)
            with patch.dict(sys.modules, {'requests': requests}), patch.object(bridge.subprocess, 'run'), patch.object(bridge, 'emit'):
                for status in (302, 401, 413, 429, 500):
                    response.status_code = status
                    with self.assertRaisesRegex(RuntimeError, f'HTTP {status}'):
                        bridge.cloud_transcribe(Path('video.mp4'), Path(work), settings)
                response.status_code = 200
                response.json.return_value = {'wrong': 'format'}
                with self.assertRaisesRegex(RuntimeError, 'text'):
                    bridge.cloud_transcribe(Path('video.mp4'), Path(work), settings)
                response.json.side_effect = ValueError('secret body')
                with self.assertRaisesRegex(RuntimeError, '有效 JSON'):
                    bridge.cloud_transcribe(Path('video.mp4'), Path(work), settings)
                response.json.side_effect = None
                response.json.return_value = {'text': 'first chunk'}
                requests.post.side_effect = [response, requests.RequestException('voice-secret in request')]
                with self.assertRaisesRegex(RuntimeError, '云端语音请求失败') as error:
                    bridge.cloud_transcribe(Path('video.mp4'), Path(work), settings)
                self.assertNotIn('voice-secret', str(error.exception))

    def test_static_clip_falls_back_to_first_frame(self):
        from unittest.mock import Mock
        capture = Mock()
        capture.read.return_value = (True, object())
        cv2 = types.ModuleType('cv2')
        cv2.VideoCapture = Mock(return_value=capture)
        cv2.imwrite = Mock(return_value=True)
        frame = types.ModuleType('video_analyzer.frame')
        frame.Frame = lambda *args: args
        processor = Mock()
        processor.extract_keyframes.return_value = []
        with tempfile.TemporaryDirectory() as work, patch.dict(sys.modules, {'cv2': cv2, 'video_analyzer.frame': frame}):
            frames = bridge.extract_frames(processor, Path('static.mp4'), Path(work), 12)
            self.assertEqual(len(frames), 1)
            self.assertEqual(frames[0][2], 0.0)
            capture.release.assert_called_once()
            capture.read.return_value = (False, None)
            with self.assertRaises(RuntimeError):
                bridge.extract_frames(processor, Path('bad.mp4'), Path(work), 12)

    def test_labels_and_upstream_errors(self):
        self.assertEqual(bridge.parse_labels('```json\n{"keywords":["猫"],"tags":["宠物"]}\n```')['tags'], ['宠物'])
        for response in ({}, {'response': 'Error analyzing frame 1: bad key'}, {'response': ''}):
            with self.assertRaises(RuntimeError):
                bridge.response_text(response)
        with self.assertRaises(ValueError):
            bridge.parse_labels('{"keywords":[],"tags":["宠物"]}')

    def test_bridge_pipeline_and_audio_fallback(self):
        with tempfile.TemporaryDirectory() as work:
            package = Path(work) / 'package'
            (package / 'config').mkdir(parents=True)
            (package / 'config' / 'default_config.json').write_text('{"prompts":[]}', encoding='utf-8')
            calls = []
            class Client:
                def __init__(self, *args): calls.append(('client', args))
                def generate(self, **kwargs):
                    calls.append(('labels', kwargs['model']))
                    return {'response': '{"keywords":["猫"],"tags":["宠物"]}'}
            class Frames:
                def __init__(self, video, output, model): calls.append(('frames', model))
                def extract_keyframes(self, **kwargs):
                    calls.append(('limit', kwargs['max_frames']))
                    return [object(), object()]
            class Analyzer:
                def __init__(self, *args): pass
                def analyze_frame(self, frame): return {'response': '画面里有猫'}
                def reconstruct_video(self, frames, notes, transcript): return {'response': '猫在散步'}
            class Audio:
                def __init__(self, **kwargs): pass
                def extract_audio(self, *args): raise RuntimeError('no audio')
            package_mod = types.ModuleType('video_analyzer')
            package_mod.__file__ = str(package / '__init__.py')
            modules = {'video_analyzer': package_mod}
            for name, attrs in {
                'frame': {'VideoProcessor': Frames},
                'analyzer': {'VideoAnalyzer': Analyzer},
                'prompt': {'PromptLoader': lambda *args: None},
                'audio_processor': {'AudioProcessor': Audio},
                'clients.ollama': {'OllamaClient': Client},
                'clients.generic_openai_api': {'GenericOpenAIAPIClient': Client},
            }.items():
                mod = types.ModuleType('video_analyzer.' + name)
                mod.__dict__.update(attrs)
                modules[mod.__name__] = mod
            settings = dict(analysisModel='vision', analysisClient='ollama', analysisUrl='http://localhost:11434',
                            analysisMaxFrames=4, analysisAudio=True, analysisWhisperModel='base', analysisApiKey='private')
            events = []
            with patch.dict(sys.modules, modules), patch.object(bridge, 'emit', events.append):
                output = bridge.analyze(dict(settings=settings, target='video.mp4', workDir=work))
                self.assertEqual(output['description'], '猫在散步')
                self.assertEqual(output['keywords'], ['猫'])
                self.assertTrue(output['warnings'])
                self.assertIn(('limit', 4), calls)
                self.assertEqual([e['stage'] for e in events], ['loading', 'audio', 'extracting', 'frames', 'frames', 'frames', 'frames', 'description', 'labels'])
                self.assertNotIn('private', json.dumps(events))
                settings.update(analysisAudioProvider='cloud', analysisLanguage='zh', analysisAudioModel='cloud-model')
                with patch.object(bridge, 'cloud_transcribe', return_value=types.SimpleNamespace(text='云端转录', language='zh')):
                    cloud_output = bridge.analyze(dict(settings=settings, target='video.mp4', workDir=work))
                self.assertEqual(cloud_output['transcript'], '云端转录')
                self.assertEqual(cloud_output['transcriptLanguage'], 'zh')
                self.assertEqual(cloud_output['transcriptProvider'], 'cloud')
                self.assertEqual(cloud_output['transcriptModel'], 'cloud-model')
                with patch.object(bridge, 'cloud_transcribe', side_effect=RuntimeError('云端语音服务返回 HTTP 401')):
                    failed_audio = bridge.analyze(dict(settings=settings, target='video.mp4', workDir=work))
                self.assertEqual(failed_audio['transcript'], '')
                self.assertIn('云端语音转录失败', failed_audio['warnings'][0])
                settings.update(analysisClient='openai_api', analysisAudio=False)
                bridge.analyze(dict(settings=settings, target='video.mp4', workDir=work))
                self.assertIn(('client', ('private', 'http://localhost:11434')), calls)


if __name__ == '__main__':
    unittest.main()
