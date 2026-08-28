// dungeon.js — 副本系统（Agent 作用域：每个 Agent 独立副本状态）
import { randInt, weightedPick } from './util.js';
import { startCombat } from './combat.js';

const EVENT_TABLE = [
  { type: 'combat', weight: 30 },
  { type: 'treasure', weight: 20 },
  { type: 'fortune', weight: 15 },
  { type: 'trap', weight: 10 },
  { type: 'empty', weight: 25 },
];

export function enterDungeon(game, agent, dungeonId) {
  if (agent.dead) throw new Error('已身殒');
  if (game.agentStatus(agent) === 'combat') throw new Error('战斗中');
  if (agent.dungeon) throw new Error('已在副本中');
  if (agent.currentAction) throw new Error(`正在进行：${agent.currentAction.label}`);
  const def = game.def.dungeons.find(d => d.id === dungeonId);
  if (!def) throw new Error('无此副本');
  const area = game.areaDef(agent.areaId);
  if (area.type !== 'dungeon_entrance' || area.dungeonId !== dungeonId) throw new Error('需抵达副本入口');
  if (agent.realmIdx < def.minRealm) throw new Error(`境界不足，需 ${game.realmName(def.minRealm)} 以上`);

  agent.dungeon = {
    def, floor: 0, floorCleared: false, cleared: false,
    currentScene: def.scenes[0], lastEvent: null,
  };
  game.addLog(`【${agent.name}】踏入【${def.name}】第一层。${def.scenes[0]}`, 'dungeon');
  game.emit('update');
  game.markDirty();
  return { ok: true, floor: 0 };
}

function rollFloorEvent(game, agent, isBoss) {
  const d = agent.dungeon;
  if (isBoss) return { type: 'boss' };

  const luck = agent.luck;
  const table = EVENT_TABLE.map(e => {
    let w = e.weight;
    if (e.type === 'treasure' || e.type === 'fortune') w *= 1 + luck * 0.03;
    if (e.type === 'trap' || e.type === 'combat') w /= 1 + luck * 0.02;
    return { ...e, weight: w };
  });
  const ev = weightedPick(table);
  const floorScale = 1 + d.floor * 0.04;
  const enemyDef = d.def.enemies[randInt(0, d.def.enemies.length - 1)];

  switch (ev.type) {
    case 'combat':
      return { type: 'combat', text: `前方妖气扑面，一只${enemyDef.name}拦住了去路！`, enemy: { ...enemyDef, hp: Math.floor(enemyDef.hp * floorScale), atk: Math.floor(enemyDef.atk * floorScale) } };
    case 'treasure': {
      const stones = randInt(10, 30) + d.floor * 8;
      const itemRoll = Math.random() < 0.25;
      const itemName = itemRoll ? (Math.random() < 0.5 ? '聚气丹' : '回血丹') : null;
      return { type: 'treasure', text: `发现一处前人遗落的宝箱！${itemName ? `内有【${itemName}】与` : '内有'}灵石 ${stones} 枚。`, stones, item: itemName };
    }
    case 'fortune': {
      const cult = randInt(15, 40) + d.floor * 10;
      return { type: 'fortune', text: `此地残留一缕机缘，坐下参悟片刻，修为 +${cult}。`, cultivation: cult };
    }
    case 'trap': {
      const dmg = randInt(8, 20) + d.floor * 5;
      return { type: 'trap', text: `误触了禁制！一股大力涌来，损失 ${dmg} 点生命。`, dmg };
    }
    default:
      return { type: 'empty', text: '此处空空荡荡，唯有风声。' };
  }
}

