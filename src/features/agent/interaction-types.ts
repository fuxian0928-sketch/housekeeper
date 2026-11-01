export type NavigationTarget={kind:'project'|'document'|'task'|'page';id?:string;title:string};
export type NavigationRequest={id:string;token:string;target:NavigationTarget;deviceId?:string};
export type ComputerStatus={connected:boolean;connecting?:boolean;autoConnect?:boolean;active?:boolean;awaitingReceipt?:boolean;error?:string;deviceId?:string;driver?:unknown};
export type ComputerApi={status:()=>Promise<ComputerStatus>;connect:()=>Promise<ComputerStatus>;disconnect:()=>Promise<ComputerStatus>;setFocus:(target:NavigationTarget)=>Promise<unknown>;onNavigate:(listener:(request:NavigationRequest)=>void)=>()=>void;onVoiceActivity:(listener:(event:{conversationId:string;runId?:string})=>void)=>()=>void};
