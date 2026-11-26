// 协议级测试：进程内驱动 T3DeepSeekAgent（不 spawn 子进程，规避沙箱 EPERM）。
// 模拟 T3 Code 客户端的 JSON-RPC 行为，mock 后端不访问真实 DeepSeek API。
// 运行：node test/harness.mjs
import { join, dirname } from "node:path";
import { readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { createServer } from "node:http";
import { T3DeepSeekAgent } from "../src/acp-server.mjs";

const root = join(fileURLToPath(import.meta.url), "..", "..");

let failures = 0;
const check = (name, condition, detail = "") => {
  console.log(`${condition ? "  PASS" : "  FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!condition) failures += 1;
};

const baseConfig = {
  path: join(root, "test", "mock-config.json"),
  apiKey: "",
  baseUrl: "https://api.deepseek.com",
  defaultModel: "deepseek-chat",
  maxTokens: {},
  mock: true,
  models: [
    { id: "deepseek-chat", name: "DeepSeek-V3 (deepseek-chat)", description: "通用对话与编码模型" },
    { id: "deepseek-reasoner", name: "DeepSeek-R1 (deepseek-reasoner)", description: "深度推理模型" },
  ],
};

/** 模拟 T3 Code 客户端。 */
class FakeClient {
  constructor(agent) {
    this.agent = agent;
    this.nextId = 1;
    this.pending = new Map();
    this.updates = [];
    this.elicitationResponse = { action: "decline" };
    this.onAgentMessage = this.onAgentMessage.bind(this);
  }
  request(method, params) {
    const id = this.nextId++;
    const promise = new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
    this.agent.feedLine(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    return promise;
  }
  notify(method, params) {
    this.agent.feedLine(JSON.stringify({ jsonrpc: "2.0", method, params }));
  }
  onAgentMessage(msg) {
    if (msg.method !== undefined && msg.id !== undefined) {
      this.answerServerRequest(msg).catch(() => {});
    } else if (msg.id !== undefined) {
      const p = this.pending.get(msg.id);
      if (p) {
        this.pending.delete(msg.id);
        msg.error !== undefined ? p.reject(msg.error) : p.resolve(msg.result);
      }
    } else if (msg.method === "session/update") {
      this.updates.push(msg.params.update);
    }
  }
  async answerServerRequest(msg) {
    const { id, method, params } = msg;
    const ok = (result) => this.agent.feedLine(JSON.stringify({ jsonrpc: "2.0", id, result }));
    switch (method) {
      case "session/request_permission": {
        if (params.options.some((o) => o.kind === "allow_once")) return ok({ outcome: "selected", optionId: "allow_once" });
        return ok({ outcome: "selected", optionId: params.options[0].optionId });
      }
      case "fs/read_text_file":
        return ok({ content: `# mock content of ${params.path}\nline2\n` });
      case "fs/write_text_file":
        return ok({});
      case "terminal/create":
        return ok({ terminalId: "mock-terminal-1" });
      case "terminal/output":
        return ok({ output: "hello.txt\nREADME.md", truncated: false });
      case "terminal/wait_for_exit":
        return ok({ exitCode: 0, signal: null });
      case "terminal/release":
        return ok({});
      case "terminal/kill":
        return ok({});
      case "elicitation/create":
        return ok(this.elicitationResponse);
      default:
        return ok({});
    }
  }
}

function makeAgent(configOverrides = {}) {
  const agent = new T3DeepSeekAgent({
    config: { ...baseConfig, ...configOverrides },
    onWrite: () => {}, // 先接空实现，再替换
    onLog: () => {},
  });
  const client = new FakeClient(agent);
  agent.onWrite = client.onAgentMessage;
  return { agent, client };
}

