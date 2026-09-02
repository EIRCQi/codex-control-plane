export function startupErrorMessage(error, port) {
  if (error?.code === "EADDRINUSE") {
    return [
      `Port ${port} is already in use. Codex Control Plane may already be running.`,
      `Open http://127.0.0.1:${port} or inspect the process with: lsof -nP -iTCP:${port} -sTCP:LISTEN`,
      `To use another port: PORT=${port + 1} npm start`,
    ].join("\n");
  }
  return `Failed to start Codex Control Plane: ${error?.message || String(error)}`;
}
