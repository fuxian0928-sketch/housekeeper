/** A camera snapshot is requested only for an explicit question about the scene. */
export function wantsCameraObservation(text:string){
  return /(?:看(?:到|见|得见|得到|得清).{0,6}(?:我|这个|这|什么)|(?:看看|看一下|瞧瞧).{0,8}(?:我|这个|这|镜头|画面)|(?:我|手里|桌上|面前).{0,8}(?:穿|拿|放|什么颜色|是什么)|摄像头|镜头|小眼睛|当前画面)/.test(text);
}
