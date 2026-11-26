// DeepSeek 官方 API 客户端（零依赖：Node 18+ 原生 fetch）。
// 兼容 OpenAI 风格的 /chat/completions，支持流式输出与 function calling。

export const DEEPSEEK_TOOLS = [
  {
    type: "function",
    function: {
      name: "read_file",
      description: "读取一个文本文件的全部或部分内容。",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "文件的绝对路径" },
          line: { type: "integer", description: "起始行号（1 开始），可选" },
          limit: { type: "integer", description: "最多读取的行数，可选" },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "write_file",
      description:
        "把 content 全量写入 path 指定的文件（覆盖已有内容；父目录不存在时会失败，先用 bash 创建）。",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "文件的绝对路径" },
          content: { type: "string", description: "要写入的完整文本内容" },
        },
        required: ["path", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "bash",
      description:
        "执行一条 shell 命令并返回输出。Windows 上通过 cmd.exe 执行。用于查看目录、搜索、git、构建、测试等一切非读写文本文件的操作。",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "要执行的命令（单条；多条用 && 连接）" },
          cwd: { type: "string", description: "可选，工作目录（绝对路径），默认会话目录" },
        },
        required: ["command"],
      },
    },
  },
];

const isMock = () => process.env.T3DEEPSEEK_MOCK === "1";

function mockStream() {
  // 供协议级测试使用的固定回放，不访问真实 API。
  // 有状态：每次 stream() 调用只回放"一轮"（对应真实 API 的一次请求）。
  const rounds = [
    [
      { type: "reasoning", text: "用户想要一个 Hello World 程序，我先读一下目录结构。" },
      { type: "content", text: "我来看看当前目录。" },
      {
        type: "tool_call",
        index: 0,
        id: "call_mock_1",
        name: "bash",
        args: JSON.stringify({ command: "dir" }),
      },
      { type: "finish", finishReason: "tool_calls", usage: { total_tokens: 128 } },
    ],
    [
      { type: "content", text: "目录是空的，直接创建 hello.js。" },
      {
        type: "tool_call",
        index: 0,
        id: "call_mock_2",
        name: "write_file",
        args: JSON.stringify({ path: "C:\\mock\\hello.js", content: "console.log('hello');" }),
      },
      { type: "finish", finishReason: "tool_calls", usage: { total_tokens: 256 } },
    ],
    [
      { type: "content", text: "完成！已创建 hello.js。" },
      { type: "finish", finishReason: "stop", usage: { total_tokens: 300 } },
    ],
  ];
  let round = 0;
  const slow = process.env.T3DEEPSEEK_MOCK_SLOW === "1";
  const delay = () => (slow ? new Promise((r) => setTimeout(r, 50)) : Promise.resolve());
  return async function* () {
    const items = rounds[Math.min(round, rounds.length - 1)];
    round += 1;
    for (const item of items) {
      await delay();
      yield item;
    }
  };
}

export function createDeepSeekClient(config) {
  const { apiKey, baseUrl, mock = isMock() } = config;
  const maxTokensFor = (model) =>
    config.maxTokens?.[model] ?? (model === "deepseek-reasoner" ? 32768 : 8192);
  // mock 是有状态的：一次 client 生命周期内按"轮"推进（对应真实 API 的多次请求）
  const mockGenerator = mock ? mockStream() : null;

  /**
   * 流式调用 DeepSeek chat/completions。
   * 产出事件：{type:"reasoning"|"content"|"tool_call"|"finish", ...}
   * - reasoning: {text}          推理内容（deepseek-reasoner）
   * - content: {text}            正文增量
   * - tool_call: {index,id?,name?,args?} 工具调用片段（按 index 聚合）
   * - finish: {finishReason, usage?}
   */
  async function* stream({ model, messages, signal }) {
    if (mockGenerator) {
      yield* mockGenerator();
      return;
    }
    if (!apiKey) {
      throw new Error(
        "未配置 DeepSeek API Key。请运行安装脚本：powershell -ExecutionPolicy Bypass -File install.ps1",
      );
    }
    const response = await fetch(`${baseUrl.replace(/\/+$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages,
        tools: DEEPSEEK_TOOLS,
        tool_choice: "auto",
        stream: true,
        stream_options: { include_usage: true },
        max_tokens: maxTokensFor(model),
      }),
      signal,
    });
    if (!response.ok) {
      let detail = `HTTP ${response.status}`;
      try {
        const text = await response.text();
        const parsed = JSON.parse(text);
        if (parsed?.error?.message) detail = parsed.error.message;
        else detail = `${detail} ${text.slice(0, 300)}`;
      } catch {
        // keep status text
      }
      throw new Error(`DeepSeek API 错误：${detail}`);
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let newline;
        while ((newline = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          if (!line.startsWith("data:")) continue;
          const payload = line.slice(5).trim();
          if (payload === "[DONE]") return;
          let json;
          try {
            json = JSON.parse(payload);
          } catch {
            continue;
          }
          const choice = json.choices?.[0];
          if (!choice) continue;
          const delta = choice.delta ?? {};
          if (typeof delta.reasoning_content === "string" && delta.reasoning_content) {
            yield { type: "reasoning", text: delta.reasoning_content };
          }
          if (typeof delta.content === "string" && delta.content) {
            yield { type: "content", text: delta.content };
          }
          if (Array.isArray(delta.tool_calls)) {
            for (const call of delta.tool_calls) {
              yield {
                type: "tool_call",
                index: call.index ?? 0,
                id: call.id ?? null,
                name: call.function?.name ?? null,
                args: call.function?.arguments ?? "",
              };
            }
          }
          if (choice.finish_reason) {
            yield {
              type: "finish",
              finishReason: choice.finish_reason,
              usage: json.usage ?? null,
            };
          }
        }
      }
    } finally {
      reader.releaseLock?.();
    }
  }

  return { stream };
}
