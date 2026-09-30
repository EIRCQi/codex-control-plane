import {selectRunner} from './launcher.mjs';

// A quit request owns startup as well as the ready Runner. In particular, an
// import that completes after quit must still hand over its shutdown operation.
export function createDesktopRunner({port, select=selectRunner, load=()=>import('../server.mjs')}) {
  let stopping=false, starting=null, closing=null, owned=null, ownedStop=null;
  const stopOwned=()=>owned ? (ownedStop ||= Promise.resolve().then(()=>owned.shutdown())) : null;
  return {
    get stopping() {return stopping;},
    start() {
      if(stopping)return Promise.resolve(null);
      return starting ||= select({port, start:async()=>{
        if(stopping)throw new Error('Desktop runner is stopping');
        owned=await load();
        if(stopping)void stopOwned().catch(()=>{});
        const ready=await owned.serverReady;
        return {url:ready.url,shutdown:owned.shutdown};
      }}).then(selected=>stopping ? null : selected);
    },
    shutdown() {
      if(closing)return closing;
      stopping=true;
      // Cancel known startup work before waiting for it. Startup also calls
      // stopOwned if quit arrived while the module import was still pending.
      void stopOwned()?.catch(()=>{});
      closing=(async()=>{
        await starting?.catch(()=>{});
        await stopOwned();
      })();
      return closing;
    },
  };
}

export function trayMenu({ visible, reused = false }) {
  return [
    { id: "status", label: reused ? "已连接现有执行器" : "本地执行器运行中", enabled: false },
    { type: "separator" },
    { id: "toggle", label: visible ? "隐藏控制台" : "显示控制台" },
    { id: "browser", label: "在浏览器中打开" },
    { type: "separator" },
    { id: "quit", label: reused ? "退出窗口（保留执行器）" : "退出" },
  ];
}

export function desktopWindowOptions(icon) {
  return {
    width: 1380,
    height: 900,
    minWidth: 980,
    minHeight: 680,
    backgroundColor: "#090d12",
    icon,
    show: false,
    title: "Codex 控制台",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  };
}
