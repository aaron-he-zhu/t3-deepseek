// 真实 API 端到端冒烟测试：用 T3DEEPSEEK_API_KEY 环境变量里的 Key 调 DeepSeek 官方 API。
// 进程内驱动 agent，一次简短对话，验证流式输出与工具调用闭环。
// 运行前设置：$env:T3DEEPSEEK_API_KEY = "sk-…"
import { T3DeepSeekAgent } from "../src/acp-server.mjs";

const apiKey = process.env.T3DEEPSEEK_API_KEY;
if (!apiKey) {
  console.log("未设置 T3DEEPSEEK_API_KEY，跳过。");
  process.exitCode = 2;
} else {
  const agent = new T3DeepSeekAgent({
    config: {
      path: "<live>",
      apiKey,
      baseUrl: process.env.T3DEEPSEEK_BASE_URL || "https://api.deepseek.com",
      defaultModel: process.env.T3DEEPSEEK_MODEL || "deepseek-chat",
      maxTokens: {},
      mock: false,
      models: [
        { id: "deepseek-chat", name: "DeepSeek-V3 (deepseek-chat)" },
        { id: "deepseek-reasoner", name: "DeepSeek-R1 (deepseek-reasoner)" },
      ],
    },
    onLog: () => {},
  });

  const nextId = { n: 1 };
  const pending = new Map();
  const updates = [];
  agent.onWrite = (msg) => {
    if (msg.method !== undefined && msg.id !== undefined) {
      // 客户端侧方法：一律批准/回 mock 结果
      let result = {};
      switch (msg.method) {
        case "session/request_permission":
          result = { outcome: "selected", optionId: "allow_once" };
          break;
        case "fs/read_text_file":
          result = { content: "console.log('hi');" };
          break;
        case "terminal/create":
          result = { terminalId: "live-terminal-1" };
          break;
        case "terminal/output":
          result = { output: "hi", truncated: false };
          break;
        case "terminal/wait_for_exit":
          result = { exitCode: 0, signal: null };
          break;
        default:
          result = {};
      }
      agent.feedLine(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }));
    } else if (msg.id !== undefined) {
      const p = pending.get(msg.id);
      if (p) {
        pending.delete(msg.id);
        msg.error !== undefined ? p.reject(msg.error) : p.resolve(msg.result);
      }
    } else if (msg.method === "session/update") {
      updates.push(msg.params.update);
    }
  };
  const request = (method, params) => {
    const id = nextId.n++;
    const promise = new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
    agent.feedLine(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    return promise;
  };

  try {
    const init = await request("initialize", { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: true } });
    console.log("initialize:", init.agentInfo?.title, init.agentInfo?.version);
    const created = await request("session/new", { cwd: process.cwd(), mcpServers: [] });
    const t0 = Date.now();
    const result = await request("session/prompt", {
      sessionId: created.sessionId,
      prompt: [{ type: "text", text: "用一句话介绍你自己，并说出你的模型名。" }],
    });
    const ms = Date.now() - t0;
    const text = updates
      .filter((u) => u.sessionUpdate === "agent_message_chunk")
      .map((u) => u.content?.text ?? "")
      .join("");
    const toolCalls = updates.filter((u) => u.sessionUpdate === "tool_call").length;
    console.log(`stopReason=${result.stopReason} 耗时=${ms}ms 文本=${text.slice(0, 120)}…`);
    console.log(`工具调用次数=${toolCalls} 更新事件=${updates.length}`);
    console.log(text ? "真实 API 端到端验证通过 ✅" : "未收到回复文本 ❌");
    process.exitCode = text && result.stopReason === "end_turn" ? 0 : 1;
  } catch (error) {
    console.log("真实 API 测试失败：", error.message ?? error);
    process.exitCode = 1;
  }
}