async function scenario1() {
  console.log("场景 1：initialize → session/new → prompt（含工具调用与权限）");
  const { client } = makeAgent();

  const init = await client.request("initialize", {
    protocolVersion: 1,
    clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: true },
    clientInfo: { name: "harness", title: "T3 DeepSeek test harness", version: "0.0.0" },
  });
  check("initialize 返回 protocolVersion 1", init.protocolVersion === 1);
  check("agentInfo 名称正确", init.agentInfo?.name === "t3-deepseek", JSON.stringify(init.agentInfo));
  check("无 authMethods", Array.isArray(init.authMethods) && init.authMethods.length === 0);
  check("声明了 close 能力", init.agentCapabilities?.sessionCapabilities?.close !== undefined);

  const created = await client.request("session/new", { cwd: join(tmpdir(), "t3ds-test"), mcpServers: [] });
  const modelOption = created.configOptions?.find((o) => o.category === "model");
  check("session/new 返回模型选项(select)", modelOption?.type === "select", JSON.stringify(modelOption));
  check("模型列表包含 deepseek-chat", modelOption?.options?.some((o) => o.value === "deepseek-chat"));
  check("模型列表包含 deepseek-reasoner", modelOption?.options?.some((o) => o.value === "deepseek-reasoner"));

  const promptResult = await client.request("session/prompt", {
    sessionId: created.sessionId,
    prompt: [{ type: "text", text: "你好，请创建一个 hello 程序" }],
  });
  check("prompt 返回 stopReason=end_turn", promptResult.stopReason === "end_turn", JSON.stringify(promptResult));
  const updates = client.updates;
  check("收到 agent_message_chunk", updates.some((u) => u.sessionUpdate === "agent_message_chunk"));
  check("收到 agent_thought_chunk", updates.some((u) => u.sessionUpdate === "agent_thought_chunk"));
  check("收到 tool_call 创建事件", updates.some((u) => u.sessionUpdate === "tool_call"));
  check(
    "收到 tool_call_update completed",
    updates.some((u) => u.sessionUpdate === "tool_call_update" && u.status === "completed"),
  );
  check("收到 usage_update", updates.some((u) => u.sessionUpdate === "usage_update"));
  const toolCall = updates.find((u) => u.sessionUpdate === "tool_call");
  check("tool_call 带 kind 与 rawInput", toolCall?.kind !== undefined && toolCall?.rawInput !== undefined);
  check("write_file 结果为 diff 内容", updates.some((u) => u.sessionUpdate === "tool_call_update" && u.content?.some((c) => c.type === "diff")));
  const failed = updates.filter((u) => u.sessionUpdate === "tool_call_update" && u.status === "failed");
  if (failed.length > 0) {
    console.log("  (失败明细) " + failed.map((u) => `${u.kind}: ${u.content?.[0]?.content?.text ?? u.content?.[0]?.text ?? ""}`).join(" ;; "));
  }

  // 模型切换
  const switched = await client.request("session/set_config_option", {
    sessionId: created.sessionId,
    configId: "model",
    value: "deepseek-reasoner",
  });
  check(
    "set_config_option 切换模型生效",
    switched.configOptions?.find((o) => o.category === "model")?.currentValue === "deepseek-reasoner",
  );
  const invalid = await client
    .request("session/set_config_option", { sessionId: created.sessionId, configId: "model", value: "gpt-99" })
    .catch((e) => e);
  check("非法模型返回 -32602", invalid?.code === -32602, JSON.stringify(invalid));

  const closed = await client.request("session/close", { sessionId: created.sessionId });
  check("session/close 返回 {}", closed !== undefined);
}

async function scenario2() {
  console.log("\n场景 2：prompt 进行中收到 session/cancel → stopReason=cancelled");
  process.env.T3DEEPSEEK_MOCK_SLOW = "1";
  const { client } = makeAgent();
  await client.request("initialize", {
    protocolVersion: 1,
    clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: true },
  });
  const s2 = await client.request("session/new", { cwd: root, mcpServers: [] });
  const promptPromise = client.request("session/prompt", {
    sessionId: s2.sessionId,
    prompt: [{ type: "text", text: "一个会拖很久的任务" }],
  });
  setTimeout(() => client.notify("session/cancel", { sessionId: s2.sessionId }), 150);
  const cancelled = await promptPromise;
  check("取消后返回 stopReason=cancelled", cancelled.stopReason === "cancelled", JSON.stringify(cancelled));
  delete process.env.T3DEEPSEEK_MOCK_SLOW;
}

