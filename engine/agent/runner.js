// runner.js — Agent 接入层：内置灵智（启发式） + LLM 决策循环 + 传音对话
// 多Agent版本：runner 绑定一个 agentId，操作该特定 Agent
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { LLMClient } from './llm.js';
import { isCombatActive } from '../engine/combat.js';

export const DEFAULT_SYSTEM_PROMPT = `你是修仙世界「云仙大世界」中的一名修士。你通过 API 与游戏世界交互，自主决定行动。

## 世界设定
境界从凡人到大乘共 8 阶：凡人、筑基、金丹、元婴、化神、炼虚、合体、大乘。突破需要对应丹药（如筑基丹）。
世界分为凡尘大陆、玄黄大陆、九天之上、无尽海域四片区域，共 22 处地点、八座秘境副本。
你的目标：提升境界、积累资源、探索副本，最终飞升成仙。
此界中还有其他修士，境界越高神识越广，可通过传音交流。

## 决策原则
1. 体力低于 20% 时优先休息
2. 灵力充足时优先修炼；修为将满时提前备好突破丹药（可在散修集市购买）
3. 修为圆满且持有突破丹药时立即突破
4. 境界达到筑基后可尝试副本；副本中血量低于 30% 时果断退出
5. 战斗中灵力充足时优先使用高伤害技能，灵力不足用普攻，血量过低可防御或逃跑
6. 灵石不足时通过采集、挖矿、赶海、出售材料积累

## 行动格式（只回复一行行动指令，不要解释）
- cultivate 修炼 | rest 休息 | collect 采集 | mine 挖矿 | fish 赶海 | ask 请教 | fortune 探缘
- move:地点id 移动 | enter_dungeon:副本id 进入副本 | breakthrough 突破境界
- 战斗中：attack 攻击 | defend 防御 | skill:0 使用技能 | flee 逃跑
- 副本中：explore 探索 | advance 深入 | exit_dungeon 退出
若想对观察你的道友说一句话，可在第二行写一句不超过 30 字的话（可选）。`;

export class AgentRunner extends EventEmitter {
  constructor(game, store) {
    super();
    this.game = game;
    this.store = store;
    this.agentId = null;  // 绑定的 Agent ID，start() 时分配
    this.config = {
      provider: 'builtin',   // builtin | claude | openai | ollama
      apiKey: '', baseUrl: '', model: '',
      intervalSec: 12,
      persona: '',           // 道号（默认取角色名）
      systemPrompt: DEFAULT_SYSTEM_PROMPT,
    };
    const saved = store?.loadAgentConfig();
    if (saved) Object.assign(this.config, saved);
    this.running = false;
    this.timer = null;
    this._busy = false;
    this._errorStreak = 0;
    this.decisions = [];   // 决策记录（内存，最近 60 条）
    this.chatHistory = []; // 传音对话（最近 40 条）
    this.lastTickAt = null;
    this.lastError = null;
    this.mcpClients = new Map(); // sessionId -> { name, agentId, connectedAt, ops }
  }

  // ---------- 辅助：获取绑定的 Agent ----------
  get agent() { return this.agentId ? this.game.getAgent(this.agentId) : null; }
  get isBusy() { const a = this.agent; return !!(a?.currentAction); }
  get inCombat() { return isCombatActive(this.agent); }
  get inDungeon() { return !!this.agent?.dungeon; }

  // ---------- MCP 外部 Agent（Claude Code / Codex 等） ----------
  mcpConnect(sessionId, name, agentId) {
    this.mcpClients.set(sessionId, { name, agentId, connectedAt: Date.now(), ops: 0 });
    this.feed('status', { text: `【${name}】驾临此界（MCP 接入）。` });
    this.game.addLog(`一位【${name}】之真身降临，代主修行的元神接入世界。`, 'agent');
  }

  mcpDisconnect(sessionId, reason = '') {
    const c = this.mcpClients.get(sessionId);
    if (!c) return;
    this.mcpClients.delete(sessionId);
    this.feed('status', { text: `【${c.name}】之元神离场。${reason}` });
    this.game.addLog(`【${c.name}】之元神离场。`, 'agent');
  }

