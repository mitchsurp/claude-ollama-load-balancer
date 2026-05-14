const MAX_LOGS = 500;

const logs = [];

function log(entry) {
  logs.push({
    ...entry,
    time: new Date().toISOString(),
    id: logs.length,
  });
  if (logs.length > MAX_LOGS) logs.shift();
}

function getLogs(limit = 200) {
  return logs.slice(-limit);
}

export const logger = { log, getLogs };