async function scenario3() {
  console.log("\n场景 3：未知方法返回 -32601、坏 JSON 返回 -32700");
  const { agent, client } = makeAgent();
  const unknown = await client.request("session/evil", {}).catch((e) => e);
  check("未知方法 -32601", unknown?.code === -32601, JSON.stringify(unknown));

  const captured = [];
  const forward = agent.onWrite;
  agent.onWrite = (msg) => {
    if (msg.error) captured.push(msg.error);
    forward(msg);
  };
  agent.feedLine("{not json");
  check("坏 JSON -32700", captured.some((e) => e.code === -32700), JSON.stringify(captured));
}

async function scenario4() {
  console.log("\n场景 4：工具相对路径归一化为会话 cwd 下的绝对路径");
  const win = process.platform === "win32";
  const cwd = win ? "C:\\proj" : "/proj";
  const rel = win ? "src\\a.txt" : "src/a.txt";
  const abs = win ? "C:\\abs\\b.txt" : "/abs/b.txt";
  const expectedRel = win ? "C:\\proj\\src\\a.txt" : "/proj/src/a.txt";
  const { agent, client } = makeAgent();
  const created = await client.request("session/new", { cwd, mcpServers: [] });
  const session = agent.sessions.get(created.sessionId);
  const receivedPaths = [];
  const forward = agent.onWrite;
  agent.onWrite = (msg) => {
    if (msg.method === "fs/write_text_file") receivedPaths.push(msg.params.path);
    forward(msg);
  };
  await agent.execTool(session, "write_file", { path: rel, content: "x" });
  await agent.execTool(session, "write_file", { path: abs, content: "y" });
  check("相对路径归一化为 cwd 下绝对路径", receivedPaths[0] === expectedRel, String(receivedPaths[0]));
  check("绝对路径原样透传", receivedPaths[1] === abs, String(receivedPaths[1]));
}

async function scenario5() {
  console.log("\n场景 5：未配置 Key 时弹 elicitation 表单");
  // accept 路径：表单提交 → 保存到配置文件
  {
    const tmpCfg = join(root, "test", "tmp", "elicitation-config.json");
    mkdirSync(dirname(tmpCfg), { recursive: true });
    writeFileSync(tmpCfg, '{"version":1,"baseUrl":"https://api.deepseek.com","defaultModel":"deepseek-chat"}');
    const { agent, client } = makeAgent({ apiKey: "", mock: true, path: tmpCfg });
    client.elicitationResponse = { action: "accept", content: { apiKey: "sk-elicited-123" } };
    await client.request("initialize", {
      protocolVersion: 1,
      clientCapabilities: { elicitation: { form: {}, url: {} } },
    });
    const created = await client.request("session/new", { cwd: root, mcpServers: [] });
    const ok = await agent.ensureApiKey(agent.sessions.get(created.sessionId));
    check("表单提交后返回 true", ok === true);
    check("内存中 Key 已更新", agent.config.apiKey === "sk-elicited-123");
    const saved = JSON.parse(readFileSync(tmpCfg, "utf8"));
    check("Key 已持久化到配置文件", saved.apiKey === "sk-elicited-123");
  }
  // decline 路径
  {
    const { agent, client } = makeAgent({ apiKey: "", mock: true });
    client.elicitationResponse = { action: "decline" };
    await client.request("initialize", {
      protocolVersion: 1,
      clientCapabilities: { elicitation: { form: {} } },
    });
    const created = await client.request("session/new", { cwd: root, mcpServers: [] });
    const ok = await agent.ensureApiKey(agent.sessions.get(created.sessionId));
    check("用户拒绝后返回 false", ok === false);
    check("拒绝后 Key 仍为空", agent.config.apiKey === "");
  }
  // 客户端不支持表单 → 给出命令行指引
  {
    const { agent, client } = makeAgent({ apiKey: "", mock: true });
    await client.request("initialize", {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: true },
    });
    const created = await client.request("session/new", { cwd: root, mcpServers: [] });
    const ok = await agent.ensureApiKey(agent.sessions.get(created.sessionId));
    check("客户端不支持表单时返回 false", ok === false);
    const texts = client.updates
      .filter((u) => u.sessionUpdate === "agent_message_chunk")
      .map((u) => u.content?.text ?? "")
      .join("");
    check("指引中包含 install.ps1 命令", texts.includes("install.ps1"));
  }
}

