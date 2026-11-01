"""Offline synthetic-audio wake configuration check; never opens audio devices."""
import argparse
import audioop
import json
from pathlib import Path
from unittest.mock import patch
import wave
import numpy as np
from duplex_runtime import DuplexEngine


def check(model,keywords,audio):
    with wave.open(str(audio)) as source:
        if source.getnchannels()!=1 or source.getsampwidth()!=2:raise ValueError('Mono PCM16 required')
        pcm,_=audioop.ratecv(source.readframes(source.getnframes()),2,1,source.getframerate(),16000,None)
    samples=np.frombuffer(pcm,'<i2').astype(np.float32)/32768
    samples=np.concatenate([np.zeros(16000,np.float32),samples,np.zeros(32000,np.float32)])
    samples=np.pad(samples,(0,(-len(samples))%160))
    now=[0.0];events=[];delivered=[0]
    def sink(g,t,pcm,captured_at):delivered[0]+=len(pcm)
    engine=DuplexEngine(model,keywords,events.append,audio_sink=sink)
    try:
        with patch('duplex_runtime.time.perf_counter',lambda:now[0]):
            for offset in range(0,len(samples),160):
                now[0]=offset/16000
                engine.process((0,now[0],samples[offset:offset+160],np.zeros(160,np.float32)))
        wakes=[event for event in events if event['type']=='wake']
        turns=[event for event in events if event['type']=='turn-start']
        return {'wakeCount':len(wakes),'turnCount':len(turns),'firstTurnReason':turns[0]['reason'] if turns else None,'deliveredBytes':delivered[0]}
    finally:engine.close()


if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('model',type=Path);parser.add_argument('matrix',type=Path);parser.add_argument('report',type=Path);args=parser.parse_args()
    cases=json.loads(args.matrix.read_text('utf-8'));results=[]
    for case in cases:
        result=check(args.model,Path(case['keywords']),Path(case['audio']))
        passed=(result['wakeCount']==(1 if case['expectedWake'] else 0) and result['turnCount']==(1 if case['expectedWake'] else 0))
        results.append({'case':case['id'],'expectedWake':case['expectedWake'],'passed':passed,**result})
    report={'synthetic':True,'audioDevicesOpened':False,'results':results,'allPassed':all(row['passed'] for row in results)}
    args.report.write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
    print(json.dumps(report,ensure_ascii=False))
    if not report['allPassed']:raise SystemExit(1)
