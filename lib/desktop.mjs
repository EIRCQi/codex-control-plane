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
