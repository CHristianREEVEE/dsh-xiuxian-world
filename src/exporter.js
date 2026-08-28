// src/exporter.js — 导出自包含回放 HTML + 修炼日记 Markdown
// 回放 HTML：模板 + window.__RECORDING__ 内联数据，双击即看，零依赖零服务器。
// 修炼日记：从 frames/logs/toolCalls 结构化生成的本次云游总结。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATE_PATH = path.join(__dirname, 'replay-template.html');

function pad(n) { return String(n).padStart(2, '0'); }
function dateTag(d = new Date()) {
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

// ---------- 修炼日记 ----------
function renderDiary(rec, toolCalls, meta) {
  const { frames, logs } = rec;
  const L = [];
  const CN = ['一', '二', '三', '四', '五'];
  let sec = 0;
  L.push(`# 修炼日记 · ${meta.dateLabel}`);
  L.push('');
  L.push(`> ${meta.agentName} 于云仙大世界的一段旅程。世界历 ${rec.meta.days} 日，自动记录。`);
  if (meta.summary) L.push(`> 修士自述：${meta.summary}`);
  L.push('');

  // 起止状态对比：起点取修士首次出现的帧（会话中途创角也正确）
  const last = frames[frames.length - 1];
  const lastMe = last?.state?.agents?.find(a => a.name === meta.agentName);
  const firstFrame = frames.find(f => f.state?.agents?.some(a => a.name === meta.agentName));
  const firstMe = firstFrame?.state.agents.find(a => a.name === meta.agentName);
  if (firstMe && lastMe) {
    L.push(`## ${CN[sec++]}、行囊与境界`);
    L.push('');
    L.push(`- 起点：${firstMe.realmName}（修为 ${firstMe.cultivation}/${firstMe.cultivationMax}），身负 ${firstMe.spiritStones} 灵石`);
    L.push(`- 归处：${lastMe.dead ? `已身殒（${lastMe.deathReason || '寿元耗尽'}）` : `${lastMe.realmName}（修为 ${lastMe.cultivation}/${lastMe.cultivationMax}）`}，身负 ${lastMe.spiritStones} 灵石`);
    L.push(`- 战绩：斩敌 ${Math.max(0, (lastMe.kills || 0) - (firstMe.kills || 0))} 名，通关秘境 ${Math.max(0, (lastMe.dungeonsCleared || 0) - (firstMe.dungeonsCleared || 0))} 处`);
    L.push('');
  }

  // 境界跃迁、重要事件
  const notable = logs.filter(l =>
    l.type === 'breakthrough' || /突破|斩杀|身殒|转世|大乘|秘境|奇缘|机缘/.test(l.text)
  ).slice(0, 40);
  if (notable.length) {
    L.push(`## ${CN[sec++]}、要事`);
    L.push('');
    for (const l of notable) L.push(`- 第${l.day}日：${l.text}`);
    L.push('');
  }

  // 工具调用统计
  if (toolCalls.length) {
    const okCalls = toolCalls.filter(c => c.ok).length;
    const byLabel = {};
    for (const c of toolCalls) {
      const k = (c.label || '').split(/[·:：]/)[0] || '其他';
      byLabel[k] = (byLabel[k] || 0) + 1;
    }
    const top = Object.entries(byLabel).sort((a, b) => b[1] - a[1]).slice(0, 8);
    L.push(`## ${CN[sec++]}、所作所为`);
    L.push('');
    L.push(`共出手 ${toolCalls.length} 次（成功 ${okCalls} 次）：${top.map(([k, n]) => `${k}×${n}`).join('、')}`);
    L.push('');
  }

  // 纪事摘录（最后 15 条）
  const tail = logs.slice(-15);
  if (tail.length) {
    L.push(`## ${CN[sec++]}、纪事摘录`);
    L.push('');
    for (const l of tail) L.push(`- 第${l.day}日 ${l.text}`);
    L.push('');
  }

  L.push('---');
  L.push('');
  L.push(`*此日记由 dsh-xiuxian-world 自动生成。回放：${meta.htmlName}*`);
  L.push('');
  return L.join('\n');
}

export class Exporter {
  constructor(game, recorder, dataDir) {
    this.game = game;
    this.recorder = recorder;
    this.recDir = path.join(dataDir, 'recordings');
    fs.mkdirSync(this.recDir, { recursive: true });
    if (!fs.existsSync(TEMPLATE_PATH)) {
      throw new Error(`replay template missing: ${TEMPLATE_PATH}`);
    }
  }

  #keepRecent(n = 50) {
    try {
      const files = fs.readdirSync(this.recDir)
        .filter(f => f.endsWith('.html') || f.endsWith('.md'))
        .map(f => ({ f, m: fs.statSync(path.join(this.recDir, f)).mtimeMs }))
        .sort((a, b) => b.m - a.m);
      for (const old of files.slice(n)) {
        try { fs.unlinkSync(path.join(this.recDir, old.f)); } catch { /* ignore */ }
      }
    } catch { /* ignore */ }
  }

  exportSession(meta = {}) {
    const rec = this.recorder;
    // 收官快照：把最新状态截进录像再导出
    rec.stop();
    const now = new Date();
    const dateLabel = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
    const tag = dateTag(now);

    const recording = {
      meta: {
        recordedAt: now.toISOString(),
        world: this.game.def.id,
        days: Math.floor(this.game.state.world.gameDay),
        agentCount: this.game.allAgents().length,
      },
      world: this.game.def,
      frames: rec.frames,
      logs: rec.logs,
    };

    // ---------- 自包含回放 HTML ----------
    let warning = '';
    let htmlName = `修炼回放-${meta.agentName || '修士'}-${tag}.html`;
    let mdName = `修炼日记-${meta.agentName || '修士'}-${tag}.md`;
    const dataJson = JSON.stringify(recording);
    let template;
    try {
      template = fs.readFileSync(TEMPLATE_PATH, 'utf-8');
    } catch (e) {
      return { ok: false, warning: `回放模板读取失败：${e.message}`, days: recording.meta.days, frames: 0, logs: 0 };
    }
    const title = `云仙大世界 · ${meta.agentName || '修士'}的旅程`;
    const inject = `<script>window.__RECORDING__ = ${dataJson};</script>`;
    const html = template
      .replace('__REPLAY_TITLE__', title)
      .replace('</head>', `${inject}\n</head>`);
    const htmlPath = path.join(this.recDir, htmlName);
    try {
      fs.writeFileSync(htmlPath, html);
    } catch (e) {
      warning = `回放写入失败：${e.message}`;
    }

    // ---------- 修炼日记 ----------
    const diary = renderDiary(recording, rec.toolCalls, { ...meta, dateLabel, htmlName });
    const mdPath = path.join(this.recDir, mdName);
    try {
      fs.writeFileSync(mdPath, diary);
    } catch (e) {
      warning = warning || `日记写入失败：${e.message}`;
    }

    const result = {
      ok: true,
      htmlPath,
      mdPath,
      htmlName,
      mdName,
      days: recording.meta.days,
      frames: rec.frames.length,
      logs: rec.logs.length,
      warning,
    };

    // 导出后清空录像，为下次会话准备
    rec.reset();
    this.#keepRecent(50);
    return result;
  }
}
