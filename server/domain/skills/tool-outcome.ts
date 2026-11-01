export function unknownToolOutcome() {
  return Object.assign(new Error('请求已发出，但未确认执行结果。请先核对目标服务，勿重复执行。'), {code:'TOOL_OUTCOME_UNKNOWN',statusCode:502});
}
export function isUnknownToolOutcome(error:unknown):boolean {
  return !!error && typeof error==='object' && (error as {code?:unknown}).code==='TOOL_OUTCOME_UNKNOWN';
}
