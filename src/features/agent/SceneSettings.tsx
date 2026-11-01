import {useEffect, useState} from 'react';
import {StyledSelect} from '../../components/ui';
import {readScenePreferences, saveScenePreferences, subscribeScenePreferences} from './scene-preferences';
export function SceneSettings() {
  const [value, setValue] = useState(readScenePreferences);
  useEffect(() => subscribeScenePreferences(setValue), []);
  return <section className="companion-setting-stack scene-settings" aria-label="形象与场景">
    <label className="companion-choice"><span><strong>工作台外观</strong><small>切换外观保留当前语音与聊天。</small></span><StyledSelect aria-label="工作台外观" value={value.view} onChange={event => setValue(saveScenePreferences({view: event.target.value === 'voice' ? 'voice' : 'portrait'}))}><option value="portrait">人物与舱室</option><option value="voice">圆形语音</option></StyledSelect></label>
    <label className="companion-toggle"><span><strong>轻柔动态</strong><small>人物呼吸、发丝与自然眨眼。</small></span><input type="checkbox" checked={value.motion} onChange={event => setValue(saveScenePreferences({motion: event.target.checked}))}/></label>
    <label className="companion-toggle"><span><strong>舱室灯光</strong></span><input type="checkbox" checked={value.light} onChange={event => setValue(saveScenePreferences({light: event.target.checked}))}/></label>
  </section>;
}
