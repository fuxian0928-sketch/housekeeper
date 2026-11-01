export type PortraitFrame = {eye: number; mouth: number};
export type PortraitMotion = {time: number; body: number; hair: number};
export class SeatedModelRenderer {
  constructor(canvas: HTMLCanvasElement, images: Record<'character'|'closedEyes'|'openMouth'|'originalArt'|'uniformArt', HTMLImageElement>, model: unknown);
  draw(frame: PortraitFrame, motion: PortraitMotion): void;
  setZoom(value: boolean, options?: {immediate?: boolean}): void;
  animating(): boolean;
  pause(): void;
  dispose(): void;
}
