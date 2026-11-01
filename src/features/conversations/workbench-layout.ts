export const WORKBENCH_WIDTH_KEY = 'xiwei.workbench-pane-width.v2';
export const DEFAULT_PANE_WIDTH = 520;
export const COMPACT_WORKBENCH_WIDTH = 760;
export const PANE_ENTER_MS = 260;
export const PANE_EXIT_MS = 190;

export function clampPaneWidth(preferred: number, containerWidth: number) {
  const safe = Number.isFinite(preferred) ? preferred : DEFAULT_PANE_WIDTH;
  return Math.round(Math.max(300, Math.min(safe, Math.max(300, containerWidth - 370))));
}

export function readPaneWidth(storage: Pick<Storage, 'getItem'>) {
  try {
    const value = storage.getItem(WORKBENCH_WIDTH_KEY);
    const width = value === null ? NaN : Number(value);
    return Number.isFinite(width) && width >= 300 && width <= 3000 ? width : DEFAULT_PANE_WIDTH;
  } catch { return DEFAULT_PANE_WIDTH; }
}