  recordExternal({ client, action, ok, message }) {
    const entry = {
      t: Date.now(), provider: client, external: true,
      action, say: '', ok, message: message || '',
    };
    this.decisions.push(entry);
    if (this.decisions.length > 60) this.decisions.shift();
    this.feed('decision', entry);
  }

  mcpStatus() {
    return [...this.mcpClients.entries()].map(([id, c]) => ({
      sessionId: id.slice(0, 8), name: c.name, agentId: c.agentId?.slice(0, 8),
      connectedAt: c.connectedAt,
    }));
  }

  // ---------- 对外 ----------
  get persona() { return this.config.persona || this.agent?.name || '无名修士'; }

  publicConfig() {
    const { apiKey, ...rest } = this.config;
    return { ...rest, hasKey: !!apiKey, keyHint: apiKey ? `...${apiKey.slice(-4)}` : '', agentId: this.agentId?.slice(0, 8) };
  }

  updateConfig(patch) {
    const allowed = ['provider', 'apiKey', 'baseUrl', 'model', 'intervalSec', 'persona', 'systemPrompt'];
    for (const k of allowed) {
      if (patch[k] !== undefined) {
        if (k === 'intervalSec') this.config.intervalSec = Math.max(4, Math.min(120, Number(patch[k]) || 12));
        else if (k === 'apiKey' && (patch[k] === '' || patch[k])) this.config.apiKey = String(patch[k]);
        else this.config[k] = String(patch[k] ?? '');
      }
    }
    this.store?.saveAgentConfig(this.config);
    if (this.running) { this.stop(); this.start(); }
    return this.publicConfig();
  }

  status() {
    return {
      running: this.running,
      ...this.publicConfig(),
      lastTickAt: this.lastTickAt,
      lastError: this.lastError,
      mcp: this.mcpStatus(),
      decisions: this.decisions.slice(-20),
      chat: this.chatHistory.slice(-30),
    };
  }

  feed(kind, data) {
    this.emit('agent', { kind, ...data, t: Date.now() });
  }

  // ---------- 启停 ----------
  start() {
    if (this.running) return { ok: true, message: 'Agent 已在运行' };
    // 分配 agentId（如果没有的话）
    if (!this.agentId) this.agentId = randomUUID();
    if (this.config.provider !== 'builtin') {
      const c = new LLMClient(this.config);
      if (!c.ready) throw new Error('请先完整配置 API 地址 / 模型 / 密钥');
    }
    this.running = true;
    this._errorStreak = 0;
    this.lastError = null;
    const ms = Math.max(4, this.config.intervalSec) * 1000;
    this.timer = setInterval(() => this.tick().catch(e => this.#handleError(e)), ms);
    this.feed('status', { text: `${this.providerLabel()} 已上线，每 ${this.config.intervalSec} 秒决策一次。` });
    const agent = this.agent;
    if (agent) {
      this.game.setAgentOnline(this.agentId, null, this.providerLabel());
      this.game.addLog(`【${this.persona}】之元神接入世界（${this.providerLabel()}）。`, 'agent');
    }
    return { ok: true, message: 'Agent 已启动', agentId: this.agentId };
  }

  stop(reason = '') {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    if (this.running) {
      this.running = false;
      this.feed('status', { text: `Agent 已下线。${reason}` });
      if (this.agentId) {
        this.game.setAgentOffline(this.agentId);
        this.game.addLog(`【${this.persona}】之元神离线。`, 'agent');
      }
    }
    return { ok: true, message: 'Agent 已停止' };
  }

  providerLabel() {
    return { builtin: '内置灵智', claude: 'Claude', openai: 'OpenAI 兼容', ollama: 'Ollama 本地模型' }[this.config.provider] || this.config.provider;
  }

  // ---------- 决策循环 ----------
  async tick() {
    if (!this.running || this._busy) return;
    const game = this.game;
    if (!game.state.created) return;
    const agent = this.agent;
    if (!agent || agent.dead) return;
    this._busy = true;
    try {
      let actionStr;
      const useLLM = this.config.provider !== 'builtin';
      if (this.inCombat) {
        actionStr = useLLM ? await this.#llmDecideCombat() : this.#heuristicCombat();
      } else if (this.inDungeon) {
        actionStr = useLLM ? await this.#llmDecideDungeon() : this.#heuristicDungeon();
      } else if (this.isBusy) {
        this._busy = false;
        return; // 行进/行动中，静候
      } else {
        actionStr = useLLM ? await this.#llmDecideIdle() : this.#heuristicIdle();
      }
      const decision = await this.#execute(actionStr);
      this.lastTickAt = Date.now();
      this._errorStreak = 0;
      this.#recordDecision(decision);
    } catch (e) {
      this.#handleError(e);
    } finally {
      this._busy = false;
    }
  }

  #handleError(e) {
    this.lastError = e.message;
    this._errorStreak += 1;
    this.feed('error', { text: `决策出错：${e.message}` });
    if (this._errorStreak >= 3 && this.config.provider !== 'builtin') {
      this.stop('连续 3 次决策失败，已自动下线，请检查配置。');
      this._errorStreak = 0;
    }
  }

  async #execute(actionStr) {
    const raw = String(actionStr || '').trim();
    if (raw.startsWith('BUY:')) {
      const item = raw.slice(4).trim();
      try { this.game.buy(this.agentId, item, 1); return { action: raw, ok: true, message: `购入【${item}】` }; }
      catch (e) { return { action: raw, ok: false, message: e.message }; }
    }
    if (raw.startsWith('USE_PILL:')) {
      const item = raw.slice(9).trim();
      try { this.game.useItem(this.agentId, item); return { action: raw, ok: true, message: `服用【${item}】` }; }
      catch (e) { return { action: raw, ok: false, message: e.message }; }
    }
    if (raw.startsWith('MOVE_TO:')) {
      const targetId = raw.slice(8).trim();
      const next = this.#nextStepToward(targetId);
      if (!next) return { action: raw, ok: false, message: '找不到路径' };
      return this.#execRaw(`move:${next}`);
    }
    return this.#execRaw(raw);
  }