export function dungeonAct(game, agent, action) {
  const d = agent.dungeon;
  if (!d) throw new Error('不在副本中');

  if (action === 'explore') {
    if (game.agentStatus(agent) === 'combat') throw new Error('先解决眼前的战斗！');
    if (d.floorCleared) throw new Error('本层已探索完毕，请深入或退出');
    if (agent.stamina < 2) throw new Error('体力不足');
    agent.stamina -= 2;
    const isBoss = d.floor === d.def.floors - 1;
    const ev = rollFloorEvent(game, agent, isBoss);
    d.lastEvent = ev;

    if (ev.type === 'combat' || ev.type === 'boss') {
      const enemy = ev.type === 'boss'
        ? { ...d.def.boss, drops: d.def.boss.drops }
        : ev.enemy;
      startCombat(game, agent, enemy, 'dungeon');
      game.addLog(`【${agent.name}】${ev.text}`, 'dungeon');
      game.emit('update'); game.markDirty();
      return { ok: true, event: ev, inCombat: true };
    }
    if (ev.type === 'treasure') {
      agent.spiritStones += ev.stones;
      if (ev.item) {
        const inv = agent.inventory.find(i => i.name === ev.item);
        if (inv) inv.count += 1; else agent.inventory.push({ name: ev.item, count: 1 });
      }
    } else if (ev.type === 'fortune') {
      agent.cultivation = Math.min(agent.cultivation + ev.cultivation, game.def.realms[agent.realmIdx].maxCultivation);
    } else if (ev.type === 'trap') {
      agent.hp = Math.max(1, agent.hp - ev.dmg);
    }
    d.floorCleared = true;
    game.addLog(`【${agent.name}】${ev.text}`, ev.type === 'trap' ? 'event-bad' : 'dungeon');
    game.emit('update'); game.markDirty();
    return { ok: true, event: ev, floorCleared: true };
  }

  if (action === 'advance') {
    if (game.agentStatus(agent) === 'combat') throw new Error('先解决眼前的战斗！');
    if (!d.floorCleared) throw new Error('先探索本层');
    if (d.floor >= d.def.floors - 1) throw new Error('已是最后一层');
    agent.stamina = Math.max(0, agent.stamina - 1);
    d.floor += 1;
    d.floorCleared = false;
    d.currentScene = d.def.scenes[d.floor];
    d.lastEvent = null;
    game.addLog(`【${agent.name}】深入第 ${d.floor + 1} 层。${d.currentScene}`, 'dungeon');
    game.emit('update'); game.markDirty();
    return { ok: true, floor: d.floor };
  }

  if (action === 'exit') {
    exitDungeon(game, agent, `${agent.name} 主动退出，退回了副本入口。`);
    return { ok: true, exited: true };
  }
  throw new Error('无效的副本行动');
}

export function exitDungeon(game, agent, msg) {
  const d = agent.dungeon;
  if (!d) return;
  agent.dungeon = null;
  if (agent.combat) agent.combat = null;
  game.addLog(msg, 'dungeon');
  game.emit('update');
  game.markDirty();
}

export function afterDungeonVictory(game, agent) {
  const d = agent.dungeon;
  if (!d) return null;
  const isBoss = d.floor === d.def.floors - 1;
  d.floorCleared = true;

  if (isBoss) {
    d.cleared = true;
    const r = d.def.rewards;
    agent.spiritStones += r.spiritStones;
    agent.cultivation = Math.min(agent.cultivation + r.cultivation, game.def.realms[agent.realmIdx].maxCultivation);
    for (const it of r.items) {
      const inv = agent.inventory.find(i => i.name === it);
      if (inv) inv.count += 1; else agent.inventory.push({ name: it, count: 1 });
    }
    agent.dungeonsCleared += 1;
    game.addLog(`【${agent.name}】通关【${d.def.name}】！获得修为 +${r.cultivation}，灵石 +${r.spiritStones}，物品【${r.items.join('、')}】。`, 'breakthrough');
    exitDungeon(game, agent, `${agent.name} 带着战利品离开了【${d.def.name}】。`);
    return { cleared: true, rewards: r };
  }
  game.addLog(`${agent.name} 整了整衣衫，继续前行。`, 'dungeon');
  return { cleared: false };
}
