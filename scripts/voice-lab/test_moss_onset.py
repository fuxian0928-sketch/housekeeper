"""Generation continuity across bounded onset and optimized body sampling."""
import copy
from types import SimpleNamespace
import unittest
import numpy as np
from moss_ort_runtime import OrtCpuRuntime


class Session:
    def __init__(self, runtime, prefill=False):
        self.runtime, self.prefill = runtime, prefill
    def get_outputs(self):
        return [SimpleNamespace(name='global_hidden')]
    def run(self, _outputs, feeds):
        if self.prefill:
            self.runtime.position = 0
        else:
            self.runtime.context_lengths.append(int(feeds['past_valid_lengths'][0]))
            self.runtime.position += 1
        return [np.full((1, 1, 2), self.runtime.position, np.float32)]


def fixture(length=4):
    runtime = OrtCpuRuntime.__new__(OrtCpuRuntime)
    runtime.manifest = {
        'generation_defaults': {'max_new_frames': 20, 'do_sample': True, 'sample_mode': 'fixed',
            'text_temperature': 1, 'text_top_k': 2, 'text_top_p': 1,
            'audio_temperature': .8, 'audio_top_k': 25, 'audio_top_p': .95,
            'audio_repetition_penalty': 1.2},
        'tts_config': {'n_vq': 2, 'audio_pad_token_id': 1024,
            'audio_assistant_slot_token_id': 9, 'audio_end_token_id': 7}}
    runtime.tts_meta = {'onnx': {'prefill_output_names': ['global_hidden'],
        'decode_input_names': ['input_ids', 'past_valid_lengths'], 'decode_output_names': ['global_hidden']}}
    runtime.position = 0
    runtime.context_lengths, runtime.body, runtime.onset = [], [], []
    runtime.rng = np.random.default_rng(1234)
    runtime.sessions = {'prefill': Session(runtime, True), 'decode': Session(runtime),
        'local_cached_step': object(), 'local_fixed_sampled_frame': object()}
    runtime.create_empty_local_cached_past = lambda: {}
    def cached(global_hidden, **kwargs):
        position = int(global_hidden[0, 0])
        if kwargs['step_type'] == 0: runtime.onset.append(position)
        text_logits = np.full(12, -100, np.float32)
        text_logits[9 if position < length else 7] = 100
        audio_logits = np.array([[[0, 100, 0], [0, 0, 100]]], np.float32)
        return text_logits, audio_logits, {}
    runtime.run_local_cached_step = cached
    def fixed(global_hidden, *, previous_token_sets_by_channel):
        position = int(global_hidden[0, 0])
        runtime.body.append((position, copy.deepcopy(previous_token_sets_by_channel)))
        return position < length, [1, 2]
    runtime.run_local_fixed_sampled_frame = fixed
    return runtime


class OnsetTests(unittest.TestCase):
    rows = {'inputIds': [[1, 2, 3], [4, 5, 6]], 'attentionMask': [[1, 1]]}

    def test_onset_preserves_all_frames_cache_and_repetition_history(self):
        for mode in ('cached', 'optimized'):
            runtime = fixture()
            if mode == 'optimized':
                runtime.sessions['local_greedy_frame'] = object()
                def greedy(global_hidden, *, previous_token_sets_by_channel, repetition_penalty):
                    position = int(global_hidden[0, 0]); runtime.onset.append(position)
                    self.assertEqual(repetition_penalty, 1.2)
                    return True, [1, 2]
                runtime.run_local_greedy_frame = greedy
            settings = copy.deepcopy(runtime.manifest)
            sessions = runtime.sessions.copy()
            observed = []
            frames = runtime.generate_audio_frames(self.rows,
                on_frame=lambda all_frames, step, frame: observed.append((len(all_frames), step, frame.copy())),
                onset_frames=2)
            self.assertEqual(frames, [[1, 2]] * 4)
            self.assertEqual(runtime.onset, [0, 1])
            self.assertEqual([entry[0] for entry in runtime.body], [2, 3, 4])
            self.assertEqual(runtime.body[0][1], [{1}, {2}])
            self.assertEqual(runtime.context_lengths, [2, 3, 4, 5])
            self.assertEqual([item[:2] for item in observed], [(1, 0), (2, 1), (3, 2), (4, 3)])
            self.assertEqual(runtime.manifest, settings)
            self.assertEqual(runtime.sessions, sessions)

    def test_short_reply_keeps_eos_without_padding_out_the_onset_window(self):
        runtime = fixture(length=1)
        self.assertEqual(runtime.generate_audio_frames(self.rows, onset_frames=12), [[1, 2]])
        self.assertEqual(runtime.context_lengths, [2])
        self.assertEqual(runtime.body, [])

    def test_default_path_is_unchanged_and_invalid_budgets_fail_before_inference(self):
        runtime = fixture()
        self.assertEqual(runtime.generate_audio_frames(self.rows), [[1, 2]] * 4)
        self.assertEqual(runtime.onset, [])
        for budget in (-1, 17, True, .5):
            with self.assertRaises(ValueError): runtime.generate_audio_frames(self.rows, onset_frames=budget)


if __name__ == '__main__': unittest.main()
