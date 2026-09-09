export function trayMenu({ visible, reused = false }) {
  return [
    { id: "status", label: reused ? "Connected to existing Runner" : "Local runner active", enabled: false },
    { type: "separator" },
    { id: "toggle", label: visible ? "Hide Control Plane" : "Show Control Plane" },
    { id: "browser", label: "Open in browser" },
    { type: "separator" },
    { id: "quit", label: reused ? "Quit window (keep Runner)" : "Quit" },
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
    title: "Codex Control Plane",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  };
}
