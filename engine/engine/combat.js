// combat.js — 回合制战斗系统（Agent 作用域：每个 Agent 独立战斗状态）
import { randInt } from './util.js';

// 检查 agent 是否在战斗中
export function isCombatActive(agent) {
  return !!(agent?.combat && !agent.combat.ended);
}

export function startCombat(game, agent, enemy, source = 'wild') {
  if (isCombatActive(agent)) throw new Error('已在战斗中');
  const e = { ...enemy };
  e.maxHp = e.hp;
  agent.combat = {
    enemy: e, source, round: 1, defending: false,
    startedAt: Date.now(), ended: false, victory: false, log: [],
  };
  game.addLog(`【${agent.name}】遭遇【${e.name}】！战斗开始。`, 'combat');
  game.emit('update');
  game.markDirty();
  return agent.combat;
}

function baseDamage(game, agent) {
  const path = game.def.paths[agent.path];
  let dmg = Math.floor(10 + agent.body * 2 + agent.realmIdx * 5);
  dmg = Math.floor(dmg * (path.combatMod || 1));
  dmg += randInt(-3, 5);
  return Math.max(1, dmg);
}

function enemyDamage(game, agent) {
  const c = agent.combat;
  let dmg = c.enemy.atk + randInt(-2, 3);
  if (Math.random() < 0.18) { dmg = Math.floor(dmg * 1.5); c.log.push(`${c.enemy.name}暴起发难！`); }
  dmg -= Math.floor(agent.body * 0.5);
  if (c.defending) dmg = Math.floor(dmg * 0.4);
  return Math.max(1, dmg);
}

