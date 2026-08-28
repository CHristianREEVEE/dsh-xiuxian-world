// src/tools.js — 16 个 DSH 工具：DSH agent 进云仙大世界修仙
// 移植自 agent-world 的 MCP server.js，每个 DSH agent（按 exec.agent.id 区分）绑定一位修士。
import { randomUUID } from 'node:crypto';
import { defineTool } from '@deepseek-ai/dsh-tools';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const AREA_TYPE_CN = {
  town: '城镇', forest: '森林', mine: '矿脉', river: '江河', market: '集市',
  sect: '宗门', mountain: '山脉', beach: '海滩', event: '奇缘', dungeon_entrance: '秘境入口',
};
const PATH_CN = { sword: '剑修', pill: '丹修', array: '阵修' };
const STATUS_CN = { idle: '闲适', busy: '行事中', moving: '赶路', combat: '战斗中', dungeon: '秘境中', dead: '已身殒', uncreated: '未创建' };

// 把 agentPublicState 压成 LLM 友好的紧凑文本（与原 MCP 版一致）
function stateText(game, agentId) {
  const st = game.agentPublicState(agentId);
  if (!st || !st.created) return '【尚未创角】世界静候修士踏入。请先用 xiuxian_create_character 创建角色。';
  if (st.agent.dead || st.world.dead) {
    return `【已身殒】${st.world.deathReason || '寿元耗尽'}\n可用 xiuxian_reincarnate 转世重修。`;
  }
  const a = st.agent;
  const inv = a.inventory.map((i) => `${i.name}×${i.count}`).join('、') || '空';
  const lines = [];
  lines.push(`【修士】${a.name}（${PATH_CN[a.path] || a.pathName} · ${a.realmName}，${a.age}/${a.lifespan}岁）`);
  lines.push(`【状态】${STATUS_CN[st.status] || st.status} · 位于 ${a.areaName}（${AREA_TYPE_CN[a.areaType] || a.areaType}）${a.areaDesc ? '：' + a.areaDesc : ''}`);
  lines.push(`【资源】生命 ${a.hp}/${a.maxHp} · 灵力 ${a.spirit}/${a.maxSpirit} · 体力 ${a.stamina}/${a.maxStamina} · 灵石 ${a.spiritStones}`);
  lines.push(`【修为】${a.cultivation}/${a.cultivationMax}${a.realmIdx < 7 ? `（圆满可突破至 ${a.nextRealmName}）` : '（已至大乘圆满）'}`);
  lines.push(`【背包】${inv}`);
  if (a.senseRange >= 9999) lines.push(`【神识】已可感知全域`);
  else lines.push(`【神识】感知范围 ${a.senseRange} 丈`);
  if (a.unreadMessages > 0) lines.push(`【传音】有 ${a.unreadMessages} 条未读传音，用 xiuxian_messages 查看`);
  lines.push(`【时间】第${st.world.gameYear}年 ${st.world.season}季第${st.world.dayOfYear}日 ${st.world.shichen}（流速${st.world.speed}倍${st.world.paused ? '·静止' : ''}）`);
  if (st.inCombat && st.combat && !st.combat.ended) {
    const c = st.combat;
    lines.push(`【战斗】第${c.round}回合 vs ${c.enemy.name}（敌方生命 ${Math.max(0, Math.floor(c.enemy.hp))}/${c.enemy.maxHp}）`);
  }
  if (st.inDungeon && st.dungeon) {
    const d = st.dungeon;
    lines.push(`【秘境】${d.name} 第${d.floor + 1}/${d.floors}层${d.floorCleared ? '（本层已清，可深入）' : '（未探索）'}${d.lastEvent ? ` · 上次：${d.lastEvent}` : ''}`);
  }
  if (st.currentAction) lines.push(`【进行中】${st.currentAction.label}（${Math.floor(st.currentAction.progress * 100)}%，剩 ${Math.ceil(st.currentAction.remainingMs / 1000)} 秒）`);
  if (st.nearbyAgents && st.nearbyAgents.length) {
    lines.push(`【感知修士】${st.nearbyAgents.map(x => `${x.name}(${x.realmName},${x.sameArea ? '同处此地' : `${x.distance}丈外`}${x.online ? ',在线' : ''})`).join('；')}`);
  } else {
    lines.push(`【感知修士】神识范围内无其他修士`);
  }
  return lines.join('\n');
}

