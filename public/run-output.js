// Keep stored events intact; present completed agent messages as readable text.
export function agentOutput(raw = '') {
  const messages = [];
  for (const line of raw.split('\n')) {
    try {
      const event = JSON.parse(line);
      if (event.type === 'item.completed' && event.item?.type === 'agent_message' && typeof event.item.text === 'string') {
        messages.push(event.item.text);
      }
    } catch { /* Older runs may contain plain text. */ }
  }
  return messages.length ? messages.join('\n\n') : raw;
}
