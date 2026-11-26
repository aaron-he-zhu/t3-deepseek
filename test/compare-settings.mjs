// 深度对比：原始 settings.json vs install.ps1 编辑后的副本（忽略新增的 acp_t3deepseek 条目）。
import { readFileSync } from "node:fs";

const read = (path) => JSON.parse(readFileSync(path, "utf8").replace(/^\uFEFF/, ""));
const original = read("C:/Users/Aaron/.t3/userdata/settings.json");
const edited = read("C:/Users/Aaron/Documents/t3-code/t3-deepseek/test/tmp/settings-copy.json");

delete edited.providerInstances.acp_t3deepseek;

const diffs = [];
function compare(a, b, path) {
  if (typeof a !== typeof b) {
    diffs.push(`${path}: 类型不同 ${typeof a} vs ${typeof b} (${JSON.stringify(a)} vs ${JSON.stringify(b)})`);
    return;
  }
  if (a === null || b === null) {
    if (a !== b) diffs.push(`${path}: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`);
    return;
  }
  if (typeof a === "object") {
    if (Array.isArray(a) !== Array.isArray(b)) {
      diffs.push(`${path}: 数组/对象不一致`);
      return;
    }
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const key of keys) compare(a[key], b[key], `${path}.${key}`);
    return;
  }
  if (a !== b) diffs.push(`${path}: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`);
}
compare(original, edited, "settings");

if (diffs.length === 0) {
  console.log("深度对比：编辑后副本与原文件完全一致（仅新增了 acp_t3deepseek）✅");
  console.log(`providerInstances 原有 ${Object.keys(original.providerInstances).length} 项全部保留`);
} else {
  console.log(`发现 ${diffs.length} 处差异 ❌`);
  for (const d of diffs.slice(0, 30)) console.log("  " + d);
  process.exitCode = 1;
}
