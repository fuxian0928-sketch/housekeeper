import {memo, useEffect, useRef, useState, type RefObject} from 'react';
import {SeatedModelRenderer} from '../../../design/xiwei-character-source/seated-model/renderer.mjs';
import {HeadState} from '../../../design/xiwei-character-source/head-study/head-state.mjs';
import model from '../../../design/xiwei-character-source/seated-model/model.json';
import panorama from '../../../design/xiwei-character-source/seated-model/panoramic-cabin-v1.png';
import character from '../../../design/xiwei-character-source/seated-model/character-v1.png';
import closedEyes from '../../../design/xiwei-character-source/seated-model/eyes-closed-v1.png';
import openMouth from '../../../design/xiwei-character-source/seated-model/mouth-open-v1.png';
import originalArt from '../../../design/xiwei-character-source/seated-model/source-scene-v1.png';
import uniformArt from '../../../design/xiwei-character-source/seated-model/uniform-matte-v1.png';
import type {CompanionState} from '../companion/types';

type Props = {state: CompanionState; visible: boolean; motion: boolean; light: boolean; zoom: boolean; level: RefObject<{value: number; at: number}>};
const textures = {character, closedEyes, openMouth, originalArt, uniformArt};
export const PortraitStage = memo(function PortraitStage(props: Props) {
  const canvas = useRef<HTMLCanvasElement>(null), renderer = useRef<SeatedModelRenderer|null>(null);
  const latest = useRef(props); latest.current = props;
  const [status, setStatus] = useState<'loading'|'ready'|'failed'>('loading');
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const element = canvas.current;
    if (!element) return;
    let disposed = false, raf = 0, engine: SeatedModelRenderer|null = null;
    const head = new HeadState();
    const media = matchMedia('(prefers-reduced-motion: reduce)');
    let phase: CompanionState|null = null, nextBlink = 0, lastFrame = 0, visible = document.visibilityState === 'visible';
    const visibility = () => {visible = document.visibilityState === 'visible';};
    document.addEventListener('visibilitychange', visibility);
    const observer = new IntersectionObserver(([entry]) => {visible = entry.isIntersecting && document.visibilityState === 'visible';});
    observer.observe(element);
    setStatus('loading');
    void Promise.all(Object.entries(textures).map(async ([key, url]) => {
      const image = new Image(); image.decoding = 'async'; image.src = url; await image.decode();
      return [key, image] as const;
    })).then(entries => {
      if (disposed) return;
      engine = new SeatedModelRenderer(element, Object.fromEntries(entries) as Record<keyof typeof textures, HTMLImageElement>, model);
      renderer.current = engine;
      engine.setZoom(latest.current.zoom, {immediate: true});
      setStatus('ready');
      const render = (now: number) => {
        if (disposed) return;
        const p = latest.current, reduced = media.matches || !p.motion;
        if (p.state !== phase) {
          if (p.state === 'idle') head.sleep(now, reduced);
          else if (phase === null || phase === 'idle') head.wake(now, reduced);
          if (p.state === 'speaking' || p.state === 'notifying') {
            const token = head.preparePlayback(); if (token !== null) head.playbackStarted(token);
          } else if (p.state !== 'idle') head.cancelPlayback();
          phase = p.state; nextBlink = now + 3800;
        }
        if (visible && p.visible && now - lastFrame >= 1000 / 30) {
          if (!reduced && p.state !== 'idle' && now >= nextBlink) {head.blink(now); nextBlink = now + 4200 + Math.random() * 2400;}
          const rms = now - p.level.current.at < 260 ? p.level.current.value : 0;
          // Mouth follows confirmed device playback, never a text-length timer.
          const frame = head.tick(now, rms);
          engine!.draw(frame, {time: now / 1000, body: reduced ? 0 : .5, hair: reduced ? 0 : .38});
          lastFrame = now;
        }
        raf = requestAnimationFrame(render);
      };
      raf = requestAnimationFrame(render);
    }).catch(() => {if (!disposed) setStatus('failed');});
    return () => {disposed = true; cancelAnimationFrame(raf); observer.disconnect(); document.removeEventListener('visibilitychange', visibility); engine?.dispose(); if (renderer.current === engine) renderer.current = null;};
  }, [attempt]);
  useEffect(() => {renderer.current?.setZoom(props.zoom, {immediate: matchMedia('(prefers-reduced-motion: reduce)').matches});}, [props.zoom]);
  return <div className="portrait-world" data-light={props.light} aria-hidden={!props.visible}>
    <img className="portrait-panorama" src={panorama} alt=""/>
    <div className="portrait-character" data-ready={status === 'ready'}>
      <img className="portrait-fallback" src={originalArt} alt="希微坐在舱室椅子上"/>
      <canvas ref={canvas} aria-label="希微坐姿人物" role="img"/>
    </div>
    <div className="portrait-shade"/>
    {status === 'failed' ? <div className="portrait-load-message" role="status">当前显示静态立绘<button type="button" onClick={() => setAttempt(value => value + 1)}>重新载入动效</button></div> : null}
  </div>;
});