async function scenario6() {
  console.log("\n场景 6：真实 HTTP + SSE 流式路径（本地 mock 服务器）");
  // 模拟 DeepSeek 的 /chat/completions 流式响应：增量 reasoning/content/tool_calls + usage
  const sseRounds = [
    [
      { choices: [{ delta: { reasoning_content: "先看看目录。" } }] },
      { choices: [{ delta: { content: "我来查看目录。" } }] },
      {
        choices: [
          {
            delta: {
              tool_calls: [
                { index: 0, id: "call_sse_1", function: { name: "bash", arguments: "{\"command\":\"" } },
              ],
            },
          },
        ],
      },
      {
        choices: [
          { delta: { tool_calls: [{ index: 0, function: { arguments: "dir\"}" } }] } },
        ],
      },
      { choices: [{ delta: {}, finish_reason: "tool_calls" }], usage: { total_tokens: 101 } },
    ],
    [
      { choices: [{ delta: { content: "完成！" } }] },
      { choices: [{ delta: {}, finish_reason: "stop" }], usage: { total_tokens: 202 } },
    ],
  ];
  const seen = { requests: 0, authHeader: null, lastBody: null };
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      seen.requests += 1;
      seen.authHeader = req.headers.authorization ?? null;
      seen.lastBody = body;
      const round = sseRounds[Math.min(seen.requests - 1, sseRounds.length - 1)];
      res.writeHead(200, { "content-type": "text/event-stream" });
      for (const chunk of round) res.write(`data: ${JSON.stringify(chunk)}\n\n`);
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;

  const { client } = makeAgent({
    apiKey: "sk-local-test",
    baseUrl: `http://127.0.0.1:${port}`,
    mock: false,
  });
  await client.request("initialize", {
    protocolVersion: 1,
    clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: true },
  });
  const created = await client.request("session/new", { cwd: root, mcpServers: [] });
  const result = await client.request("session/prompt", {
    sessionId: created.sessionId,
    prompt: [{ type: "text", text: "看看目录" }],
  });
  server.close();

  check("prompt 返回 end_turn", result.stopReason === "end_turn", JSON.stringify(result));
  check("发出 2 次 API 请求（两轮）", seen.requests === 2, String(seen.requests));
  check("Authorization 头正确", seen.authHeader === "Bearer sk-local-test", String(seen.authHeader));
  check("请求体含 tools 与 stream", seen.lastBody.includes("\"tools\"") && seen.lastBody.includes("\"stream\":true"));
  const texts = client.updates
    .filter((u) => u.sessionUpdate === "agent_message_chunk")
    .map((u) => u.content?.text ?? "")
    .join("");
  check("收到流式正文", texts.includes("我来查看目录。") && texts.includes("完成！"));
  check("reasoning 增量转为 agent_thought_chunk", client.updates.some((u) => u.sessionUpdate === "agent_thought_chunk"));
  check("分块工具调用被聚合并执行", client.updates.some((u) => u.sessionUpdate === "tool_call_update" && u.status === "completed"));
  const usage = client.updates.find((u) => u.sessionUpdate === "usage_update");
  check("usage_update 使用最后一轮 usage", usage?.used === 202, JSON.stringify(usage));
}

async function main() {
  console.log("T3 DeepSeek 协议级测试（进程内 + mock 后端）\n");
  const order =
    process.env.S3_FIRST === "1"
      ? [["场景 3", scenario3], ["场景 1", scenario1], ["场景 2", scenario2], ["场景 4", scenario4], ["场景 5", scenario5], ["场景 6", scenario6]]
      : [["场景 1", scenario1], ["场景 2", scenario2], ["场景 3", scenario3], ["场景 4", scenario4], ["场景 5", scenario5], ["场景 6", scenario6]];
  for (const [name, run] of order) {
    try {
      await run();
    } catch (error) {
      console.log(`\n${name} 崩溃：`, error);
      failures += 1;
    }
  }
  try {
    rmSync(join(root, "test", "tmp"), { recursive: true, force: true });
  } catch {
    // 清理失败不影响结果
  }
  console.log(failures === 0 ? "\n全部通过 ✅" : `\n${failures} 项失败 ❌`);
  await new Promise((resolve) => setTimeout(resolve, 100)); // 等 stdout 刷新
  process.exitCode = failures === 0 ? 0 : 1;
}

main();
