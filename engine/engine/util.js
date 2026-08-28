// util.js — 通用工具
export const randInt = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;
export const clamp = (v, min, max) => Math.max(min, Math.min(max, v));
export const now = () => Date.now();

export function weightedPick(list, weightKey = 'weight') {
  const total = list.reduce((s, i) => s + (i[weightKey] || 1), 0);
  let r = Math.random() * total;
  for (const item of list) {
    r -= item[weightKey] || 1;
    if (r <= 0) return item;
  }
  return list[list.length - 1];
}

export const SEASONS = ['春', '夏', '秋', '冬'];
export const SHICHEN = ['子', '丑', '寅', '卯', '辰', '巳', '午', '未', '申', '酉', '戌', '亥'];
