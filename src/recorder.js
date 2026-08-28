// src/recorder.js — 自动录像：进入世界即开录，按游戏日截帧，闪退也留半份
// frames 走 publicState()（上帝视角全量快照），logs 走 game 的 'log' 事件。

export class Recorder {
  constructor(game, opts = {}) {
    this.game = game;
    this.maxFrames = opts.maxFrames ?? 6000;
    this.maxLogs = opts.maxLogs ?? 20000;
    this.frames = [];
    this.logs = [];
    this.toolCalls = [];        // { t, label, ok, message } — 供修炼日记引用
    this.startedAt = null;
    this.stoppedAt = null;
    this._lastDay = -1;
    this._active = false;

    game.on('log', (entry) => {
      if (this._active) this.#pushLog(entry);
    });
    game.on('update', () => this.#maybeFrame());
  }

  #pushLog(entry) {
    this.logs.push({
      day: entry.day,
      t: entry.t,
      text: entry.text,
      type: entry.type,
    });
    if (this.logs.length > this.maxLogs) this.logs.splice(0, this.logs.length - this.maxLogs);
  }

  #maybeFrame() {
    if (!this._active) return;
    const day = Math.floor(this.game.state.world.gameDay);
    if (day !== this._lastDay) {
      this._lastDay = day;
      this.#snapshot();
    }
  }

  #snapshot() {
    try {
      const state = this.game.publicState();
      this.frames.push({
        day: Math.floor(this.game.state.world.gameDay),
        state,
      });
      if (this.frames.length > this.maxFrames) this.frames.splice(0, this.frames.length - this.maxFrames);
    } catch { /* 快照失败不影响游戏 */ }
  }

  recordToolCall(label, ok, message) {
    this.toolCalls.push({ t: Date.now(), label, ok: !!ok, message: message || '' });
    if (this.toolCalls.length > 2000) this.toolCalls.splice(0, this.toolCalls.length - 2000);
  }

  start() {
    if (this._active) return;
    this._active = true;
    this.startedAt = Date.now();
    this._lastDay = -1;
    this.#snapshot();
  }

  stop() {
    if (!this._active) return;
    this._active = false;
    this.stoppedAt = Date.now();
    this.#snapshot();
  }

  get active() { return this._active; }

  // 导出后清空，为下一次会话做准备
  reset() {
    this.frames = [];
    this.logs = [];
    this.toolCalls = [];
    this.startedAt = null;
    this.stoppedAt = null;
    this._lastDay = -1;
    this._active = false;
  }
}
