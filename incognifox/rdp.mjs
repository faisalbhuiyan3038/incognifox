// Firefox Remote Debugging Protocol client: length-prefixed JSON over a local TCP socket.
import net from 'node:net';

const EVENT_TYPES = new Set([
  'evaluationResult', 'tabListChanged', 'addonListChanged', 'workerListChanged', 'processListChanged',
  'serviceWorkerRegistrationListChanged', 'tabNavigated', 'frameUpdate', 'tabDetached', 'pageError', 'consoleAPICall',
  'resources-available-array', 'resources-updated-array', 'resources-destroyed-array', 'descriptor-destroyed',
  'target-available-form', 'target-destroyed-form', 'forwardingCancelled', 'rootAvailable',
]);

export class RDP {
  constructor(onEvent = () => {}, onClose = () => {}) {
    this.onEvent = onEvent;
    this.onClose = onClose;
    this.buffer = Buffer.alloc(0);
    this.pending = new Map();
    this.evaluations = new Map();
    this.earlyResults = new Map();
    this.alive = false;
  }

  connect(port, timeoutMs = 45000) {
    const deadline = Date.now() + timeoutMs;
    return new Promise((resolve, reject) => {
      const attempt = () => {
        const socket = net.connect(port, '127.0.0.1');
        socket.once('error', () => {
          if (Date.now() > deadline) reject(new Error('Timed out connecting to Firefox'));
          else setTimeout(attempt, 300);
        });
        socket.once('connect', () => {
          socket.removeAllListeners('error');
          socket.on('error', () => {});
          socket.on('close', () => this.handleClose());
          socket.on('data', (chunk) => this.handleData(chunk));
          this.socket = socket;
          this.alive = true;
          this.greeted = resolve;
        });
      };
      attempt();
    });
  }

  handleClose() {
    if (!this.alive) return;
    this.alive = false;
    const error = new Error('Firefox connection closed');
    for (const queue of this.pending.values()) for (const entry of queue) entry.reject(error);
    for (const entry of this.evaluations.values()) entry.reject(error);
    this.pending.clear();
    this.evaluations.clear();
    this.onClose();
  }

  handleData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      const colon = this.buffer.indexOf(0x3a);
      if (colon < 0) return;
      const length = parseInt(this.buffer.subarray(0, colon).toString(), 10);
      if (this.buffer.length < colon + 1 + length) return;
      const packet = JSON.parse(this.buffer.subarray(colon + 1, colon + 1 + length).toString('utf8'));
      this.buffer = this.buffer.subarray(colon + 1 + length);
      this.handlePacket(packet);
    }
  }

  handlePacket(packet) {
    if (this.greeted && packet.from === 'root' && packet.applicationType) {
      const greeted = this.greeted;
      this.greeted = null;
      greeted(packet);
      return;
    }
    if (packet.type === 'evaluationResult') {
      const entry = this.evaluations.get(packet.resultID);
      if (entry) {
        this.evaluations.delete(packet.resultID);
        entry.resolve(packet);
      } else {
        this.earlyResults.set(packet.resultID, packet);
      }
      return;
    }
    if (packet.type && EVENT_TYPES.has(packet.type)) {
      this.onEvent(packet);
      return;
    }
    const queue = this.pending.get(packet.from);
    if (!queue?.length) return;
    const { resolve, reject } = queue.shift();
    if (packet.error) reject(new Error(`${packet.error}: ${packet.message || ''}`));
    else resolve(packet);
  }

  send(to, type, extra = {}) {
    if (!this.alive) return Promise.reject(new Error('Firefox connection closed'));
    return new Promise((resolve, reject) => {
      if (!this.pending.has(to)) this.pending.set(to, []);
      this.pending.get(to).push({ resolve, reject });
      const body = Buffer.from(JSON.stringify({ to, type, ...extra }), 'utf8');
      this.socket.write(`${body.length}:`);
      this.socket.write(body);
    });
  }

  // For one-way requests, which Firefox never answers.
  post(to, type, extra = {}) {
    if (!this.alive) return;
    const body = Buffer.from(JSON.stringify({ to, type, ...extra }), 'utf8');
    this.socket.write(`${body.length}:`);
    this.socket.write(body);
  }

  // Evaluates text in a console actor. A returned promise is awaited by Firefox itself,
  // so nothing is left behind in the page's global scope.
  async evaluate(consoleActor, text, timeoutMs = 30000) {
    const { resultID } = await this.send(consoleActor, 'evaluateJSAsync', { text, eager: false, mapped: { await: true } });
    let timer;
    const result = this.earlyResults.get(resultID) || await Promise.race([
      new Promise((resolve, reject) => this.evaluations.set(resultID, { resolve, reject })),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`Evaluation timed out after ${timeoutMs} ms`)), timeoutMs); }),
    ]).finally(() => clearTimeout(timer));
    this.earlyResults.delete(resultID);
    if (result.exceptionMessage) throw new Error(gripToText(result.exceptionMessage));
    const value = result.result;
    if (value?.type === 'longString') return (await this.send(value.actor, 'substring', { start: 0, end: value.length })).substring;
    return value;
  }

  close() {
    try { this.socket?.destroy(); } catch { /* already closed */ }
  }
}

export function gripToText(grip) {
  if (grip === null || typeof grip !== 'object') return String(grip);
  if (grip.type === 'longString') return grip.initial;
  if (grip.type === 'undefined' || grip.type === 'null') return grip.type;
  return grip.preview?.text || grip.preview?.message || grip.class || JSON.stringify(grip).slice(0, 120);
}
