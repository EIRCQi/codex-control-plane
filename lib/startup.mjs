export function startupErrorMessage(error, port) {
  if(error?.code==='DATA_DIR_LOCKED')return '数据目录已被执行器占用，或无法确认锁的归属。请先正常退出原执行器再启动；更换端口不能共用同一数据目录。';
  if (error?.code === "EADDRINUSE") {
    return [
      `Port ${port} is already in use. Codex Control Plane may already be running.`,
      `Open http://127.0.0.1:${port} or inspect the process with: lsof -nP -iTCP:${port} -sTCP:LISTEN`,
      `To use another port: PORT=${port + 1} npm start`,
    ].join("\n");
  }
  return `Failed to start Codex Control Plane: ${error?.message || String(error)}`;
}
