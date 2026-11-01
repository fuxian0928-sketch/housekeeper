"""No-device test peer using the production segmenter and inherited pipes."""
import json
import sys
import time
from turn_segmenter import TurnSegmenter

def emit(event):
    print(json.dumps(event),flush=True)

def unexpected_audio(*_):
    raise RuntimeError('preview must not capture audio')

segmenter=TurnSegmenter(emit,unexpected_audio)
segmenter.reset(1)
emit({'type':'ready'})
for line in sys.stdin:
    command=json.loads(line)
    kind=command['type']
    if kind=='stop':
        break
    if kind=='ping':
        emit({'type':'alive','token':command['token'],'workerClockMs':time.perf_counter()*1000})
    elif kind=='voice-preview':
        segmenter.preview_voice(time.perf_counter())
    elif kind=='speaking':
        segmenter.speaking(command['generation'],command['turn'])
    elif kind=='dismiss-after-playback':
        segmenter.request_dismiss(command['generation'],command['turn'])
    elif kind=='dismiss':
        segmenter.dismiss()
    elif kind=='answer-finished':
        segmenter.finish_answer(command['generation'],command['turn'],time.perf_counter())
    else:
        raise RuntimeError('unexpected test command')
