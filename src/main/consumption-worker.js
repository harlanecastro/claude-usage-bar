const { parentPort, workerData } = require('worker_threads');
const { ConsumptionStore } = require('./consumption-store');
const { ConsumptionIngest } = require('./consumption-ingest');
const { CodexConsumptionIngest } = require('./codex-consumption-ingest');

let retention = workerData.retention;
const store = new ConsumptionStore(workerData.dbPath, () => retention);
const ingests = [];
if (workerData.transcriptRoot !== null) {
  ingests.push(new ConsumptionIngest(store, () => retention, workerData.transcriptRoot));
}
if (workerData.codexRoot) {
  ingests.push(new CodexConsumptionIngest(store, () => retention, workerData.codexRoot));
}

for (const ingest of ingests) {
  ingest.on('changed', () => parentPort.postMessage({ type: 'changed' }));
}

async function reply(id, task) {
  try {
    const result = await task();
    parentPort.postMessage({ type: 'reply', id, result });
  } catch (error) {
    parentPort.postMessage({ type: 'reply', id, error: error.message });
  }
}

parentPort.on('message', (message) => {
  if (message.type === 'scan') {
    reply(message.id, async () => {
      const results = await Promise.all(ingests.map((ingest) => ingest.scan()));
      return {
        changed: results.reduce((sum, result) => sum + (Number(result?.changed) || 0), 0),
        files: results.reduce((sum, result) => sum + (Number(result?.files) || 0), 0),
      };
    });
  } else if (message.type === 'retention') {
    retention = message.value;
    reply(message.id, async () => {
      const pruned = store.prune(true);
      // Raising either limit can make transcript rows that were previously
      // skipped eligible again, so revisit complete files immediately instead
      // of waiting for the periodic scan.
      const scans = await Promise.all(ingests.map((ingest) => ingest.updateRetention()));
      return {
        ...pruned,
        changed: scans.reduce((sum, result) => sum + (Number(result?.changed) || 0), 0),
        files: scans.reduce((sum, result) => sum + (Number(result?.files) || 0), 0),
      };
    });
  } else if (message.type === 'window') {
    reply(message.id, () => {
      store.recordWindow(message.value);
      return true;
    });
  } else if (message.type === 'stop') {
    reply(message.id, async () => {
      await Promise.all(ingests.map((ingest) => ingest.stop()));
      store.close();
      return true;
    });
  }
});

for (const ingest of ingests) ingest.start();
parentPort.postMessage({ type: 'ready' });
