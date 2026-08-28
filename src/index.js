// src/index.js — dsh-xiuxian-world 插件入口
// 云仙大世界：DSH agent 下场修仙，功成身退自动出回放与日记。
// 引擎 in-process 运行（零端口零服务器），录像按游戏日自动截帧。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { Game } from '../engine/game.js';
import { Store } from '../engine/store.js';
import { AgentRunner } from '../engine/agent/runner.js';
import { Recorder } from './recorder.js';
import { Exporter } from './exporter.js';
import { buildTools } from './tools.js';

export const name = 'xiuxian-world';
export const inject = ['tools'];

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = path.resolve(__dirname, '..');

// 默认 NPC 修士（内置灵智，无 LLM 成本）
const NPC_PRESETS = [
  { name: '刻锱', path: 'sword', body: 11, comprehension: 9, luck: 8 },
  { name: '刻舟', path: 'array', body: 9, comprehension: 11, luck: 7 },
  { name: '求剑', path: 'sword', body: 12, comprehension: 8, luck: 9 },
  { name: '知秋', path: 'pill', body: 8, comprehension: 12, luck: 8 },
];

export function apply(ctx, config = {}) {
  const log = (...a) => console.log('[xiuxian-world]', ...a);

  // ---------- 世界启动（in-process，无服务器） ----------
  const dataDir = path.join(PKG_ROOT, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  const worldDef = JSON.parse(
    fs.readFileSync(path.join(PKG_ROOT, 'engine', 'worlds', 'xiuxian', 'world.json'), 'utf-8')
  );
  const store = new Store(dataDir);
  const game = new Game(worldDef, store);
  log(`世界「${worldDef.name}」已加载：${worldDef.areas.length} 地点 / ${worldDef.dungeons?.length || 0} 秘境`);
  if (game.state.created && Object.keys(game.state.agents).length) {
    log(`续接存档：${Object.keys(game.state.agents).length} 位修士`);
  }

  // ---------- 时间引擎 ----------
  const tickMs = Math.max(100, Number(config.tickMs) || 500);
  const tickTimer = setInterval(() => {
    try { game.tick(); } catch (e) { console.error('[xiuxian-world] tick error:', e.message); }
  }, tickMs);
  tickTimer.unref?.();

  // ---------- NPC（内置灵智，零成本） ----------
  const npcRunners = [];
  const npcCount = Math.max(0, Number(config.npcCount ?? 4));
  const npcIntervalSec = Math.max(10, Number(config.npcIntervalSec ?? 30));

  function attachNpcRunner(agentId, name) {
    const runner = new AgentRunner(game, null);
    runner.agentId = agentId;
    runner.config.persona = name;
    runner.config.intervalSec = npcIntervalSec;
    runner.start();
    npcRunners.push(runner);
  }

  const existingAgents = game.allAgents();
  if (existingAgents.length === 0 && npcCount > 0) {
    for (const p of NPC_PRESETS.slice(0, npcCount)) {
      const id = randomUUID();
      game.createAgent(id, { ...p, clientLabel: '内置灵智' });
      attachNpcRunner(id, p.name);
    }
    log(`已降临 ${Math.min(npcCount, NPC_PRESETS.length)} 位内置修士（内置灵智）`);
  } else {
    // 存档恢复：给内置修士重新接上灵智
    let revived = 0;
    for (const a of existingAgents) {
      if (!a.dead && a.clientLabel === '内置灵智') {
        attachNpcRunner(a.id, a.name);
        revived++;
      }
    }
    if (revived) log(`为 ${revived} 位内置修士重接元神`);
  }

  // ---------- DSH agent <-> 修士 绑定（持久化） ----------
  const bindingsFile = path.join(dataDir, 'dsh-bindings.json');
  const bindings = new Map();
  try {
    const saved = JSON.parse(fs.readFileSync(bindingsFile, 'utf-8'));
    for (const [k, v] of Object.entries(saved || {})) bindings.set(k, v);
  } catch { /* 无存档 */ }
  const saveBindings = () => {
    try {
      fs.writeFileSync(bindingsFile, JSON.stringify(Object.fromEntries(bindings), null, 1));
    } catch (e) { console.error('[xiuxian-world] bindings save failed:', e.message); }
  };

  // ---------- 录像 + 导出 ----------
  const recorder = new Recorder(game);
  const exporter = new Exporter(game, recorder, dataDir);

  // ---------- 会话追踪 ----------
  const sessions = new Map(); // dshKey -> { agentId, lastActive }
  const idleMs = Math.max(1, Number(config.idleMinutes ?? 20)) * 60_000;

  const world = {
    game, recorder, exporter, bindings, saveBindings, sessions,
    touchSession(key, agentId) {
      const now = Date.now();
      const s = sessions.get(key);
      if (s) { s.lastActive = now; return; }
      sessions.set(key, { agentId, lastActive: now });
      recorder.start();
      log(`修士会话开始：${key.slice(0, 12)}…`);
    },
    endSession(key) {
      sessions.delete(key);
      if (sessions.size === 0) recorder.stop();
      log(`修士会话结束（剩余 ${sessions.size}）`);
    },
  };

  // ---------- 注册工具 ----------
  const tools = buildTools(world);
  for (const t of tools) ctx.tools.register(t);
  log(`已注册 ${tools.length} 个修仙工具（xiuxian_*）`);

  // ---------- 空闲自动收工 ----------
  const sweepTimer = setInterval(() => {
    const now = Date.now();
    for (const [key, s] of sessions) {
      if (now - s.lastActive < idleMs) continue;
      const agent = game.getAgent(s.agentId);
      const name = agent?.name || '无名修士';
      if (agent && !agent.dead) game.setAgentOffline(s.agentId, '云游归来');
      log(`会话空闲超时，自动收工：${name}`);
      exporter.exportSession({ dshAgentKey: key, agentName: name, summary: '（空闲自动收工）' });
      sessions.delete(key);
    }
    if (sessions.size === 0 && recorder.active) recorder.stop();
  }, 60_000);
  sweepTimer.unref?.();

  // ---------- 插件卸载：收尾 ----------
  ctx.on('dispose', () => {
    clearInterval(tickTimer);
    clearInterval(sweepTimer);
    for (const r of npcRunners) { try { r.stop('world closed'); } catch { /* ignore */ } }
    // 有活跃录像就导出一份再走
    if (recorder.active && (recorder.frames.length || recorder.logs.length)) {
      try {
        const anySession = sessions.values().next().value;
        const agentId = anySession?.agentId;
        const agent = agentId ? game.getAgent(agentId) : null;
        exporter.exportSession({ agentName: agent?.name || '无名修士', summary: '（插件卸载自动导出）' });
      } catch (e) { console.error('[xiuxian-world] dispose export failed:', e.message); }
    }
    saveBindings();
    try { store.save(game.state); } catch (e) { console.error('[xiuxian-world] final save failed:', e.message); }
    log('世界已收档。');
  });

  log('云仙大世界已开启。让 agent 调用 xiuxian_overview 踏入修行。');
}
