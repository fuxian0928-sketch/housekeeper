export type ScenePreferences = { view: 'portrait' | 'voice'; motion: boolean; light: boolean };
const key = 'xiwei.scene.preferences.v1';
const eventName = 'xiwei:scene-preferences';
export function readScenePreferences(): ScenePreferences {
  try {
    const value = JSON.parse(localStorage.getItem(key) || '{}');
    return {view: value.view === 'voice' ? 'voice' : 'portrait', motion: value.motion !== false, light: value.light !== false};
  } catch { return {view: 'portrait', motion: true, light: true}; }
}
export function saveScenePreferences(changes: Partial<ScenePreferences>) {
  const next = {...readScenePreferences(), ...changes};
  try { localStorage.setItem(key, JSON.stringify(next)); } catch { /* In-memory changes still apply. */ }
  window.dispatchEvent(new CustomEvent<ScenePreferences>(eventName, {detail: next}));
  return next;
}
export function subscribeScenePreferences(listener: (value: ScenePreferences) => void) {
  const change = (event: Event) => listener((event as CustomEvent<ScenePreferences>).detail);
  const external = (event: StorageEvent) => {if (event.key === key) listener(readScenePreferences());};
  window.addEventListener(eventName, change);
  window.addEventListener('storage', external);
  return () => {window.removeEventListener(eventName, change); window.removeEventListener('storage', external);};
}
