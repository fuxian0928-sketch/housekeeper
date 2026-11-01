"""No-device peer for early ASR failure recovery over real control pipes."""
import json
import sys
import time
from turn_segmenter import TurnSegmenter

def emit(event):
    print(json.dumps(event), flush=True)

segmenter=TurnSegmenter(emit, lambda *_: None)
segmenter.reset(1)
emit({'type':'ready'})
segmenter.wake(time.perf_counter())
for line in sys.stdin:
    command=json.loads(line)
    if command['type']=='stop':
        break
    if command['type']=='ping':
        emit({'type':'alive','token':command['token'],'workerClockMs':time.perf_counter()*1000})
    elif command['type']=='answer-failed':
        if not segmenter.fail_answer(command['generation'],command['turn'],time.perf_counter()):
            raise RuntimeError('failure recovery rejected')
    else:
        raise RuntimeError('unexpected command')
