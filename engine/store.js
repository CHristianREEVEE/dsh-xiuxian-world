// store.js — JSON 文件持久化（按设计文档 7.x：data/ 目录）
import fs from 'node:fs';
import path from 'node:path';

export class Store {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.saveFile = path.join(dataDir, 'save.json');
    this.configFile = path.join(dataDir, 'agent-config.json');
    fs.mkdirSync(dataDir, { recursive: true });
  }

  load() {
    try {
      if (fs.existsSync(this.saveFile)) {
        return JSON.parse(fs.readFileSync(this.saveFile, 'utf-8'));
      }
    } catch (e) {
      console.error('[store] 读取存档失败:', e.message);
    }
    return null;
  }

  save(state) {
    try {
      const tmp = this.saveFile + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(state, null, 1));
      fs.renameSync(tmp, this.saveFile);
    } catch (e) {
      console.error('[store] 写入存档失败:', e.message);
    }
  }

  loadAgentConfig() {
    try {
      if (fs.existsSync(this.configFile)) {
        const cfg = JSON.parse(fs.readFileSync(this.configFile, 'utf-8'));
        // API Key 不回传浏览器（返回时由 runner 过滤）
        return cfg;
      }
    } catch (e) {
      console.error('[store] 读取 Agent 配置失败:', e.message);
    }
    return null;
  }

  saveAgentConfig(cfg) {
    try {
      fs.writeFileSync(this.configFile, JSON.stringify(cfg, null, 1));
    } catch (e) {
      console.error('[store] 写入 Agent 配置失败:', e.message);
    }
  }
}
