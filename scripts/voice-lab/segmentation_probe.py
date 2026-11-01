"""Offline native AEC/VAD/KWS -> streaming turn sink; synthetic input only."""
import audioop
import json
from pathlib import Path
import sys
from unittest.mock import patch
import wave
import numpy as np
from duplex_runtime import DuplexEngine

model,first,second,report=map(Path,sys.argv[1:5])
def read(path):
    with wave.open(str(path)) as wav:
        if wav.getnchannels()!=1 or wav.getsampwidth()!=2:raise ValueError('Expected mono PCM16')
        data,_=audioop.ratecv(wav.readframes(wav.getnframes()),2,1,wav.getframerate(),16000,None)
    return np.frombuffer(data,'<i2').astype(np.float32)/32768

first_samples=read(first)
second_samples=read(second)
audio=np.concatenate([np.zeros(16000,np.float32),first_samples,np.zeros(32000,np.float32),second_samples,np.zeros(32000,np.float32)])
audio=np.pad(audio,(0,(-len(audio))%160))
now=[0.0]
events=[]
pending=[]
delivered={}
def emit(event):
    events.append({**event,'inputTimeMs':round(now[0]*1000)})
    if event['type']=='turn-end':pending.append(event)
def sink(g,t,pcm,captured_at):
    delivered[f'{g}:{t}']=delivered.get(f'{g}:{t}',0)+len(pcm)
engine=DuplexEngine(model,Path(__file__).with_name('xiao-e-keywords.txt'),emit,audio_sink=sink)
with patch('duplex_runtime.time.perf_counter',lambda:now[0]):
    for offset in range(0,len(audio),160):
        now[0]=offset/16000
        engine.process((0,now[0],audio[offset:offset+160],np.zeros(160,np.float32)))
        while pending:
            event=pending.pop()
            engine.segmenter.finish_answer(event['generation'],event['turn'],now[0])
    engine.close()
result={'experiment':'native-synthetic-continuous-segmentation','synthetic':True,'events':events,'deliveredPcmBytesByTurn':delivered,'sourceDurationsSeconds':{'first':len(first_samples)/16000,'second':len(second_samples)/16000},'pcmPersisted':False,'limitations':['Simulated instant answer completion; no LLM/ASR/TTS','No hardware acoustic evidence']}
report.write_text(json.dumps(result,indent=2),'utf-8')
starts=[e for e in events if e['type']=='turn-start']
ends=[e for e in events if e['type']=='turn-end']
assert len(starts)==2 and len(ends)==2,result
assert starts[0]['reason']=='wake' and starts[1]['reason']=='speech',result
print(json.dumps({'passed':True,'turns':len(starts),'bytesByTurn':delivered}))
