const path = require('path');
const { EventEmitter } = require('events');
const { Worker } = require('worker_threads');

const STOP_TIMEOUT_MS = 5000;
const TERMINATE_TIMEOUT_MS = 2000;

class ConsumptionService extends EventEmitter {
  constructor({ dbPath, retention, transcriptRoot }) {
    super();
    this.nextId = 1;
    this.pending = new Map();
    this.stopping = false;
    this.stopPromise = null;
    this.worker = new Worker(path.join(__dirname, 'consumption-worker.js'), {
      workerData: { dbPath, retention, transcriptRoot },
    });
    this.worker.on('message', (message) => this._message(message));
    this.worker.on('error', (error) => this.emit('error', error));
    this.worker.on('exit', (code) => {
      if (code && this.worker && !this.stopping) {
        this.emit('error', new Error(`ConsumptionWorkerExited:${code}`));
      }
      for (const { reject } of this.pending.values()) reject(new Error('ConsumptionWorkerStopped'));
      this.pending.clear();
      this.worker = null;
    });
  }

  _message(message) {
    if (message.type === 'changed') return this.emit('changed');
    if (message.type === 'ready') return this.emit('ready');
    if (message.type !== 'reply') return undefined;
    const pending = this.pending.get(message.id);
    if (!pending) return undefined;
    this.pending.delete(message.id);
    if (message.error) pending.reject(new Error(message.error));
    else pending.resolve(message.result);
    return undefined;
  }

  _request(type, value, allowWhileStopping = false) {
    if (this.stopping && !allowWhileStopping) {
      return Promise.reject(new Error('ConsumptionWorkerStopping'));
    }
    if (!this.worker) return Promise.reject(new Error('ConsumptionWorkerStopped'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try {
        this.worker.postMessage({ type, id, value });
      } catch (error) {
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  scan() {
    return this._request('scan');
  }

  updateRetention(value) {
    return this._request('retention', value);
  }

  recordWindow(value) {
    return this._request('window', value);
  }

  async stop() {
    if (this.stopPromise) return this.stopPromise;
    if (!this.worker) return undefined;
    this.stopping = true;
    const worker = this.worker;
    this.stopPromise = (async () => {
      let timeout;
      try {
        await Promise.race([
          this._request('stop', undefined, true),
          new Promise((_, reject) => {
            timeout = setTimeout(() => reject(new Error('ConsumptionWorkerStopTimeout')),
              STOP_TIMEOUT_MS);
            timeout.unref?.();
          }),
        ]);
      } catch {
        // Shutdown is best effort; termination below is the hard deadline.
      } finally {
        if (timeout) clearTimeout(timeout);
        try {
          const termination = worker.terminate();
          await Promise.race([
            termination,
            new Promise((resolve) => {
              const deadline = setTimeout(resolve, TERMINATE_TIMEOUT_MS);
              deadline.unref?.();
            }),
          ]);
        } catch { /* worker may already be gone */ }
        // A native SQLite call cannot always be interrupted mid-call. Do not let
        // that rare case hold the entire app open after both shutdown deadlines.
        worker.unref();
        if (this.worker === worker) this.worker = null;
      }
    })();
    return this.stopPromise;
  }
}

module.exports = { ConsumptionService };