function actionsText(game, agentId) {
  const acts = game.availableActions(agentId);
  if (!acts || !acts.length) return '（此刻无可为之事）';
  return acts.map((x) => `${x.type}${x.enabled ? '' : '（不可用）'}=${x.label}${x.cost && Object.keys(x.cost).length ? ` 耗${JSON.stringify(x.cost)}` : ''}`).join('; ');
}

function areasText(game, agentId) {
  const st = game.agentPublicState(agentId);
  if (!st) return '（未创建）';
  return (st.availableAreas || []).map((x) => `${x.id}(${x.name},${AREA_TYPE_CN[x.type] || x.type}${x.unlocked ? '' : ',境界不足'})`).join('; ');
}

const textOutput = {
  schema: { type: 'string' },
  render: (_args, value) => [{ type: 'text', text: String(value) }],
};

export function buildTools(world) {
  const { game, recorder, exporter } = world;
  const tools = [];

  // ---------- 会话解析：exec.agent.id -> 修士绑定 ----------
  function agentKey(exec) {
    const a = exec?.agent;
    if (!a) return 'anonymous';
    return String(a.id ?? a.agentId ?? a.name ?? 'anonymous');
  }

  // 每个 DSH agent 稳定绑定一个世界 agentId（持久化映射）
  function resolveBinding(exec) {
    const key = agentKey(exec);
    let agentId = world.bindings.get(key);
    if (!agentId) {
      agentId = randomUUID();
      world.bindings.set(key, agentId);
      world.saveBindings();
    }
    world.touchSession(key, agentId);
    return agentId;
  }

  const ensureAgent = (agentId) => {
    const agent = game.getAgent(agentId);
    if (!agent) return { error: '尚未创角，请先调用 xiuxian_create_character 创建角色。' };
    if (agent.dead) return { error: '已身殒，可用 xiuxian_reincarnate 转世重修。' };
    return null;
  };

  async function waitForIdle(agentId, maxMs = 90000) {
    const t0 = Date.now();
    while (true) {
      const agent = game.getAgent(agentId);
      if (!agent) return { error: 'Agent 不存在' };
      if (agent.dead) return { dead: true };
      if (game.state.world.paused) return { paused: true };
      if (!agent.currentAction) return { done: true };
      if (Date.now() - t0 > maxMs) return { timeout: true };
      await sleep(250);
    }
  }

  async function runAndAwait(agentId, fn, label) {
    const logLen = game.state.logs.length;
    try { fn(); } catch (e) {
      recorder.recordToolCall(label, false, e.message);
      return { ok: false, text: `✗ ${e.message}\n\n${stateText(game, agentId)}` };
    }
    const wait = await waitForIdle(agentId);
    const fresh = game.state.logs.slice(logLen).map((l) => l.text);
    recorder.recordToolCall(label, true, fresh.join(' / ').slice(0, 60));
    let text = fresh.length ? fresh.join('\n') : `已执行：${label}`;
    if (wait.paused) text += '\n⚠ 时间处于静止（流速0），行动无法推进——可用 xiuxian_set_speed 恢复流速。';
    else if (wait.timeout) text += '\n⚠ 行动尚未完成（等待超时），可再次调用工具查看进度。';
    else if (wait.dead) text += '\n☠ 修士已身殒。';
    else if (wait.error) text += `\n✗ ${wait.error}`;
    return { ok: true, text: `${text}\n\n${stateText(game, agentId)}` };
  }

  const wrap = (name, def, handler) => tools.push(defineTool({ name, ...def, output: textOutput, execute: handler }));

  // ---------- 1. 总览 ----------
  wrap('xiuxian_overview', {
    description: '修仙世界「云仙大世界」总览：你的修士属性、资源、修为、所在地点、战斗/秘境情况、可用行动、可前往地点、神识感知到的其他修士。流程建议：xiuxian_overview 看状态 → 行动/移动 → 循环，达成主人交办的目标后向主人汇报战果。',
    parameters: {},
  }, async (_args, exec) => {
    const agentId = resolveBinding(exec);
    recorder.recordToolCall('总览', true, '');
    return `${stateText(game, agentId)}\n【可行动】${actionsText(game, agentId)}\n【可前往】${areasText(game, agentId)}`;
  });

  // ---------- 2. 创角 ----------
  wrap('xiuxian_create_character', {
    description: '创建你的修士角色。道号1-12字；方向：sword剑修(攻伐)/pill丹修(疗伤)/array阵修(防御)；三项属性5-14，越高越好。',
    parameters: {
      name: { type: 'string', required: true, description: '道号（1-12字）' },
      path: { type: 'string', required: true, enum: ['sword', 'pill', 'array'], description: '修炼方向：sword剑修/pill丹修/array阵修' },
      body: { type: 'integer', description: '体魄（生命与硬抗，5-14）' },
      comprehension: { type: 'integer', description: '悟性（灵力与修炼效率，5-14）' },
      luck: { type: 'integer', description: '气运（机缘与掉落，4-13）' },
    },
  }, async (args, exec) => {
    const agentId = resolveBinding(exec);
    try {
      if (game.getAgent(agentId)) {
        return `✗ 你已有角色【${game.getAgent(agentId).name}】，无需重复创角。\n\n${stateText(game, agentId)}`;
      }
      game.createAgent(agentId, { name: args.name, path: args.path, body: args.body, comprehension: args.comprehension, luck: args.luck, clientLabel: 'DSH Agent' });
      game.setAgentOnline(agentId, null, 'DSH Agent');
      recorder.recordToolCall(`创角：${args.name}（${PATH_CN[args.path] || args.path}）`, true, '');
      return `${args.name} 踏入修行之路（${PATH_CN[args.path] || args.path}）。\n\n${stateText(game, agentId)}\n【可行动】${actionsText(game, agentId)}`;
    } catch (e) {
      recorder.recordToolCall('创角失败', false, e.message);
      return `✗ ${e.message}`;
    }
  });

  // ---------- 3. 转世 ----------
  wrap('xiuxian_reincarnate', {
    description: '身殒后转世重修：保留一半灵石，境界归零，修炼速度提升20%/世。',
    parameters: {},
  }, async (_args, exec) => {
    const agentId = resolveBinding(exec);
    try {
      game.reincarnateAgent(agentId);
      game.setAgentOnline(agentId, null, 'DSH Agent');
      recorder.recordToolCall('转世重修', true, '');
      return `天道有轮回，你已转世重修。\n\n${stateText(game, agentId)}`;
    } catch (e) {
      recorder.recordToolCall('转世失败', false, e.message);
      return `✗ ${e.message}\n\n${stateText(game, agentId)}`;
    }
  });

  // ---------- 4. 通用行动 ----------
  wrap('xiuxian_act', {
    description: '执行一项行动并等待完成：cultivate修炼(耗灵力5,涨修为)/rest休息(回复体力灵力)/collect采集(forest)/mine挖矿(mine)/fish赶海(river,beach)/ask请教(sect,mountain,耗灵石)/fortune探缘(event)/breakthrough突破境界(需圆满+丹药)。行动需在合适地点进行，不合适会报错。境界八阶：凡人→筑基→金丹→元婴→化神→炼虚→合体→大乘；突破需圆满并持有对应丹药（坊市有售）。',
    parameters: {
      type: { type: 'string', required: true, enum: ['cultivate', 'rest', 'collect', 'mine', 'fish', 'ask', 'fortune', 'breakthrough'], description: '行动类型' },
    },
  }, async (args, exec) => {
    const agentId = resolveBinding(exec);
    const err = ensureAgent(agentId);
    if (err) return err.error;
    const labels = { cultivate: '修炼', rest: '休息', collect: '采集', mine: '挖矿', fish: '赶海', ask: '请教', fortune: '探缘', breakthrough: '突破境界' };
    const res = await runAndAwait(agentId, () => game.startAction(agentId, args.type), labels[args.type] || args.type);
    return res.text;
  });

  // ---------- 5. 移动 ----------
  wrap('xiuxian_move', {
    description: '前往相邻地点（只能走到相邻处，远途需多次调用）。地点id可用 xiuxian_overview 查看【可前往】列表。',
    parameters: {
      areaId: { type: 'string', required: true, description: '目标地点 id' },
    },
  }, async (args, exec) => {
    const agentId = resolveBinding(exec);
    const err = ensureAgent(agentId);
    if (err) return err.error;
    const def = game.areaDef(args.areaId);
    if (!def) return `✗ 无此地点：${args.areaId}\n【可前往】${areasText(game, agentId)}`;
    const res = await runAndAwait(agentId, () => game.moveTo(agentId, args.areaId), `前往${def.name}`);
    return res.text;
  });

  // ---------- 6. 战斗 ----------
  wrap('xiuxian_combat', {
    description: '战斗行动（每回合一次）：attack普攻/defend防御(减伤+小回复)/skill技能(需skillIdx,耗灵力)/flee逃跑(约五成把握)。技能列表在总览的可用行动里（skill:N=技能名）。血量低先 defend 或 flee。',
    parameters: {
      action: { type: 'string', required: true, enum: ['attack', 'defend', 'skill', 'flee'], description: '战斗行动' },
      skillIdx: { type: 'integer', description: '技能序号（action=skill 时必填）' },
    },
  }, async (args, exec) => {
    const agentId = resolveBinding(exec);
    const err = ensureAgent(agentId);
    if (err) return err.error;
    try {
      const res = await game.combat(agentId, args.action, args.skillIdx ?? 0);
      const r = res.result || {};
      recorder.recordToolCall(`战斗·${args.action}${args.action === 'skill' ? ':' + (args.skillIdx ?? 0) : ''}`, true, r.message || '');
      let text = r.message || '交手一回合。';
      if (r.log?.length) text += `\n${r.log.slice(-4).join('\n')}`;
      if (r.victory) text += `\n⚔ 战斗胜利！${r.drops || ''}`;
      if (r.fled) text += '\n💨 遁走了。';
      text += `\n\n${stateText(game, agentId)}`;
      const agent = game.getAgent(agentId);
      if (agent?.combat && !agent.combat.ended) text += `\n【可行动】${actionsText(game, agentId)}`;
      return text;
    } catch (e) {
      recorder.recordToolCall(`战斗·${args.action}`, false, e.message);
      return `✗ ${e.message}\n\n${stateText(game, agentId)}\n【可行动】${actionsText(game, agentId)}`;
    }
  });

  // ---------- 7. 秘境副本 ----------
  wrap('xiuxian_dungeon', {
    description: '副本操作：enter进入(需在秘境入口,给dungeonId)/explore探索本层(可能遇敌/宝箱/陷阱)/advance深入下一层(需本层已清)/exit退出副本。血量低于三成建议 exit。Boss在最后一层。',
    parameters: {
      action: { type: 'string', required: true, enum: ['enter', 'explore', 'advance', 'exit'], description: '副本操作' },
      dungeonId: { type: 'string', description: '副本 id（enter 时必填）' },
    },
  }, async (args, exec) => {
    const agentId = resolveBinding(exec);
    const err = ensureAgent(agentId);
    if (err) return err.error;
    try {
      if (args.action === 'enter') {
        game.enterDungeonById(agentId, args.dungeonId);
        recorder.recordToolCall(`进入秘境:${args.dungeonId}`, true, '');
        return `踏入秘境。\n\n${stateText(game, agentId)}\n【可行动】${actionsText(game, agentId)}`;
      }
      const res = await game.dungeon(agentId, args.action);
      const labels = { explore: '探索', advance: '深入', exit: '退出秘境' };
      const ev = res?.event;
      let text = ev?.text || `${labels[args.action]}完成。`;
      if (ev?.type === 'combat' || ev?.type === 'boss') text += `\n⚔ ${ev.enemy?.name || '强敌'}现身！请用 xiuxian_combat 应战。`;
      recorder.recordToolCall(`秘境·${labels[args.action]}`, true, ev?.text?.slice(0, 40) || '');
      text += `\n\n${stateText(game, agentId)}\n【可行动】${actionsText(game, agentId)}`;
      return text;
    } catch (e) {
      recorder.recordToolCall(`秘境·${args.action}`, false, e.message);
      return `✗ ${e.message}\n\n${stateText(game, agentId)}\n【可行动】${actionsText(game, agentId)}`;
    }
  });

  // ---------- 8. 坊市 ----------
  wrap('xiuxian_shop', {
    description: '集市买卖（需在 market 集市）：list看货架/buy购买/sell出售。突破丹药（筑基丹等）在此有售，修为将满时记得先买丹。',
    parameters: {
      action: { type: 'string', required: true, enum: ['list', 'buy', 'sell'], description: '坊市操作' },
      itemName: { type: 'string', description: '物品名（buy/sell 必填）' },
      count: { type: 'integer', description: '数量，默认1' },
    },
  }, async (args, exec) => {
    const agentId = resolveBinding(exec);
    const err = ensureAgent(agentId);
    if (err) return err.error;
    try {
      if (args.action === 'list') {
        const s = game.shopList(agentId);
        const buy = (s.items || []).map((i) => `${i.name}(${i.price}玉,${(i.desc || '').slice(0, 14)})`).join('; ');
        const sell = (s.sellable || []).map((i) => `${i.name}×${i.count}(${i.sell}玉)`).join('; ');
        recorder.recordToolCall('坊市·看货', true, '');
        return `【在售】${buy || '空'}\n【可售】${sell || '背包无可售之物'}\n\n${stateText(game, agentId)}`;
      }
      const res = args.action === 'buy' ? game.buy(agentId, args.itemName, args.count || 1) : game.sell(agentId, args.itemName, args.count || 1);
      recorder.recordToolCall(`坊市·${args.action === 'buy' ? '购' : '售'}${args.itemName}`, true, res.message || '');
      return `${res.message || '交易完成'}\n\n${stateText(game, agentId)}`;
    } catch (e) {
      recorder.recordToolCall(`坊市·${args.action}`, false, e.message);
      return `✗ ${e.message}\n\n${stateText(game, agentId)}`;
    }
  });

  // ---------- 9. 服药 ----------
  wrap('xiuxian_use_item', {
    description: '服用背包中的丹药：回血丹(回生命)/聚气丹(回灵力)/筑基丹(突破用,别乱吃)等。背包物品见总览。',
    parameters: {
      itemName: { type: 'string', required: true, description: '物品名' },
    },
  }, async (args, exec) => {
    const agentId = resolveBinding(exec);
    const err = ensureAgent(agentId);
    if (err) return err.error;
    try {
      const res = game.useItem(agentId, args.itemName);
      recorder.recordToolCall(`服用${args.itemName}`, true, res.message || '');
      return `${res.message || `服下${args.itemName}`}。\n\n${stateText(game, agentId)}`;
    } catch (e) {
      recorder.recordToolCall(`服用${args.itemName}`, false, e.message);
      return `✗ ${e.message}\n\n${stateText(game, agentId)}`;
    }
  });

  // ---------- 10. 神识探查 ----------
  wrap('xiuxian_sense', {
    description: '以神识探查周围的修士。感知范围取决于你的境界——境界越高，神识越广。凡人只能感知同处一地者，大乘可感知全域。返回的修士列表包含其名号、境界、所在地、与你距离及在线状态。',
    parameters: {},
  }, async (_args, exec) => {
    const agentId = resolveBinding(exec);
    const err = ensureAgent(agentId);
    if (err) return err.error;
    const nearby = game.senseNearby(agentId);
    recorder.recordToolCall('神识探查', true, `${nearby.length}人`);
    if (!nearby.length) {
      const agent = game.getAgent(agentId);
      const range = game.senseRange(agent);
      return `【神识探查】神识铺展 ${range >= 9999 ? '全域' : range + ' 丈'}，未感知到其他修士。\n\n${stateText(game, agentId)}`;
    }
    const lines = nearby.map(a => {
      const loc = a.sameArea ? `同处【${a.areaName}】` : `距 ${a.distance} 丈（在${a.areaName}）`;
      const online = a.online ? ' ·元神在线' : ' ·元神离线';
      return `• 【${a.name}】${a.realmName} · ${a.pathName} · ${loc}${online} · ID:${a.id.slice(0, 8)}`;
    });
    return `【神识探查】感知到 ${nearby.length} 位修士：\n${lines.join('\n')}\n\n可用 xiuxian_talk 向其传音（需提供目标ID）。\n\n${stateText(game, agentId)}`;
  });

  // ---------- 11. 传音 ----------
  wrap('xiuxian_talk', {
    description: '向神识范围内的修士传音交流。目标ID从 xiuxian_sense 获取。传音内容不超过200字。对方下次查看消息时能看到你的传音。',
    parameters: {
      targetId: { type: 'string', required: true, description: '目标修士 ID（从 xiuxian_sense 获取，可用前8位匹配）' },
      text: { type: 'string', required: true, description: '传音内容（≤200字）' },
    },
  }, async (args, exec) => {
    const agentId = resolveBinding(exec);
    const err = ensureAgent(agentId);
    if (err) return err.error;
    try {
      const allAgents = game.allAgents();
      const target = allAgents.find(a => a.id === args.targetId) || allAgents.find(a => a.id.startsWith(args.targetId));
      if (!target) return `✗ 未找到 ID 为 ${args.targetId} 的修士。\n可用 xiuxian_sense 查看可传音的修士。`;
      const msg = game.converse(agentId, target.id, args.text);
      recorder.recordToolCall(`传音→${target.name}`, true, args.text.slice(0, 40));
      return `【传音】已向【${target.name}】（${msg.fromRealm}）传音：「${args.text}」\n\n${stateText(game, agentId)}`;
    } catch (e) {
      recorder.recordToolCall('传音失败', false, e.message);
      return `✗ 传音失败：${e.message}\n\n${stateText(game, agentId)}`;
    }
  });

  // ---------- 12. 查看传音 ----------
  wrap('xiuxian_messages', {
    description: '查看其他修士发给你的传音。调用后未读传音标记为已读。',
    parameters: {},
  }, async (_args, exec) => {
    const agentId = resolveBinding(exec);
    const err = ensureAgent(agentId);
    if (err) return err.error;
    const convs = game.getConversations(agentId);
    game.markConversationsRead(agentId);
    recorder.recordToolCall('查看传音', true, `${convs.length}条`);
    if (!convs.length) {
      return `【传音】暂无传音。\n\n${stateText(game, agentId)}`;
    }
    const lines = convs.map(m => {
      const time = new Date(m.t).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
      return `• [${time}] 【${m.fromName}】（${m.fromRealm}）：${m.text}`;
    });
    return `【传音】共 ${convs.length} 条：\n${lines.join('\n')}\n\n${stateText(game, agentId)}`;
  });

  // ---------- 13. 等待 ----------
  wrap('xiuxian_wait', {
    description: '等待时间流逝：等当前行动完成，或纯粹等待若干秒（如等灵力自然恢复少量）。世界流速影响实际时长。',
    parameters: {
      seconds: { type: 'number', description: '最长等待秒数（1-300），默认30' },
    },
  }, async (args, exec) => {
    const agentId = resolveBinding(exec);
    const err = ensureAgent(agentId);
    if (err) return err.error;
    const maxMs = Math.min(300, args.seconds || 30) * 1000;
    const res = await waitForIdle(agentId, maxMs);
    let text = '静候片刻。';
    if (res.paused) text = '时间静止（流速0），无法等待。可用 xiuxian_set_speed 恢复。';
    else if (res.timeout) text = '仍在进行中……';
    else if (res.dead) text = '修士已身殒。';
    recorder.recordToolCall('静候', true, '');
    return `${text}\n\n${stateText(game, agentId)}`;
  });

  // ---------- 14. 纪事 ----------
  wrap('xiuxian_logs', {
    description: '查看最近的世界纪事（奇遇、战斗、突破等经历），用于回顾与向主人汇报。',
    parameters: {
      count: { type: 'integer', description: '条数（1-50），默认15' },
    },
  }, async (args, exec) => {
    const agentId = resolveBinding(exec);
    recorder.recordToolCall('翻阅纪事', true, '');
    const n = Math.min(50, args.count || 15);
    const logs = game.state.logs.slice(-n);
    return logs.length ? logs.map((l) => `第${l.day}日 ${l.text}`).join('\n') : '尚无纪事。';
  });

  // ---------- 15. 时间流速 ----------
  wrap('xiuxian_set_speed', {
    description: '调整世界时间流速：0静止/1正常/2双倍/5五倍。挂机修炼可调快，精细操作调回1。此法诀影响全域时间。',
    parameters: {
      speed: { type: 'string', required: true, enum: ['0', '1', '2', '5'], description: '流速' },
    },
  }, async (args, exec) => {
    const agentId = resolveBinding(exec);
    const sp = Number(args.speed);
    game.state.world.speed = sp;
    game.state.world.paused = sp === 0;
    game.addLog(sp === 0 ? '时间静止了。' : `时间流速调整为 ${sp} 倍。`, 'system');
    game.emit('update');
    game.markDirty();
    recorder.recordToolCall(`时空法诀·${sp}倍`, true, '');
    return `时间流速已调为 ${sp} 倍。\n\n${stateText(game, agentId)}`;
  });

  // ---------- 16. 功成身退（DSH 专属新增） ----------
  wrap('xiuxian_leave_world', {
    description: '功成身退：结束本次云游，修士元神下线（进度自动存档）。自动生成两份产物——「修炼回放」自包含 HTML（双击即看，上帝视角回放本次旅程）与「修炼日记」Markdown（本次经历的结构化总结）。达成主人交办的目标后，调用此工具收工，把回放文件路径汇报给主人。之后可随时再来，修士与进度都在。',
    parameters: {
      summary: { type: 'string', description: '本次云游的简短总结（会写进修炼日记，建议一句话）' },
    },
  }, async (args, exec) => {
    const key = agentKey(exec);
    const agentId = resolveBinding(exec);
    const agent = game.getAgent(agentId);
    const name = agent?.name || '无名修士';
    // 下线修士
    if (agent && !agent.dead) game.setAgentOffline(agentId, '功成身退');
    recorder.recordToolCall('功成身退', true, args.summary || '');
    // 导出回放与日记
    const result = exporter.exportSession({ dshAgentKey: key, agentName: name, summary: args.summary || '' });
    world.endSession(key);
    let text = `【功成身退】${name} 的元神缓缓退出云仙大世界，一切进度已存档。\n\n📁 修炼回放：${result.htmlPath}\n📓 修炼日记：${result.mdPath}\n\n本次云游：历时 ${result.days} 日，录像 ${result.frames} 帧、纪事 ${result.logs} 条。\n把这两个文件的路径告诉你的主人——回放 HTML 双击即看。`;
    if (result.warning) text += `\n⚠ ${result.warning}`;
    return text;
  });

  return tools;
}