export function combatAct(game, agent, action, skillIdx) {
  const c = agent.combat;
  if (!c || c.ended) throw new Error('当前无战斗');
  c.defending = false;
  let playerDmg = 0, healed = 0, skillName = '';

  // —— 玩家回合 ——
  if (action === 'attack') {
    playerDmg = baseDamage(game, agent);
    c.enemy.hp -= playerDmg;
    c.log.push(`${agent.name}出手，对${c.enemy.name}造成 ${playerDmg} 点伤害。`);
  } else if (action === 'defend') {
    c.defending = true;
    healed = Math.ceil(agent.maxHp * 0.05);
    agent.hp = Math.min(agent.maxHp, agent.hp + healed);
    c.log.push(`${agent.name}凝神防御，稳住阵脚。`);
  } else if (action === 'skill') {
    const path = game.def.paths[agent.path];
    const skill = path.skills[skillIdx];
    if (!skill) throw new Error('无此技能');
    if (agent.spirit < skill.spirit) throw new Error('灵力不足');
    agent.spirit -= skill.spirit;
    skillName = skill.name;
    if (skill.type === 'attack') {
      playerDmg = Math.floor(baseDamage(game, agent) * skill.mult);
      c.enemy.hp -= playerDmg;
      c.log.push(`${agent.name}施展【${skill.name}】，轰出 ${playerDmg} 点伤害！`);
    } else if (skill.type === 'heal') {
      healed = Math.ceil(agent.maxHp * skill.healPct);
      agent.hp = Math.min(agent.maxHp, agent.hp + healed);
      c.log.push(`${agent.name}施展【${skill.name}】，回复 ${healed} 点生命。`);
    } else if (skill.type === 'defend') {
      c.defending = true;
      c.defMult = skill.defMult;
      healed = Math.ceil(agent.maxHp * 0.03);
      agent.hp = Math.min(agent.maxHp, agent.hp + healed);
      c.log.push(`${agent.name}施展【${skill.name}】，严阵以待。`);
    }
    if (skill.healPct && skill.type === 'attack') {
      healed = Math.ceil(agent.maxHp * skill.healPct);
      agent.hp = Math.min(agent.maxHp, agent.hp + healed);
    }
  } else if (action === 'flee') {
    const chance = 0.5 + agent.luck * 0.015;
    if (Math.random() < chance) {
      c.ended = true; c.victory = false; c.fled = true;
      c.log.push(`${agent.name}身形一晃，遁出了战圈。`);
      agent.combat = null;
      game.addLog(`${agent.name} 逃之夭夭，捡回一条命。`, 'combat');
      game.emit('update'); game.markDirty();
      return { ok: true, result: { fled: true, combatEnded: true, log: c.log } };
    }
    c.log.push('逃跑失败，被拦了回来！');
  } else {
    throw new Error('无效的战斗行动');
  }

  // —— 敌人回合 ——
  let enemyDmg = 0;
  if (c.enemy.hp > 0) {
    enemyDmg = enemyDamage(game, agent);
    if (c.defending && c.defMult) { enemyDmg = Math.floor(enemyDmg / c.defMult); c.defMult = null; }
    agent.hp = Math.max(0, agent.hp - enemyDmg);
    c.log.push(`${c.enemy.name}反击，${agent.name}受到 ${enemyDmg} 点伤害。`);
  }

  // —— 结算 ——
  let rewards = null;
  if (c.enemy.hp <= 0) {
    c.ended = true; c.victory = true;
    agent.kills += 1;
    const cult = Math.floor(8 + c.enemy.maxHp * 0.25 + c.enemy.atk * 0.8);
    const stones = Math.floor(randInt(2, 8) + c.enemy.atk * 0.35 + agent.luck * 0.3);
    rewards = { cultivation: cult, spiritStones: stones, items: [] };
    agent.cultivation = Math.min(agent.cultivation + cult, game.def.realms[agent.realmIdx].maxCultivation);
    agent.spiritStones += stones;
    if (Math.random() < 0.3 + agent.luck * 0.02) {
      const drop = c.enemy.drops?.[randInt(0, c.enemy.drops.length - 1)] || '妖丹';
      rewards.items.push(drop);
      agent.inventory.push({ name: drop, count: 1 });
    }
    c.log.push(`${c.enemy.name}轰然倒下！获得修为 +${cult}，灵石 +${stones}${rewards.items.length ? `，拾获【${rewards.items.join('、')}】` : ''}。`);
    game.addLog(`【${agent.name}】击败【${c.enemy.name}】！`, 'combat');
  } else if (agent.hp <= 0) {
    c.ended = true; c.victory = false;
    const lostStones = Math.floor(agent.spiritStones * 0.1);
    const lostCult = Math.floor(agent.cultivation * 0.15);
    agent.spiritStones -= lostStones;
    agent.cultivation = Math.max(0, agent.cultivation - lostCult);
    agent.hp = Math.max(1, Math.floor(agent.maxHp * 0.3));
    agent.spirit = Math.max(0, Math.floor(agent.maxSpirit * 0.3));
    c.log.push(`${agent.name}不支倒地……`);
    agent.combat = null;
    agent.dungeon = null;
    agent.currentAction = null;
    agent.areaId = 'village';
    game.addLog(`${agent.name} 重伤昏迷，被路过的散修抬回青石村。（灵石 -${lostStones}，修为 -${lostCult}）`, 'event-bad');
    game.emit('update'); game.markDirty();
    return { ok: true, result: { defeat: true, combatEnded: true, log: c.log } };
  } else {
    c.round += 1;
  }

  const ended = c.ended;
  const combatSnapshot = agent.combat;
  if (ended) agent.combat = null;
  game.emit('update');
  game.markDirty();
  return {
    ok: true,
    result: {
      playerDmg, enemyDmg, healed, skillName,
      enemyHp: Math.max(0, c.enemy.hp), playerHp: Math.floor(agent.hp),
      combatEnded: ended, victory: c.victory, rewards,
      dungeonContinue: ended && c.victory && c.source === 'dungeon',
      log: c.log.slice(-6),
    },
    combat: combatSnapshot,
  };
}
