// Pure shared control grammar: only direct requests, never quoted/negated mentions.
export function isDismissCommand(text: string): boolean {
  const normalized = text.toLowerCase().replace(/[\s，。！？、,.!?]/g, '').replace(/^(.{2,8})\1$/u, '$1');
  // Realtime ASR sometimes renders a direct "退下" as "快点下去". Keep the
  // grammar anchored so a mention inside an ordinary request never dismisses.
  return /^(?:(?:希微|小e|小艺|小易|小伊){1,2})?(?:(?:好(?:的)?|嗯|行|那|可以){0,3})(?:请|麻烦)?(?:你)?(?:先)?(?:退下|离开|退下去|退一下|退后|快点下去|下去吧|去休息|休息去|结束对话|停止聊天|不用陪我了)(?:一下|一会儿)?(?:吧|啦|哦|了)?(?:不需要|不用了|不需要了)?$/.test(normalized);
}

export const IDLE_FAREWELL = '那主人继续忙吧，希微先退下啦，有事主人随时叫我哦';
export function computerControlCommand(text:string):'connect'|'disconnect'|null{
  const normalized=text.toLowerCase().replace(/[\s，。！？、,.!?]/g,'');
  const match=/^(?:(?:希微|小e){1,2})?(?:请|麻烦)?(?:你)?(连接本机|开启电脑控制|允许控制这台电脑|断开电脑控制|停止电脑控制)(?:吧)?$/.exec(normalized);
  if(!match)return null;return ['断开电脑控制','停止电脑控制'].includes(match[1])?'disconnect':'connect';
}

export function progressModeCommand(text: string): 'off' | 'concise' | 'detailed' | null {
  const value = text.toLowerCase().replace(/[\s，。！？、,.!?]/g, '');
  const match = /^(?:(?:希微|小e|小艺|小易|小伊){1,2})?(?:请|麻烦)?(?:你)?(?:先)?(关闭过程播报|不要播报过程|别播报过程|少说过程|简洁播报过程|开启过程播报|打开过程播报|详细播报过程|多说过程)(?:吧|啦|哦)?$/.exec(value);
  if (!match) return null;
  if (['关闭过程播报','不要播报过程','别播报过程'].includes(match[1])) return 'off';
  return ['详细播报过程','多说过程'].includes(match[1]) ? 'detailed' : 'concise';
}
