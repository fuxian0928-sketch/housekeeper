import assert from 'node:assert/strict';
import test from 'node:test';
import { isDismissCommand } from './voice-listening';
test('explicit dismiss commands and addressed variants',()=>{
 for(const text of ['退下','离开','希微，你先退下吧。','希微希微，请离开一下','小E，你先退下吧。','小艺小艺，请离开一下','去休息吧','结束对话','停止聊天']) assert.equal(isDismissCommand(text),true,text);
});
test('mentions and negations do not dismiss',()=>{
 for(const text of ['不要离开','别退下','我明天离开北京','退下是什么意思','他让我退下','你觉得我该离开吗','那主人继续忙吧，小e先退下啦，有事主人随时叫我哦']) assert.equal(isDismissCommand(text),false,text);
});
