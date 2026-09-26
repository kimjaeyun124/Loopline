import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

export class CodexAppServer extends EventEmitter {
  constructor({ command = 'codex', cwd, env }) {
    super();
    this.command = command;
    this.cwd = cwd;
    this.env = env;
    this.child = null;
    this.ready = false;
    this.startPromise = null;
    this.nextRequestId = 1;
    this.pending = new Map();
    this.stderr = '';
    this.stopping = false;
  }

  async start() {
    if (this.ready && this.child && !this.child.killed) return;
    if (this.startPromise) return this.startPromise;

    this.startPromise = this.startProcess();
    try {
      await this.startPromise;
    } finally {
      this.startPromise = null;
    }
  }

  async startProcess() {
    this.stopping = false;
    this.stderr = '';
    let child;
    try {
      child = spawn(this.command, [
        'app-server',
        '--listen', 'stdio://',
        '-c', 'mcp_servers={}',
      ], {
        cwd: this.cwd,
        env: this.env,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (error) {
      throw this.processError(error);
    }
    this.child = child;

    const lines = createInterface({ input: child.stdout });
    lines.on('line', (line) => this.handleLine(line));
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => { this.stderr = (this.stderr + chunk).slice(-4000); });
    child.once('error', (error) => this.handleProcessFailure(error, child));
    child.once('close', (code, signal) => {
      const error = new Error(`Codex app-server가 종료되었습니다${code === null ? '' : ` (${code})`}${signal ? `: ${signal}` : ''}.`);
      this.handleProcessFailure(error, child);
    });

    try {
      await this.requestRaw('initialize', {
        clientInfo: {
          name: 'mosaic_desk',
          title: 'Mosaic Desk',
          version: '0.1.0',
        },
      }, 15_000);
      this.notifyRaw('initialized', {});
      this.ready = true;
    } catch (error) {
      child.kill('SIGTERM');
      throw error;
    }
  }

  processError(error) {
    const message = error?.code === 'ENOENT'
      ? 'Codex CLI를 찾을 수 없습니다. 연결 설정에서 설치 방법을 확인해 주세요.'
      : 'Codex app-server를 시작하지 못했습니다.';
    return Object.assign(new Error(message), { code: error?.code || 'APP_SERVER_ERROR' });
  }

  handleProcessFailure(error, child) {
    if (child !== this.child) return;
    this.ready = false;
    this.child = null;
    const failure = this.processError(error);
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(failure);
      this.pending.delete(id);
    }
    if (!this.stopping) this.emit('disconnect', failure);
  }

  handleLine(line) {
    if (!line.trim()) return;
    let message;
    try { message = JSON.parse(line); } catch { return; }

    if (Object.hasOwn(message, 'id') && !message.method) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(message.id);
      if (message.error) {
        pending.reject(new Error(message.error.message || 'Codex app-server 요청에 실패했습니다.'));
      } else {
        pending.resolve(message.result || {});
      }
      return;
    }

    if (message.method && Object.hasOwn(message, 'id')) {
      this.emit('serverRequest', message);
      return;
    }
    if (message.method) this.emit('notification', message);
  }

  async request(method, params = {}, timeoutMs = 30_000) {
    await this.start();
    return this.requestRaw(method, params, timeoutMs);
  }

  requestRaw(method, params = {}, timeoutMs = 30_000) {
    if (!this.child || this.child.killed || this.child.stdin.destroyed) {
      return Promise.reject(new Error('Codex app-server 연결이 닫혀 있습니다.'));
    }
    const id = this.nextRequestId++;
    const message = JSON.stringify({ method, id, params });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('Codex app-server 응답 시간이 초과되었습니다.'));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(message + '\n', (error) => {
        if (!error) return;
        const pending = this.pending.get(id);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pending.delete(id);
        pending.reject(this.processError(error));
      });
    });
  }

  notifyRaw(method, params = {}) {
    if (!this.child || this.child.killed || this.child.stdin.destroyed) return;
    this.child.stdin.write(JSON.stringify({ method, params }) + '\n');
  }

  respond(id, result = {}) {
    if (!this.child || this.child.killed || this.child.stdin.destroyed) return;
    this.child.stdin.write(JSON.stringify({ id, result }) + '\n');
  }

  respondError(id, code, message) {
    if (!this.child || this.child.killed || this.child.stdin.destroyed) return;
    this.child.stdin.write(JSON.stringify({ id, error: { code, message } }) + '\n');
  }

  stop() {
    this.stopping = true;
    this.ready = false;
    const child = this.child;
    this.child = null;
    if (child && !child.killed) child.kill('SIGTERM');
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error('Codex app-server가 종료되었습니다.'));
      this.pending.delete(id);
    }
  }
}
