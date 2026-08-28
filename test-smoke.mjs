// test-smoke.mjs — 插件全链路烟雾测试（不依赖真实 DSH 运行时）
// 模拟：启动世界 → DSH agent 创角 → 总览 → 修炼 → 收工导出 → 校验产物
import fs from 'node:fs';
import path from 'node:path';
import { apply } from './src/index.js';

const registered = [];
const disposers = [];
const fakeCtx = {
  tools: { register(t) { registered.push(t); } },
  on(evt, cb) { if (evt === 'dispose') disposers.push(cb); },
};

console.log('── 1. 启动插件 ──');
apply(fakeCtx, { npcCount: 4, npcIntervalSec: 30, tickMs: 100, idleMinutes: 20 });

console.log(`注册工具数：${registered.length}`);
const byName = Object.fromEntries(registered.map(t => [t.name, t]));
const expected = [
  'xiuxian_overview', 'xiuxian_create_character', 'xiuxian_reincarnate', 'xiuxian_act',
  'xiuxian_move', 'xiuxian_combat', 'xiuxian_dungeon', 'xiuxian_shop', 'xiuxian_use_item',
  'xiuxian_sense', 'xiuxian_talk', 'xiuxian_messages', 'xiuxian_wait', 'xiuxian_logs',
  'xiuxian_set_speed', 'xiuxian_leave_world',
];
const missing = expected.filter(n => !byName[n]);
console.log(missing.length ? `✗ 缺工具：${missing.join(',')}` : '✓ 16 个工具全部注册');

const exec = { agent: { id: 'dsh-test-agent-0001' }, signal: new AbortController().signal };

console.log('\n── 2. 创角 ──');
let r = await byName.xiuxian_create_character.execute(
  { name: '测试道人', path: 'sword', body: 10, comprehension: 10, luck: 9 }, exec);
console.log(r.slice(0, 200));

console.log('\n── 3. 总览 ──');
r = await byName.xiuxian_overview.execute({}, exec);
console.log(r.slice(0, 300));

console.log('\n── 4. 时间加速 + 修炼 ──');
r = await byName.xiuxian_set_speed.execute({ speed: '5' }, exec);
console.log(r.slice(0, 80));
r = await byName.xiuxian_act.execute({ type: 'cultivate' }, exec);
console.log(r.slice(0, 260));

console.log('\n── 5. 收工导出 ──');
r = await byName.xiuxian_leave_world.execute({ summary: '初次踏入云仙大世界，练气修行。' }, exec);
console.log(r);

console.log('\n── 6. 校验产物 ──');
const recDir = path.resolve('data/recordings');
const files = fs.readdirSync(recDir);
console.log('recordings/:', files.join(' | '));
const html = files.find(f => f.endsWith('.html'));
const md = files.find(f => f.endsWith('.md'));
let pass = true;
if (!html) { console.log('✗ 缺回放 HTML'); pass = false; }
else {
  const content = fs.readFileSync(path.join(recDir, html), 'utf-8');
  const hasData = content.includes('window.__RECORDING__');
  const hasTitle = content.includes('测试道人');
  console.log(`回放 ${html}：${(content.length / 1024).toFixed(0)}KB，内联数据=${hasData}，标题含修士名=${hasTitle}`);
  if (!hasData) pass = false;
}
if (!md) { console.log('✗ 缺修炼日记'); pass = false; }
else {
  const diary = fs.readFileSync(path.join(recDir, md), 'utf-8');
  console.log(`── 日记预览（${md}）──`);
  console.log(diary.slice(0, 600));
}

console.log('\n── 7. 卸载插件 ──');
for (const cb of disposers) cb();
console.log(pass ? '\n✅ 烟雾测试全部通过' : '\n❌ 有失败项');
process.exit(pass ? 0 : 1);
