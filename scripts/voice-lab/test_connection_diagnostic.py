import unittest
from unittest.mock import Mock
from connection_diagnostic import check_devices, describe_error


class ConnectionDiagnosticTests(unittest.TestCase):
    def audio(self):
        audio = Mock()
        audio.query_devices.return_value = [dict(name='麦克风 (Realtek)',hostapi=0,max_input_channels=1,default_samplerate=48000),
            dict(name='扬声器 (Realtek)',hostapi=0,max_output_channels=2,default_samplerate=48000)]
        audio.query_hostapis.return_value = [dict(name='Windows WASAPI')]
        return audio

    def test_enumeration_never_opens_a_stream_and_selected_endpoints_are_reported(self):
        audio = self.audio()
        result = check_devices(audio, lambda *_:(0,1), dict(inputName='mic',outputName='speaker'))
        self.assertTrue(result['selectionAccepted'])
        audio.Stream.assert_not_called()
        self.assertEqual(result['endpoints'][1]['defaultSampleRate'],48000)

    def test_silent_probe_uses_the_production_format_and_discards_input(self):
        audio = self.audio();audio.Stream.return_value = Mock(__enter__=Mock(),__exit__=Mock(return_value=False))
        result = check_devices(audio, lambda *_:(0,1), {}, open_stream=True)
        self.assertTrue(result['streamOpened'])
        args = audio.Stream.call_args.kwargs
        self.assertEqual((args['samplerate'],args['channels'],args['blocksize']),(16000,(1,2),160))
        private_input, output = Mock(), Mock()
        args['callback'](private_input,output,160,None,None)
        self.assertEqual(private_input.mock_calls,[])
        output.fill.assert_called_once_with(0)

    def test_portaudio_numeric_codes_are_retained_without_sensitive_exception_details(self):
        audio = self.audio()
        class PortAudioError(Exception): pass
        error = PortAudioError('PRIVATE device path and password',-9999,(13,-2147024891,'PRIVATE host error'))
        audio.Stream.side_effect = error
        result = check_devices(audio,lambda *_:(0,1),{},open_stream=True)
        self.assertFalse(result['streamOpened'])
        self.assertEqual(result['error'],dict(kind='PortAudioError',portAudioCode=-9999,hostErrorCode=-2147024891))
        self.assertNotIn('PRIVATE',str(result))
        self.assertEqual(describe_error(Exception('PRIVATE')),{'kind':'Exception'})


if __name__ == '__main__': unittest.main()
