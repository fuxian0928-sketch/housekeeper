"""Bounded end-to-end native audio experiment. Emits metadata only; no raw recording."""
import argparse
import base64
import audioop
import json
import queue as queues
from pathlib import Path
import sys
import threading
import time
import wave

import numpy as np
import psutil
import sounddevice as sd
from duplex_runtime import DuplexEngine, DuplexQueue
from playback_buffer import PlaybackBuffer
from worker_lifetime import WorkerLifetime
from wake_feedback import WakeFeedback
from turn_segmenter import TurnTiming
from interruption_control import pause_candidate
from device_selection import select_pair

class AudioCaptureStalled(RuntimeError):
    pass


def read_fixture(path):
    with wave.open(str(path)) as wav:
        if wav.getsampwidth() != 2 or wav.getnchannels() != 1:
            raise ValueError('Playback fixture must be mono PCM16')
        pcm, _ = audioop.ratecv(wav.readframes(wav.getnframes()), 2, 1, wav.getframerate(),16000,None)
    return np.frombuffer(pcm,'<i2').astype(np.float32)/32768


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--model',type=Path,required=True)
    parser.add_argument('--keywords',type=Path,default=Path(__file__).with_name('xiao-e-keywords.txt'))
    parser.add_argument('--input-name',required=True)
    parser.add_argument('--output-name',required=True)
    parser.add_argument('--seconds',type=int,choices=range(1,61),default=5)
    parser.add_argument('--continuous',action='store_true',help='Run until supervised stop; requires parent heartbeat')
    parser.add_argument('--play-fixture',type=Path)
    parser.add_argument('--control-stdin',action='store_true')
    parser.add_argument('--interruption-capture',action='store_true')
    parser.add_argument('--wake-feedback',action='store_true',help='Local expiring wake tone through the shared output/AEC path')
    parser.add_argument('--noise-suppression', action='store_true')
    parser.add_argument('--auto-gain', action='store_true')
    parser.add_argument('--echo-delay-ms', type=int, choices=range(0,251), default=44)
    parser.add_argument('--stream-pcm',action='store_true',help='Private inherited stdout PCM channel; never store stdout as diagnostics')
    parser.add_argument('--report',type=Path,required=True)
    args = parser.parse_args()
    if args.interruption_capture and (not args.control_stdin or not args.stream_pcm or args.play_fixture):
        parser.error('--interruption-capture requires controlled PCM transport and forbids fixtures')
    if args.continuous and (not args.control_stdin or args.play_fixture):
        parser.error('--continuous requires --control-stdin and forbids fixture playback')
    lifetime = None
    stop = threading.Event()
    streamed_playback = PlaybackBuffer()
    wake_feedback = WakeFeedback()
    ping_tokens = queues.Queue(maxsize=4)
    commands = queues.Queue(maxsize=16)
    pending_control = None
    def control():
        # Inherited stdin only. EOF/protocol errors stop the device owner.
        while not stop.is_set():
            line=sys.stdin.buffer.readline(10000)
            if not line or len(line)>=10000:
                stop.set()
                return
            try:
                command=json.loads(line)
                if command.get('type')=='ping':
                    if lifetime is not None:
                        lifetime.ping()
                    ping_tokens.put_nowait(command.get('token'))
                elif command.get('type') in ('interruption-resolve','configure-timing','configure-wake','manual-wake','manual-dismiss','voice-preview','answer-finished','answer-failed','speaking','dismiss','dismiss-after-playback','playback-begin','playback-audio','playback-end','playback-cancel','playback-pause','playback-resume'):
                    commands.put_nowait(command)
                else:
                    stop.set()
            except (ValueError,AttributeError,queues.Full):
                stop.set()

    events=[]
    output=queues.Queue(maxsize=256)
    output_fault=threading.Event()
    def writer():
        try:
            while True:
                message=output.get()
                if message is None:
                    return
                print(json.dumps(message),flush=True)
        except (OSError,ValueError):
            output_fault.set();stop.set()
    writer_thread=threading.Thread(target=writer,daemon=True)
    writer_thread.start()
    emit_lock=threading.Lock()
    frame_counts={}
    def emit(event):
        if args.wake_feedback:
            if event['type'] in ('turn-cancelled', 'standby'):
                wake_feedback.cancel()
            elif event['type'] == 'wake' or (event['type'] == 'listening' and event.get('reason') == 'manual-wake'):
                wake_feedback.trigger(event['generation'], time.perf_counter())
        if event['type'] in ('turn-start','turn-cancelled','standby'):
            streamed_playback.cancel()
        if event['type'] == 'interruption-cancelled':
            streamed_playback.resume(event['generation'],event['turn'],event['pauseId'])
        with emit_lock:
            key=(event.get('generation'),event.get('turn'))
            if event['type']=='turn-start':
                frame_counts.clear();frame_counts[key]=0
            if event['type']=='turn-end':
                event={**event,'frameCount':frame_counts.get(key,0)}
            # Bounded diagnostics: no unlimited event accumulation.
            if event['type'] not in ('audio','interruption-audio') and len(events)<256:
                events.append(event)
            try:
                output.put_nowait(event)
            except queues.Full:
                output_fault.set();stop.set()
    def audio_sink(generation,turn,pcm,captured_at):
        key=(generation,turn)
        sequence=frame_counts.get(key,0)
        frame_counts[key]=sequence+1
        if args.stream_pcm:
            emit({'type':'audio','generation':generation,'turn':turn,'sequence':sequence,'capturedAtMs':captured_at*1000,'pcm':base64.b64encode(pcm).decode('ascii')})
    if args.stream_pcm and not args.control_stdin:
        parser.error('--stream-pcm requires --control-stdin')
    def interruption_sink(generation,turn,pause_id,sequence,pcm,captured_at):
        emit(dict(type='interruption-audio',generation=generation,turn=turn,pauseId=pause_id,
                  sequence=sequence,capturedAtMs=captured_at*1000,pcm=base64.b64encode(pcm).decode('ascii')))
    if args.control_stdin:
        threading.Thread(target=control,daemon=True).start()
    queue=DuplexQueue()
    began=time.perf_counter()
    engine=DuplexEngine(args.model,args.keywords,emit,audio_sink=audio_sink,
                        delay_ms=args.echo_delay_ms, noise_suppression=args.noise_suppression, auto_gain=args.auto_gain,
                        interruption_sink=interruption_sink if args.interruption_capture else None)
    initialized_ms=(time.perf_counter()-began)*1000
    playback=read_fixture(args.play_fixture) if args.play_fixture else np.empty(0,np.float32)
    position=0
    playback_started=False
    callbacks=0
    status_count=0
    faults=[]
    max_rss=0
    future_adc_timestamps=0
    last_callback=None
    process=psutil.Process()

    def callback(indata,outdata,frames,timestamps,status):
        nonlocal position,callbacks,status_count,future_adc_timestamps,last_callback
        outdata.fill(0)
        if stop.is_set():
            raise sd.CallbackStop
        try:
            if frames!=160:
                raise ValueError('Unexpected WASAPI frame size')
            reference=streamed_playback.render(now=time.perf_counter(),
                output_underflow=status.output_underflow, input_overflow=status.input_overflow)
            if args.wake_feedback:
                reference = np.clip(reference + wake_feedback.render(engine.segmenter.generation, time.perf_counter()), -1, 1)
            size=min(160,len(playback)-position)
            if size>0:
                reference[:size]=playback[position:position+size]
                position+=size
            outdata[:,0]=reference
            outdata[:,1]=reference
            provider_age=timestamps.currentTime-timestamps.inputBufferAdcTime
            future_adc_timestamps+=provider_age<0
            # This WASAPI backend can report an ADC time in the future. Keep high-
            # resolution callback arrival as a conservative estimate, never a fake exact ADC time.
            captured_at=time.perf_counter()-max(0,provider_age)
            queue.push(captured_at,indata[:,0],reference,bool(status))
            callbacks+=1
            last_callback=time.perf_counter()
            status_count+=bool(status)
        except Exception:
            faults.append('CALLBACK_FAILED')
            stop.set()
            outdata.fill(0)
            raise sd.CallbackAbort

    stream=None
    failure=None
    runtime_start=time.perf_counter()
    try:
        if not stop.is_set():
            stream=sd.Stream(device=select_pair(sd, args.input_name, args.output_name),samplerate=16000,channels=(1,2),dtype='float32',blocksize=160,callback=callback,extra_settings=sd.WasapiSettings(auto_convert=True),latency='low')
            with stream:
                opened_at=time.perf_counter()
                lifetime=WorkerLifetime(seconds=args.seconds,continuous=args.continuous,controlled=args.control_stdin)
                emit({'type':'ready','sampleRate':16000,'frameMs':10,'aec':True,'noiseSuppression':args.noise_suppression,'autoGain':args.auto_gain,'echoDelayMs':args.echo_delay_ms,'hardwareAecVerified':False,'modelLoadMs':round(initialized_ms,2)})
                while not stop.is_set() and lifetime.running():
                    while not commands.empty():
                        command=commands.get_nowait()
                        if command['type'] == 'configure-timing':
                            engine.segmenter.configure(TurnTiming(min_voice=command.get('minSpeechMs',120)/1000, max_utterance=command.get('maxUtteranceSeconds',30), idle_seconds=command['idleSeconds'], end_silence=command['endSilenceMs']/1000, barge_in=command.get('bargeInEnabled',True), continuous=command.get('continuousEnabled',True), owner_managed=command.get('ownerManaged',False)))
                            continue
                        if command['type'] == 'configure-wake':
                            if type(command.get('enabled')) is not bool:
                                stop.set()
                                break
                            engine.wake_enabled = command['enabled']
                            continue
                        if command['type'] in ('manual-wake', 'manual-dismiss', 'voice-preview'):
                            streamed_playback.cancel()
                            pending_control = command['type']
                            continue
                        generation=command.get('generation')
                        turn=command.get('turn')
                        if type(generation) is int and type(turn) is int:
                            if command['type'] == 'interruption-resolve':
                                pause_id=command.get('pauseId')
                                if type(pause_id) is int and pause_id>0:
                                    engine.segmenter.resolve_interruption(generation,turn,pause_id,command.get('decision'),time.perf_counter())
                                continue
                            if command['type'].startswith('playback-'):
                                if generation!=engine.segmenter.generation or turn!=engine.segmenter.turn:
                                    continue
                                if args.play_fixture:
                                    raise ValueError('Cannot mix fixture and streamed playback')
                                kind=command['type']
                                accepted=False
                                if kind in ('playback-pause', 'playback-resume'):
                                    if kind == 'playback-pause' and args.interruption_capture:
                                        pause_candidate(engine.segmenter,streamed_playback,generation,turn,command.get('pauseId'),time.perf_counter())
                                    else:
                                        operation = streamed_playback.pause if kind == 'playback-pause' else streamed_playback.resume
                                        operation(generation,turn,command.get('pauseId'))
                                    continue  # Stale pause/resume cannot cancel live audio.
                                if kind=='playback-cancel':
                                    streamed_playback.cancel();accepted=True
                                elif kind=='playback-begin' and engine.segmenter.state in ('processing','speaking'):
                                    wake_feedback.cancel()
                                    accepted=streamed_playback.start(generation,turn)
                                    if accepted:
                                        playback_started=True
                                        engine.segmenter.speaking(generation,turn)
                                elif kind=='playback-audio':
                                    encoded=command.get('pcm','')
                                    if not isinstance(encoded,str) or len(encoded)>8600:
                                        raise ValueError('Invalid playback packet')
                                    pcm=base64.b64decode(encoded,validate=True)
                                    accepted=streamed_playback.append(generation,turn,command.get('sequence'),pcm)
                                elif kind=='playback-end':
                                    accepted=streamed_playback.end(generation,turn,command.get('sequence'))
                                if not accepted:
                                    streamed_playback.cancel()
                                    emit({'type':'playback-failed','generation':generation,'turn':turn,'code':'PLAYBACK_PACKET_REJECTED'})
                                continue
                            if generation!=engine.segmenter.generation or turn!=engine.segmenter.turn:
                                continue
                            if command['type']=='answer-finished':
                                streamed_playback.cancel()
                                engine.segmenter.finish_answer(generation,turn,time.perf_counter())
                            elif command['type']=='answer-failed':
                                streamed_playback.cancel()
                                engine.segmenter.fail_answer(generation,turn,time.perf_counter())
                            elif command['type']=='dismiss-after-playback':
                                engine.segmenter.request_dismiss(generation,turn)
                            elif command['type']=='speaking':
                                engine.segmenter.speaking(generation,turn)
                            elif generation==engine.segmenter.generation and turn==engine.segmenter.turn:
                                engine.segmenter.dismiss()
                    while not ping_tokens.empty():
                        emit({'type':'alive','token':ping_tokens.get_nowait(),'workerClockMs':time.perf_counter()*1000})
                    pause_event=streamed_playback.take_pause_event()
                    if pause_event:
                        kind,generation,turn,pause_id,rendered=pause_event
                        emit({'type':kind,'generation':generation,'turn':turn,'pauseId':pause_id,'renderedFrames':rendered})
                    completed=streamed_playback.take_completed()
                    progress=streamed_playback.take_progress()
                    if progress:
                        generation,turn,rendered=progress
                        emit({'type':'playback-progress','generation':generation,'turn':turn,'renderedFrames':rendered,'health':streamed_playback.health()})
                    if completed:
                        generation,turn,rendered=completed
                        emit({'type':'playback-submitted','generation':generation,'turn':turn,'renderedFrames':rendered,'health':streamed_playback.health()})
                    if not stream.active:
                        raise RuntimeError('Device stream stopped')
                    if time.perf_counter()-(last_callback if last_callback is not None else opened_at)>2:
                        raise AudioCaptureStalled('No device callbacks')
                    item=queue.pop()
                    if item is not None:
                        engine.process(item)
                    else:
                        time.sleep(.002)
                    if pending_control is not None and engine.segmenter.generation > 0:
                        streamed_playback.cancel()
                        if pending_control == 'manual-wake':
                            engine.segmenter.manual_wake(time.perf_counter())
                        elif pending_control == 'voice-preview':
                            engine.segmenter.preview_voice(time.perf_counter())
                        else:
                            engine.segmenter.dismiss()
                        pending_control = None
                    max_rss=max(max_rss,process.memory_info().rss)
    except Exception as error:
        failure=type(error).__name__
        # Report before native stream close, which itself may hang on a broken device.
        emit({'type':'stopped','failure':failure,'frames':engine.frames})
    finally:
        stop.set()
        streamed_playback.cancel()
        wake_feedback.cancel()
        if stream is not None and not stream.closed:
            stream.close()
        queue.clear()
        engine.close()
    if faults and failure is None:
        failure='AudioCallbackFailure'
    if output_fault.is_set():
        failure='OutputTransportFailure'
    report={'experiment':'integrated-wasapi-aec-kws','seconds':round(time.perf_counter()-runtime_start,3),'modelLoadMs':round(initialized_ms,2),'callbackCount':callbacks,'processedFrames':engine.frames,'streamStatusCount':status_count,'droppedFrames':queue.dropped,'engineResets':engine.resets,'failure':failure,'callbackFaults':faults,'maxRssMiB':round(max_rss/1024**2,2),'playback':'fixture' if args.play_fixture else 'silence','inputRecordingSaved':False,'streamsClosed':stream is None or stream.closed,'ringCleared':len(engine.session.ring)==0,'events':events,'limitations':['Short experiment; no hotplug or long-run proof','AEC delay configured; real acoustic quality unverified','No cloud ASR or conversation integration']}
    report['captureClock']='perf_counter callback arrival minus nonnegative provider age; estimate only'
    report['wakeFeedback'] = wake_feedback.report() if args.wake_feedback else None
    report['continuous']=args.continuous
    report['parentHeartbeatTimeoutSeconds']=5 if args.continuous else None
    if playback_started:
        report['playback']='streamed-pcm'
    report['futureAdcTimestamps']=future_adc_timestamps
    args.report.parent.mkdir(parents=True,exist_ok=True)
    args.report.write_text(json.dumps(report,indent=2),'utf-8')
    emit({'type':'stopped','failure':failure,'frames':engine.frames})
    try:
        output.put(None,timeout=.2)
    except queues.Full:
        failure='OutputTransportFailure'
    writer_thread.join(timeout=.5)
    if failure or faults:
        raise SystemExit(1)


if __name__=='__main__':
    main()
