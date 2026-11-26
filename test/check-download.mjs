// 验证 GitHub 发布物可下载（node fetch，独立于 PowerShell 的 schannel 栈）
import { writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";

const results = [];
for (const [name, url] of [
  ["bootstrap.ps1 (raw)", "https://raw.githubusercontent.com/aaron-he-zhu/t3-deepseek/main/bootstrap.ps1"],
  ["zip (codeload)", "https://codeload.github.com/aaron-he-zhu/t3-deepseek/zip/refs/heads/main"],
]) {
  try {
    const response = await fetch(url);
    const buffer = Buffer.from(await response.arrayBuffer());
    results.push(`${name}: HTTP ${response.status}, ${buffer.length} bytes`);
    if (name.includes("zip")) {
      const out = join(process.cwd(), "test", "tmp", "ds.zip");
      mkdirSync(dirname(out), { recursive: true });
      writeFileSync(out, buffer);
    }
  } catch (error) {
    results.push(`${name}: 失败 ${error.message ?? error}`);
  }
}
console.log(results.join("\n"));
