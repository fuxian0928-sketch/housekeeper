import '../../electron/startup.css';

/** Match the immediate Electron screen while the workbench bundle loads. */
export function StartupScreen(){
  return <main className="xiwei-startup">
    <section className="startup-surface" aria-label="希微正在启动">
      <h1>希微</h1>
      <p className="startup-purpose">事务、知识与日常</p>
      <div className="startup-state" role="status"><span className="startup-spinner" aria-hidden="true"/><span>正在打开工作台…</span></div>
    </section>
  </main>;
}
