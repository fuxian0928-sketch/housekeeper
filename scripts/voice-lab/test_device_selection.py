import unittest
from unittest.mock import Mock
from device_selection import select_endpoint, select_pair, list_devices, VoiceDeviceError

class SelectionTests(unittest.TestCase):
    def setUp(self):
        self.apis = [{'name': 'Windows WASAPI'}, {'name': 'MME'}]
        self.devices = [dict(name='Mic', hostapi=0, max_input_channels=1, max_output_channels=0),
                        dict(name='Speaker', hostapi=0, max_input_channels=0, max_output_channels=2),
                        dict(name='Speaker USB', hostapi=0, max_input_channels=0, max_output_channels=2),
                        dict(name='Speaker', hostapi=1, max_input_channels=0, max_output_channels=2)]
    def test_exact_match_precedes_partial_and_other_apis(self):
        self.assertEqual(select_endpoint(' speaker ', 'output', self.devices, self.apis), 1)
        self.assertEqual(select_endpoint('USB', 'output', self.devices, self.apis), 2)
    def test_ambiguous_missing_wrong_direction_and_channels_fail(self):
        for name, direction, code in [('Spea','output','AMBIGUOUS'),('Missing','input','MISSING'),('Mic','output','MISSING')]:
            with self.assertRaisesRegex(VoiceDeviceError, code):
                select_endpoint(name, direction, self.devices, self.apis)
        self.devices[1]['max_output_channels']=1
        with self.assertRaisesRegex(VoiceDeviceError, 'CHANNELS'):
            select_endpoint('Speaker','output',self.devices,self.apis)
    def test_identical_names_are_not_resolved_by_list_order(self):
        self.devices.append(dict(self.devices[0]))
        with self.assertRaisesRegex(VoiceDeviceError,'AMBIGUOUS'):
            select_endpoint('Mic','input',self.devices,self.apis)
    def test_list_marks_duplicate_and_mono_devices_unavailable(self):
        self.devices.append(dict(self.devices[0]))
        self.devices[1]['max_output_channels']=1
        audio=Mock();audio.query_devices.return_value=self.devices;audio.query_hostapis.return_value=self.apis
        result=list_devices(audio)
        self.assertEqual(result['inputs'],[{'name':'__system_default__','available':False},{'name':'Mic','available':False}])
        self.assertEqual(result['outputs'],[{'name':'__system_default__','available':False},{'name':'Speaker','available':False},{'name':'Speaker USB','available':True}])

    def test_system_defaults_use_wasapi_indices_even_when_names_repeat(self):
        self.apis[0].update(default_input_device=0, default_output_device=2)
        self.devices.append(dict(self.devices[0]))
        self.assertEqual(select_endpoint('__system_default__','input',self.devices,self.apis),0)
        self.assertEqual(select_endpoint('__system_default__','output',self.devices,self.apis),2)
        self.apis[0]['default_output_device']=3
        with self.assertRaisesRegex(VoiceDeviceError,'MISSING'):
            select_endpoint('__system_default__','output',self.devices,self.apis)

    def test_system_defaults_are_resolved_again_after_os_device_change(self):
        self.apis[0].update(default_input_device=0, default_output_device=1)
        audio=Mock();audio.query_devices.return_value=self.devices;audio.query_hostapis.return_value=self.apis
        self.assertEqual(select_pair(audio,'__system_default__','__system_default__'),(0,1))
        self.apis[0]['default_output_device']=2
        self.assertEqual(select_pair(audio,'__system_default__','__system_default__'),(0,2))

    def test_pair_uses_one_snapshot_and_does_not_open_stream(self):
        audio=Mock();audio.query_devices.return_value=self.devices;audio.query_hostapis.return_value=self.apis
        self.assertEqual(select_pair(audio,'Mic','Speaker'),(0,1))
        self.assertEqual([c[0] for c in audio.mock_calls],['query_devices','query_hostapis'])
        audio.query_devices.side_effect=Exception('private detail')
        with self.assertRaisesRegex(VoiceDeviceError,'^VOICE_NATIVE_DEVICE_ENUMERATION$'):
            select_pair(audio,'Mic','Speaker')

if __name__ == '__main__': unittest.main()
