export function trayMenu({ visible }) {
  return [
    { id: "status", label: "Local runner active", enabled: false },
    { type: "separator" },
    { id: "toggle", label: visible ? "Hide Control Plane" : "Show Control Plane" },
    { id: "browser", label: "Open in browser" },
    { type: "separator" },
    { id: "quit", label: "Quit" },
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