  async #execRaw(raw) {
    const game = this.game;
    const lines = raw.split('\n').map(l => l.trim()).filter(Boolean);
    const cmd = lines[0] || '';
    const say = lines.slice(1).join(' ');
    const result = { action: cmd, say, ok: true, message: '' };
    try {
      if (this.inCombat) {
        if (cmd.startsWith('skill:')) await game.combat(this.agentId, 'skill', parseInt(cmd.split(':')[1], 10) || 0);
        else if (['attack', 'defend', 'flee'].includes(cmd)) await game.combat(this.agentId, cmd);
        else await game.combat(this.agentId, 'attack');
      } else if (this.inDungeon) {
        if (cmd === 'exit_dungeon' || cmd === 'exit') await game.dungeon(this.agentId, 'exit');
        else if (cmd === 'advance') await game.dungeon(this.agentId, 'advance');
        else await game.dungeon(this.agentId, 'explore');
      } else if (cmd.startsWith('move:')) {
        await game.moveTo(this.agentId, cmd.slice(5).trim());
      } else if (cmd.startsWith('enter_dungeon:')) {
        await game.enterDungeonById(this.agentId, cmd.split(':')[1].trim());
      } else if (cmd === 'breakthrough') {
        await game.startAction(this.agentId, 'breakthrough');
      } else if (['cultivate', 'rest', 'collect', 'mine', 'fish', 'ask', 'fortune'].includes(cmd)) {
        await game.startAction(this.agentId, cmd);
      } else {
        result.ok = false;
        result.message = `无法理解的指令: ${cmd}`;
      }
    } catch (e) {
      result.ok = false;
      result.message = e.message;
    }
    return result;
  }

  #recordDecision(d) {
    const game = this.game;
    const agent = this.agent;
    const entry = {
      t: Date.now(), provider: this.providerLabel(),
      action: d.action, say: d.say || '', ok: d.ok, message: d.message || '',
      status: agent ? game.agentStatus(agent) : 'unknown',
      area: agent ? game.agentArea(agent)?.name || '' : '',
    };
    this.decisions.push(entry);
    if (this.decisions.length > 60) this.decisions.shift();
    this.feed('decision', entry);
  }

  // ---------- LLM 决策 ----------
  #stateSummary() {
    const st = this.game.agentPublicState(this.agentId);
    if (!st || !st.created) return '未创建角色';
    const a = st.agent;
    const inv = a.inventory.map(i => `${i.name}×${i.count}`).join('、') || '空';
    return `道号:${a.name} | 境界:${a.realmName} | 修为:${a.cultivation}/${a.cultivationMax} | 生命:${a.hp}/${a.maxHp} | 灵力:${a.spirit}/${a.maxSpirit} | 体力:${a.stamina}/${a.maxStamina} | 灵石:${a.spiritStones} | 修炼方向:${a.pathName} | 所在地:${a.areaName}(${a.areaId}) | 背包:${inv} | ${a.age}岁(寿元${a.lifespan}) | 第${st.world.gameYear}年${st.world.season}季第${st.world.dayOfYear}日${st.world.shichen}`;
  }

  #buildPrompt(extra = '') {
    const game = this.game;
    const st = game.agentPublicState(this.agentId);
    if (!st) return '未创建角色';
    const acts = game.availableActions(this.agentId).map(a => `${a.type}${a.enabled ? '' : '(不可用)'}=${a.label}${Object.keys(a.cost || {}).length ? ` 耗:${JSON.stringify(a.cost)}` : ''}`).join('; ');
    const areas = (st.availableAreas || []).filter(x => x.unlocked).map(x => `${x.id}(${x.name},距离${x.distance})`).join('; ');
    const logs = game.state.logs.slice(-6).map(l => l.text).join('\n') || '';
    const directives = this.chatHistory.filter(m => m.role === 'player').slice(-3).map(m => m.text).join('；');
    return `【当前状态】\n${this.#stateSummary()}\n【可用行动】\n${acts}\n【可前往地点】\n${areas}\n【最近经历】\n${logs}${directives ? `\n【道友传音（玩家嘱托，尽量遵从）】\n${directives}` : ''}${extra}\n请决策下一步行动。只回复一行行动指令${this.config.provider === 'builtin' ? '' : '，如需对道友说话可在第二行写一句不超过30字的话'}。`;
  }

  async #llmCall(userPrompt) {
    const client = new LLMClient(this.config);
    const system = `${this.config.systemPrompt}\n\n你的道号是「${this.persona}」。`;
    const reply = await client.chat({ system, user: userPrompt, maxTokens: 300, temperature: 0.7 });
    if (!reply) throw new Error('模型返回为空');
    return reply;
  }

  async #llmDecideIdle() {
    const recent = this.decisions.slice(-3).map(d => `${d.action}${d.ok ? '' : `（失败:${d.message}）`}`).join(' → ');
    return this.#llmCall(this.#buildPrompt(recent ? `\n【你最近的决策】\n${recent}\n（避免重复无效行动）` : ''));
  }

  async #llmDecideCombat() {
    const agent = this.agent;
    const c = agent.combat;
    const skills = this.game.pathDef(agent).skills.map((s, i) => `skill:${i}=${s.name}(耗灵力${s.spirit},${s.desc})`).join('; ');
    const prompt = `【当前状态】\n${this.#stateSummary()}\n【战斗】第${c.round}回合 | 敌人:${c.enemy.name} 生命:${Math.max(0, c.enemy.hp)}/${c.enemy.maxHp} 攻击:${c.enemy.atk}\n【可用战斗行动】\nattack=普攻; defend=防御(减伤+小回复); ${skills}; flee=逃跑(约五成把握)\n请决策。只回复一行行动指令。`;
    return this.#llmCall(prompt);
  }

  async #llmDecideDungeon() {
    const agent = this.agent;
    const d = agent.dungeon;
    const prompt = `【当前状态】\n${this.#stateSummary()}\n【副本】${d.def.name} 第${d.floor + 1}/${d.def.floors}层 ${d.floorCleared ? '（本层已清，可深入）' : '（本层未探索）'}\n场景：${d.currentScene}\n【可用副本行动】\nexplore=探索本层; advance=深入下一层; exit_dungeon=退出副本\n请决策。只回复一行行动指令。`;
    return this.#llmCall(prompt);
  }

  // ---------- 内置灵智（启发式） ----------
  #heuristicCombat() {
    const a = this.agent;
    const c = a.combat;
    const skills = this.game.pathDef(a).skills;
    if (a.hp < a.maxHp * 0.25 && c.round > 2) return 'flee';
    const atkSkills = skills.map((s, i) => ({ i, s })).filter(x => x.s.type === 'attack' && a.spirit >= x.s.spirit);
    if (a.hp < a.maxHp * 0.4) {
      const heal = skills.map((s, i) => ({ i, s })).find(x => x.s.type === 'heal' && a.spirit >= x.s.spirit);
      if (heal) return `skill:${heal.i}`;
    }
    if (atkSkills.length) return `skill:${atkSkills[atkSkills.length - 1].i}`;
    if (a.spirit < 10 && c.enemy.hp > a.body * 3) return 'defend';
    return 'attack';
  }

  #heuristicDungeon() {
    const a = this.agent;
    const d = a.dungeon;
    if (a.hp < a.maxHp * 0.3 || a.stamina < 8) return 'exit_dungeon';
    if (d.floorCleared) return 'advance';
    return 'explore';
  }

  #heuristicIdle() {
    const game = this.game;
    const a = this.agent;
    if (!a) return 'rest';
    const st = game.agentPublicState(this.agentId);
    const area = game.agentArea(a);
    const realm = game.realmDef(a);
    const has = (n) => a.inventory.find(i => i.name === n)?.count > 0;

    if (a.stamina < a.maxStamina * 0.2) return 'rest';
    if (a.spirit < a.maxSpirit * 0.12) return 'rest';
    if (a.hp < a.maxHp * 0.35) {
      if (has('回血丹')) return 'USE_PILL:回血丹';
      return 'rest';
    }
    // 修为圆满：优先突破
    if (a.cultivation >= realm.maxCultivation && a.realmIdx < game.def.realms.length - 1) {
      const item = realm.breakItem;
      if (!item || has(item)) return 'breakthrough';
      if (area.type === 'market' && a.spiritStones >= (game.def.items[item]?.price || 9999)) return `BUY:${item}`;
      return 'MOVE_TO:market';
    }
    // 资源积累
    if (a.spiritStones < 25 && a.stamina > a.maxStamina * 0.4) {
      if (area.type === 'forest') return 'collect';
      if (area.type === 'mine') return 'mine';
      if (area.type === 'river' || area.type === 'beach') return 'fish';
      return 'MOVE_TO:forest';
    }
    // 副本冒险
    if (a.realmIdx >= 1 && a.hp > a.maxHp * 0.7 && a.spirit > a.maxSpirit * 0.5) {
      const dungeons = game.def.dungeons.filter(d => a.realmIdx >= d.minRealm);
      if (area.type === 'dungeon_entrance' && a.realmIdx >= (game.def.dungeons.find(d => d.id === area.dungeonId)?.minRealm || 99)) {
        return `enter_dungeon:${area.dungeonId}`;
      }
      const target = dungeons.sort((x, y) => (x.minRealm - y.minRealm) || (x.floors - y.floors))[0];
      if (target) return `MOVE_TO:${target.areaId}`;
    }
    // 宗门请教加成
    if ((area.type === 'sect' || area.type === 'mountain') && a.spiritStones >= 20 && a.spirit > a.maxSpirit * 0.3) return 'ask';
    // 机缘
    if (area.type === 'event' && a.stamina > a.maxStamina * 0.5) return 'fortune';
    if (a.spirit >= 5) return 'cultivate';
    return 'rest';
  }

  // BFS 寻路：返回下一步相邻可达地点
  #nextStepToward(targetId) {
    const game = this.game;
    const a = this.agent;
    if (!a) return null;
    if (a.areaId === targetId) return null;
    const queue = [[a.areaId, null]];
    const cameFrom = new Map([[a.areaId, null]]);
    while (queue.length) {
      const [cur] = queue.shift();
      for (const nb of (game.areaDef(cur)?.adjacent || [])) {
        if (cameFrom.has(nb)) continue;
        const def = game.areaDef(nb);
        if (a.realmIdx < def.minRealm) continue;
        cameFrom.set(nb, cur);
        queue.push([nb, cur]);
      }
    }
    if (!cameFrom.has(targetId)) return null;
    let cur = targetId, prev = cameFrom.get(targetId);
    while (prev && prev !== a.areaId) { cur = prev; prev = cameFrom.get(cur); }
    return cur;
  }

  // ---------- 传音（与玩家对话） ----------
  async chat(message) {
    if (!message || typeof message !== 'string' || message.length > 300) throw new Error('传音内容需为 1-300 字');
    this.chatHistory.push({ role: 'player', text: message.trim(), t: Date.now() });
    if (this.chatHistory.length > 40) this.chatHistory.shift();
    this.feed('chat', { role: 'player', text: message.trim() });

    let reply;
    if (this.config.provider === 'builtin') {
      reply = this.#builtinReply(message.trim());
    } else {
      const client = new LLMClient(this.config);
      const st = this.game.agentPublicState(this.agentId);
      const history = this.chatHistory.slice(-10).map(m => `${m.role === 'player' ? '道友' : '你'}: ${m.text}`).join('\n');
      const system = `你是修仙世界「云仙大世界」中的修士「${this.persona}」，正通过传音术与观察你的道友（玩家）交谈。\n以修士口吻回复：称呼对方为道友，语言简练有仙气，单次回复不超过 80 字。\n你可以谈及自己的近况与打算，玩家的嘱托会影响你接下来的行动决策。\n当前状态：${this.#stateSummary()}`;
      reply = await client.chat({ system, user: `${history}\n\n道友最新传音：${message.trim()}\n请回复。`, maxTokens: 200, temperature: 0.8 });
    }
    this.chatHistory.push({ role: 'agent', text: reply, t: Date.now() });
    this.feed('chat', { role: 'agent', text: reply });
    return { reply };
  }

  #builtinReply(message) {
    const game = this.game;
    const st = game.agentPublicState(this.agentId);
    if (!st || !st.created) return '贫道尚未踏入此界，请先创角。';
    const a = st.agent;
    const m = message;
    const plan = () => {
      if (st.status === 'combat') return `贫道正与【${st.combat?.enemy?.name || '强敌'}】缠斗，无暇多言，且看手段！`;
      if (st.inDungeon) return `贫道正在【${st.dungeon.name}】第${st.dungeon.floor + 1}层探索，此地凶险，不便久谈。`;
      if (st.status === 'moving') return '贫道正在赶路，风尘仆仆，有话快讲。';
      if (a.cultivation >= a.cultivationMax * 0.95) return '修为将满，贫道正欲寻丹突破，道友可有指教？';
      if (a.spiritStones < 25) return '囊中羞涩，贫道正打算去采集些灵货换些灵石。';
      if (a.realmIdx >= 1 && a.hp > a.maxHp * 0.7) return '自觉小有所成，贫道有意往秘境副本闯一闯。';
      return '贫道正专心修炼，道法自然，水到渠成。';
    };
    if (/突破|境界|修为/.test(m)) return a.cultivation >= a.cultivationMax * 0.9 ? '修为已近圆满，只欠东风，贫道这就去备突破丹药。' : '修行急不得，火候未到，贫道还需静心苦修。';
    if (/副本|秘境|洞府|龙宫|塔/.test(m)) return a.realmIdx >= 1 ? '道友所言极是，待贫道收拾停当，便去秘境一探。' : '境界尚浅，贸然入秘境是以卵击石，容贫道先修至筑基。';
    if (/休息|累|辛苦/.test(m)) return '多谢道友挂怀，贫道张弛有度，不至于伤了道基。';
    if (/小心|注意|危险/.test(m)) return '道友提醒的是，穷寇莫追，贪嗔痴是修行大忌，贫道记下了。';
    if (/挖矿|采集|赶海|灵石|赚钱/.test(m)) return '君子爱财取之有道，灵石乃修行资粮，贫道自有分寸。';
    if (/你好|道友|在吗|是谁/.test(m)) return `贫道${this.persona}，一介散修，如今在${a.areaName}修行。${plan()}`;
    if (/加油|支持|看好/.test(m)) return '承道友吉言，愿你我共证大道。';
    return `${plan()}`;
  }
}
