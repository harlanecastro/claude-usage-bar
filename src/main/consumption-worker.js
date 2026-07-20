const { parentPort, workerData } = require('worker_threads');
const { ConsumptionStore } = require('./consumption-store');
const { ConsumptionIngest } = require('./consumption-ingest');

let retention = workerData.retention;
const store = new ConsumptionStore(workerData.dbPath, () => retention);
const ingest = new ConsumptionIngest(store, () => retention, workerData.transcriptRoot);

ingest.on('changed', () => parentPort.postMessage({ type: 'changed' }));

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
    reply(message.id, () => ingest.scan());
  } else if (message.type === 'retention') {
    retention = message.value;
    reply(message.id, async () => {
      const pruned = store.prune(true);
      // Raising either limit can make transcript rows that were previously
      // skipped eligible again, so revisit complete files immediately instead
      // of waiting for the periodic scan.
      const scanned = await ingest.updateRetention();
      return { ...pruned, changed: scanned.changed, files: scanned.files };
    });
  } else if (message.type === 'window') {
    reply(message.id, () => {
      store.recordWindow(message.value);
      return true;
    });
  } else if (message.type === 'stop') {
    reply(message.id, async () => {
      await ingest.stop();
      store.close();
      return true;
    });
  }
});

ingest.start();
parentPort.postMessage({ type: 'ready' });
