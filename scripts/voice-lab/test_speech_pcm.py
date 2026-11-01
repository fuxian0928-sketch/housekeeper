import unittest
import numpy as np
from speech_pcm import SpeechPcmEdges, split_oversized_text, sentence_pause_ms

class SpeechPcmTests(unittest.TestCase):
    def test_semantic_boundary_pause_is_bounded_silence_without_respeeding(self):
        for text,ms in [('先核对资料，',120),('再给出结论。',220),('还没有说完',80)]:
            self.assertEqual(sentence_pause_ms(text),ms)
        for ms in (120,220):
            source=np.full(1600,.2,np.float32)
            edges=SpeechPcmEdges(target_pause_ms=ms)
            audio=np.concatenate([edges.push(source),edges.finish()])
            self.assertEqual(len(audio),1600+16*ms)
            np.testing.assert_array_equal(audio[80:1520],source[80:1520])
            self.assertTrue(np.all(audio[1600:]==0))
        for value in (-1,401,True):
            with self.assertRaises(ValueError):SpeechPcmEdges(target_pause_ms=value)
    def test_only_sentence_edges_are_tapered_and_interior_samples_are_exact(self):
        source=np.sin(np.arange(9000)*.13).astype(np.float32)*.25
        edges=SpeechPcmEdges();chunks=[]
        for chunk in np.array_split(source,11):chunks.append(edges.push(chunk))
        chunks.append(edges.finish());actual=np.concatenate(chunks)
        self.assertEqual(len(actual),len(source));np.testing.assert_array_equal(actual[80:-80],source[80:-80])
        self.assertEqual(actual[0],0);self.assertAlmostEqual(actual[-1],0)
    def test_trailing_digital_silence_is_bounded_without_removing_internal_pauses(self):
        speech=np.full(1600,.2,np.float32);source=np.concatenate([speech,np.zeros(2400,np.float32),speech,np.zeros(6400,np.float32)])
        edges=SpeechPcmEdges();chunks=[]
        for chunk in np.array_split(source,10):chunks.append(edges.push(chunk));self.assertLessEqual(len(edges.pending),8000)
        chunks.append(edges.finish());actual=np.concatenate(chunks)
        self.assertEqual(len(actual),1600+2400+1600+1280);np.testing.assert_array_equal(actual[1600:4000],np.zeros(2400))
        self.assertGreater(edges.trimmed_samples,0)
    def test_short_audio_is_released_at_eos_and_does_not_leak_into_next_sentence(self):
        e=SpeechPcmEdges();out=np.concatenate([e.push(np.full(40,.3)),e.finish()]);self.assertEqual(len(out),40)
        self.assertEqual(len(e.pending),0);other=SpeechPcmEdges();self.assertEqual(len(other.finish()),0)
    def test_upstream_segments_are_not_split_again_and_fallback_keeps_all_text(self):
        text='现在是2026-10-27 10:30，先核对资料，再完成整理。'
        self.assertEqual(list(split_oversized_text(text)),[text]);long=text*12
        segments=list(split_oversized_text(long));self.assertEqual(''.join(segments),long)
        self.assertTrue(all(len(s)<=160 for s in segments));self.assertTrue(any('2026-10-27' in s for s in segments))

if __name__=='__main__': unittest.main()
