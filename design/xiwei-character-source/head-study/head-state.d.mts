export class HeadState {
  phase: string;
  generation: number;
  preparePlayback(): number | null;
  playbackStarted(token: number): boolean;
  playbackEnded(token: number): boolean;
  cancelPlayback(): number;
  sleep(now: number, reduced?: boolean): void;
  wake(now: number, reduced?: boolean): void;
  blink(now: number): boolean;
  tick(now: number, rms?: number): {eye: number; mouth: number; animating: boolean};
}
