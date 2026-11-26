#!/usr/bin/env node
// T3 DeepSeek — 把 DeepSeek 官方 API 接进 T3 Code 的本地 ACP agent。
// 协议：Agent Client Protocol v1（JSON-RPC 2.0 / NDJSON over stdio）。
// 零依赖：仅使用 Node 内置模块，由 T3 Code 自带的 Electron(ELECTRON_RUN_AS_NODE) 或任意 Node 18+ 运行。
import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, isAbsolute, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createDeepSeekClient } from "./deepseek-client.mjs";
import { SYSTEM_PROMPT } from "./prompts.mjs";

// 需要 Node 18+（原生 fetch / findLast）
const NODE_MAJOR = Number(String(process.versions.node).split(".")[0]);
if (!Number.isFinite(NODE_MAJOR) || NODE_MAJOR < 18) {
  process.stderr.write(
    `[t3-deepseek] 需要 Node 18+，当前为 ${process.versions.node}。请安装 Node，或更新 T3 Code 以使用其内置运行时。\n`,
  );
  process.exit(1);
}

const VERSION = "0.1.0";
const MAX_STEPS = 24; // 单轮最多工具往返次数
const MAX_CONTEXT_CHARS = 160_000; // 粗略上下文上限（字符）
const READ_LIMIT_LINES = 2000; // read_file 默认读取行数
const MAX_TOOL_OUTPUT_CHARS = 60_000; // 工具输出喂给模型的最大字符数
const MAX_BASH_OUTPUT_BYTES = 200_000; // 终端输出字节上限
const CONTEXT_WINDOW_TOKENS = 64_000; // usage_update 展示用

// ---------- 配置 ----------
export function loadConfig(env = process.env) {
  const path = env.T3DEEPSEEK_CONFIG || join(homedir(), ".t3-deepseek", "config.json");
  let raw = {};
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    // 配置缺失时仍启动，让 session/new 报出友好错误
  }
  const models =
    Array.isArray(raw.models) && raw.models.length > 0
      ? raw.models
      : [
          { id: "deepseek-chat", name: "DeepSeek-V3 (deepseek-chat)", description: "通用对话与编码模型" },
          { id: "deepseek-reasoner", name: "DeepSeek-R1 (deepseek-reasoner)", description: "深度推理模型" },
        ];
  const defaultModel =
    typeof raw.defaultModel === "string" && models.some((m) => m.id === raw.defaultModel)
      ? raw.defaultModel
      : models[0].id;
  return {
    path,
    apiKey: env.T3DEEPSEEK_API_KEY || raw.apiKey || "",
    baseUrl: raw.baseUrl || "https://api.deepseek.com",
    models,
    defaultModel,
    maxTokens: raw.maxTokens || {},
    mock: env.T3DEEPSEEK_MOCK === "1",
  };
}

class AbortedError extends Error {
  constructor() {
    super("aborted");
    this.name = "AbortedError";
  }
}
const isAborted = (error) => error instanceof AbortedError || error?.name === "AbortError";

export class T3DeepSeekAgent {
  constructor({ config = null, onWrite = null, onLog = null } = {}) {
    this.config = config ?? loadConfig();
    this.onWrite = onWrite ?? ((message) => process.stdout.write(JSON.stringify(message) + "\n"));
    this.log = onLog ?? ((...args) => process.stderr.write(`[t3-deepseek] ${args.map(String).join(" ")}\n`));
    this.pending = new Map(); // id -> {resolve, reject}
    this.nextRequestId = 1;
    this.sessions = new Map();
    this.sessionSeq = 0;
    this.clientCapabilities = {};
  }

  // ---------- 输出 ----------
  send(message) {
    this.onWrite(message);
  }
  sendResult(id, result) {
    this.send({ jsonrpc: "2.0", id, result });
  }
  sendError(id, code, message, data) {
    this.send({ jsonrpc: "2.0", id, error: { code, message, ...(data === undefined ? {} : { data }) } });
  }
  sendNotification(method, params) {
    this.send({ jsonrpc: "2.0", method, params });
  }
  sendUpdate(sessionId, update) {
    this.sendNotification("session/update", { sessionId, update });
  }

  /** 调用客户端（T3）暴露的方法。signal 可以是 AbortSignal 或 AbortController。 */
  callClient(method, params, { signal } = {}) {
    const sig = signal && typeof signal.addEventListener === "function" ? signal : signal?.signal;
    return new Promise((resolve, reject) => {
      const id = this.nextRequestId++;
      const onAbort = () => {
        if (this.pending.delete(id)) reject(new AbortedError());
      };
      if (sig) {
        if (sig.aborted) return reject(new AbortedError());
        sig.addEventListener("abort", onAbort, { once: true });
      }
      this.pending.set(id, {
        resolve: (value) => {
          sig?.removeEventListener("abort", onAbort);
          resolve(value);
        },
        reject: (error) => {
          sig?.removeEventListener("abort", onAbort);
          reject(error);
        },
      });
      this.send({ jsonrpc: "2.0", id, method, params });
    });
  }

  // ---------- 入口：处理一行协议消息 ----------
  feedLine(line) {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      this.sendError(null, -32700, "解析错误");
      return;
    }
    if (msg.method !== undefined && msg.id !== undefined) {
      this.handleRequest(msg);
    } else if (msg.method !== undefined) {
      this.handleNotification(msg);
    } else if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
      const entry = this.pending.get(msg.id);
      if (entry) {
        this.pending.delete(msg.id);
        if (msg.error !== undefined) {
          entry.reject(Object.assign(new Error(msg.error.message || "客户端错误"), { code: msg.error.code }));
        } else {
          entry.resolve(msg.result);
        }
      }
    }
  }

  handleNotification(msg) {
    if (msg.method === "session/cancel") {
      const session = this.sessions.get(msg.params?.sessionId);
      if (session?.abort) {
        this.log("session/cancel", session.id);
        session.abort.abort();
      }
    }
    // 其余通知一律忽略
  }

  async handleRequest(msg) {
    const handler = this.handlers()[msg.method];
    if (!handler) {
      this.sendError(msg.id, -32601, `未知方法：${msg.method}`);
      return;
    }
    try {
      const result = await handler.call(this, msg.params ?? {});
      this.sendResult(msg.id, result);
    } catch (error) {
      if (isAborted(error)) {
        this.sendError(msg.id, -32800, "请求已取消");
        return;
      }
      this.sendError(msg.id, error.code ?? -32603, error.message || String(error));
    }
  }

  handlers() {
    const self = this;
    return {
      async initialize(params) {
        if (params.protocolVersion !== 1) {
          throw Object.assign(new Error(`仅支持 ACP v1，收到 protocolVersion=${params.protocolVersion}`), { code: -32602 });
        }
        self.clientCapabilities = params.clientCapabilities ?? {};
        return {
          protocolVersion: 1,
          agentCapabilities: {
            promptCapabilities: { embeddedContext: true },
            sessionCapabilities: { close: {} },
          },
          agentInfo: { name: "t3-deepseek", title: "T3 DeepSeek", version: VERSION },
          authMethods: [],
        };
      },

      async "session/new"(params) {
        const session = self.createSession(params.cwd || process.cwd());
        self.log("session/new", session.id, session.cwd);
        return { sessionId: session.id, configOptions: [self.modelConfigOption(session)] };
      },

      async "session/set_config_option"(params) {
        const session = self.sessions.get(params.sessionId);
        if (!session) throw Object.assign(new Error("未知会话"), { code: -32602 });
        if (params.configId === "model") {
          if (!self.config.models.some((model) => model.id === params.value)) {
            throw Object.assign(new Error(`未知模型：${params.value}`), { code: -32602 });
          }
          session.model = params.value;
        }
        return { configOptions: [self.modelConfigOption(session)] };
      },

      async "session/close"(params) {
        const session = self.sessions.get(params.sessionId);
        if (session) {
          session.abort?.abort();
          self.sessions.delete(params.sessionId);
        }
        return {};
      },

      async "session/prompt"(params) {
        const session = self.sessions.get(params.sessionId);
        if (!session) throw Object.assign(new Error("未知会话"), { code: -32602 });
        if (session.busy) {
          throw Object.assign(new Error("会话正在处理上一个请求"), { code: -32603 });
        }
        return self.runTurn(session, params.prompt);
      },
    };
  }

  // ---------- 会话 ----------
  createSession(cwd) {
    const session = {
      id: `tds_${++this.sessionSeq}_${Date.now().toString(36)}`,
      cwd,
      model: this.config.defaultModel,
      history: [],
      perm: {}, // 工具名 -> true/false（权限记忆）
      busy: false,
      abort: null,
    };
    this.sessions.set(session.id, session);
    return session;
  }

  modelConfigOption(session) {
    return {
      id: "model",
      name: "模型",
      description: "DeepSeek 官方 API 模型",
      category: "model",
      type: "select",
      currentValue: session.model,
      options: this.config.models.map((model) => ({
        value: model.id,
        name: model.name || model.id,
        ...(model.description ? { description: model.description } : {}),
      })),
    };
  }

  // ---------- 提示词构造 ----------
  async buildUserMessage(session, promptBlocks, signal) {
    const parts = [`<env>\ncwd: ${session.cwd}\nos: ${process.platform} ${process.arch}\n</env>`];
    for (const block of promptBlocks) {
      if (block.type === "text") {
        if (block.text) parts.push(block.text);
      } else if (block.type === "resource") {
        const text = block.resource?.text;
        const uri = block.resource?.uri;
        if (typeof text === "string" && text) {
          parts.push(uri ? `<resource uri="${uri}">\n${text}\n</resource>` : text);
        }
      } else if (block.type === "resource_link") {
        const filePath = resourceUriToPath(block.uri);
        if (!filePath) {
          parts.push(`[上下文资源无法定位：${block.uri}]`);
          continue;
        }
        try {
          const result = await this.callClient(
            "fs/read_text_file",
            { sessionId: session.id, path: filePath, line: 1, limit: READ_LIMIT_LINES },
            { signal },
          );
          parts.push(`<file path="${filePath}">\n${result.content}\n</file>`);
        } catch (error) {
          if (isAborted(error)) throw error;
          parts.push(`[读取上下文文件失败 ${filePath}: ${error.message}]`);
        }
      }
    }
    return parts.join("\n\n");
  }

  // ---------- 上下文管理 ----------
  roughChars(messages) {
    return messages.reduce((sum, m) => sum + (typeof m.content === "string" ? m.content.length : 80), 0);
  }
  trimHistory(session) {
    while (session.history.length > 2 && this.roughChars(session.history) > MAX_CONTEXT_CHARS) {
      session.history.splice(1, 1); // 保留 system 与最新消息
    }
  }

  // ---------- 权限 ----------
  async requestPermission(session, toolCallUpdate) {
    const options = [
      { optionId: "allow_once", name: "仅此一次允许", kind: "allow_once" },
      { optionId: "allow_always", name: "总是允许", kind: "allow_always" },
      { optionId: "reject_once", name: "仅此一次拒绝", kind: "reject_once" },
      { optionId: "reject_always", name: "总是拒绝", kind: "reject_always" },
    ];
    const response = await this.callClient(
      "session/request_permission",
      { sessionId: session.id, toolCall: toolCallUpdate, options },
      { signal: session.abort },
    );
    if (response.outcome === "cancelled") throw new AbortedError();
    return response.optionId ?? "reject_once";
  }

  // ---------- 工具执行 ----------
  async executeToolCall(session, call) {
    const { id: toolCallId, function: fn } = call;
    const name = fn.name;
    let args = {};
    try {
      args = fn.arguments ? JSON.parse(fn.arguments) : {};
    } catch {
      args = { _raw: fn.arguments };
    }
    const meta = TOOL_META[name] ?? { kind: "other", title: () => name };
    const kind = meta.kind;
    const title = meta.title(args);
    const update = { toolCallId, kind, title, rawInput: args };
    this.sendUpdate(session.id, { sessionUpdate: "tool_call", status: "pending", ...update });

    // 危险工具走权限审批；读取永不审批（与 T3 的"读取不等待批准"一致）
    if ((name === "bash" || name === "write_file") && session.perm[name] === undefined) {
      try {
        const outcome = await this.requestPermission(session, { ...update, status: "pending" });
        session.perm[name] =
          outcome === "allow_always" ? true : outcome === "reject_always" ? false : session.perm[name];
        if (outcome.startsWith("reject")) {
          const message = "操作被用户拒绝。";
          this.sendUpdate(session.id, {
            sessionUpdate: "tool_call_update",
            toolCallId,
            status: "failed",
            content: [{ type: "content", content: { type: "text", text: message } }],
          });
          return message;
        }
      } catch (error) {
        if (isAborted(error)) throw error;
        const message = `权限请求失败：${error.message}`;
        this.sendUpdate(session.id, {
          sessionUpdate: "tool_call_update",
          toolCallId,
          status: "failed",
          content: [{ type: "content", content: { type: "text", text: message } }],
        });
        return message;
      }
    } else if (session.perm[name] === false) {
      const message = "该操作此前被设为总是拒绝。";
      this.sendUpdate(session.id, {
        sessionUpdate: "tool_call_update",
        toolCallId,
        status: "failed",
        content: [{ type: "content", content: { type: "text", text: message } }],
      });
      return message;
    }

    this.sendUpdate(session.id, { sessionUpdate: "tool_call_update", toolCallId, status: "in_progress" });
    try {
      const { text, content } = await this.execTool(session, name, args);
      this.sendUpdate(session.id, {
        sessionUpdate: "tool_call_update",
        toolCallId,
        status: "completed",
        ...(content
          ? { content }
          : { content: [{ type: "content", content: { type: "text", text } }] }),
        rawOutput: text,
      });
      return text;
    } catch (error) {
      if (isAborted(error)) throw error;
      const message = `工具执行失败：${error.message}`;
      this.sendUpdate(session.id, {
        sessionUpdate: "tool_call_update",
        toolCallId,
        status: "failed",
        content: [{ type: "content", content: { type: "text", text: message } }],
      });
      return message;
    }
  }

  async execTool(session, name, args) {
    const signal = session.abort;
    // 模型给出相对路径时，按会话 cwd 归一化为绝对路径（ACP 要求绝对路径）
    const resolvePath = (path) =>
      typeof path === "string" && path.trim()
        ? isAbsolute(path)
          ? path
          : join(session.cwd, path)
        : path;
    if (name === "read_file") {
      const result = await this.callClient(
        "fs/read_text_file",
        {
          sessionId: session.id,
          path: resolvePath(args.path),
          ...(args.line ? { line: args.line } : {}),
          ...(args.limit ? { limit: args.limit } : { limit: READ_LIMIT_LINES }),
        },
        { signal },
      );
      const text = truncate(result.content ?? "", MAX_TOOL_OUTPUT_CHARS);
      return { text };
    }
    if (name === "write_file") {
      const targetPath = resolvePath(args.path);
      let oldText = null;
      try {
        const before = await this.callClient(
          "fs/read_text_file",
          { sessionId: session.id, path: targetPath, line: 1, limit: READ_LIMIT_LINES },
          { signal },
        );
        oldText = before.content ?? null;
      } catch {
        // 新文件或读不到，按新建处理
      }
      await this.callClient(
        "fs/write_text_file",
        { sessionId: session.id, path: targetPath, content: args.content },
        { signal },
      );
      const content = [
        {
          type: "diff",
          path: targetPath,
          ...(oldText === null ? {} : { oldText }),
          newText: args.content,
        },
      ];
      return { text: `已写入 ${targetPath}（${args.content.length} 字符）`, content };
    }
    if (name === "bash") {
      const script = String(args.command ?? "");
      const isWindows = process.platform === "win32";
      // Windows 的 cmd /c 只执行第一个换行前的命令，多行脚本写入临时 .cmd 执行
      const tempScript = isWindows && script.includes("\n")
        ? join(
            tmpdir(),
            `t3ds-cmd-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}.cmd`,
          )
        : null;
      if (tempScript) {
        writeFileSync(tempScript, `@echo off\r\n${script.replace(/\r?\n/g, "\r\n")}\r\n`, "utf8");
      }
      const command = isWindows ? "cmd.exe" : "sh";
      const commandArgs = isWindows
        ? tempScript
          ? ["/d", "/c", "call", `"${tempScript}"`]
          : ["/d", "/c", script]
        : ["-c", script];
      const created = await this.callClient(
        "terminal/create",
        {
          sessionId: session.id,
          command,
          args: commandArgs,
          ...(args.cwd ? { cwd: args.cwd } : {}),
          outputByteLimit: MAX_BASH_OUTPUT_BYTES,
        },
        { signal },
      );
      const terminalId = created.terminalId;
      try {
        const exited = await this.callClient("terminal/wait_for_exit", { sessionId: session.id, terminalId }, { signal });
        let output = "";
        let truncated = false;
        try {
          const read = await this.callClient("terminal/output", { sessionId: session.id, terminalId }, { signal });
          output = read.output ?? "";
          truncated = read.truncated === true;
        } catch {
          // 有些客户端在 wait_for_exit 后输出读不到，忽略
        }
        const exitCode = exited.exitCode ?? null;
        if (exitCode !== 0) {
          throw new Error(`命令执行失败（exit ${exitCode}）\n${truncate(output, 8000)}`);
        }
        const text = truncated
          ? `${output}\n[输出被截断]`
          : output || "[无输出]";
        return { text: truncate(text, MAX_TOOL_OUTPUT_CHARS) };
      } finally {
        if (tempScript) {
          try {
            rmSync(tempScript, { force: true });
          } catch {
            // 清理失败不影响
          }
        }
        try {
          await this.callClient("terminal/release", { sessionId: session.id, terminalId });
        } catch {
          // release 失败不阻塞
        }
      }
    }
    return { text: `未知工具：${name}` };
  }

  // ---------- 主循环 ----------
  /**
   * 未配置 API Key 时，通过 ACP elicitation 表单向用户弹出输入框。
   * 用户提交后保存到本机配置文件。返回 false 表示未拿到 Key（本轮结束）。
   */
  async ensureApiKey(session) {
    const supportsForm =
      this.clientCapabilities?.elicitation?.form !== undefined &&
      this.clientCapabilities?.elicitation?.form !== null;
    const messageId = `asm_key_${Date.now().toString(36)}`;
    if (!supportsForm) {
      this.sendUpdate(session.id, {
        sessionUpdate: "agent_message_chunk",
        messageId,
        content: {
          type: "text",
          text: "\n\n⚠️ 尚未配置 DeepSeek API Key，且当前客户端不支持表单输入。\n请在终端运行：`powershell -NoProfile -ExecutionPolicy Bypass -File install.ps1 -ApiKey \"sk-xxx\"` 后重试。",
        },
      });
      return false;
    }
    this.sendUpdate(session.id, {
      sessionUpdate: "agent_message_chunk",
      messageId,
      content: { type: "text", text: "连接 DeepSeek 官方 API 需要 API Key，请在弹出的表单中填写：" },
    });
    let key = "";
    try {
      const response = await this.callClient("elicitation/create", {
        mode: "form",
        sessionId: session.id,
        message: "连接 DeepSeek 官方 API 需要 API Key",
        requestedSchema: {
          type: "object",
          properties: {
            apiKey: {
              type: "string",
              title: "DeepSeek API Key",
              description:
                "从 https://platform.deepseek.com/api_keys 获取。Key 只保存在本机 ~/.t3-deepseek/config.json，不会上传。",
            },
          },
          required: ["apiKey"],
        },
      });
      if (response?.action === "accept" && typeof response.content?.apiKey === "string") {
        key = response.content.apiKey.trim();
      }
    } catch (error) {
      this.log("elicitation 失败：", error.message ?? error);
    }
    if (!key) {
      this.sendUpdate(session.id, {
        sessionUpdate: "agent_message_chunk",
        messageId,
        content: {
          type: "text",
          text: "\n\n未提供 Key。你可以：\n1. 再次发送消息重新弹出表单；\n2. 或运行安装脚本：`powershell -NoProfile -ExecutionPolicy Bypass -File install.ps1`。",
        },
      });
      return false;
    }
    this.config.apiKey = key;
    const saved = persistApiKey(this.config.path, key);
    this.log("已获取 API Key" + (saved ? "（已保存到配置文件）" : "（保存失败，仅本次会话有效）"));
    this.sendUpdate(session.id, {
      sessionUpdate: "agent_message_chunk",
      messageId,
      content: { type: "text", text: "✅ 已保存 DeepSeek API Key，开始工作…" },
    });
    return true;
  }

  async runTurn(session, promptBlocks) {
    session.busy = true;
    const abort = new AbortController();
    session.abort = abort;
    try {
      // 未配置 Key 时先弹表单（mock 模式跳过）
      if (!this.config.apiKey && !this.config.mock) {
        const ensured = await this.ensureApiKey(session);
        if (!ensured) return { stopReason: "end_turn" };
      }
      const client = createDeepSeekClient(this.config);
      const userMessage = await this.buildUserMessage(session, promptBlocks, abort.signal);
      session.history.push({ role: "user", content: userMessage });
      this.trimHistory(session);

      const messages = [{ role: "system", content: SYSTEM_PROMPT }, ...session.history];
      let stopReason = "end_turn";
      let lastUsage = null;

      for (let step = 0; step < MAX_STEPS; step++) {
        if (abort.signal.aborted) throw new AbortedError();
        const stamp = `${Date.now().toString(36)}_${step}`;
        const messageId = `asm_${stamp}`;
        const thoughtId = `tht_${stamp}`;
        const events = [];
        let text = "";

        try {
          for await (const event of client.stream({ model: session.model, messages, signal: abort.signal })) {
            if (abort.signal.aborted) throw new AbortedError();
            events.push(event);
            if (event.type === "reasoning") {
              this.sendUpdate(session.id, {
                sessionUpdate: "agent_thought_chunk",
                messageId: thoughtId,
                content: { type: "text", text: event.text },
              });
            } else if (event.type === "content") {
              text += event.text;
              this.sendUpdate(session.id, {
                sessionUpdate: "agent_message_chunk",
                messageId,
                content: { type: "text", text: event.text },
              });
            } else if (event.type === "finish" && event.usage) {
              lastUsage = event.usage;
            }
          }
        } catch (error) {
          if (isAborted(error)) throw error;
          // API 层错误：作为一条失败消息展示给用户，结束本轮
          this.sendUpdate(session.id, {
            sessionUpdate: "agent_message_chunk",
            messageId,
            content: { type: "text", text: `\n\n⚠️ ${error.message}` },
          });
          return { stopReason: "end_turn" };
        }

        const calls = mergeToolCalls(events);
        const finish = events.findLast((event) => event.type === "finish");
        const finishReason = finish?.finishReason ?? null;

        const assistantMessage = { role: "assistant", content: text || null };
        if (calls.length > 0 && calls.every((call) => call.name)) {
          assistantMessage.tool_calls = calls.map((call) => ({
            id: call.id,
            type: "function",
            function: { name: call.name, arguments: call.args },
          }));
          session.history.push(assistantMessage);
          for (const toolCall of assistantMessage.tool_calls) {
            if (abort.signal.aborted) throw new AbortedError();
            const output = await this.executeToolCall(session, toolCall);
            session.history.push({ role: "tool", tool_call_id: toolCall.id, content: output });
            this.trimHistory(session);
          }
          messages.length = 1;
          messages.push(...session.history);
          continue;
        }

        session.history.push(assistantMessage);
        if (finishReason === "length") stopReason = "max_tokens";
        else if (finishReason === "content_filter") stopReason = "refusal";
        break;
      }

      this.sendUpdate(session.id, {
        sessionUpdate: "usage_update",
        used: lastUsage?.total_tokens ?? Math.round(this.roughChars(session.history) / 3.5),
        size: CONTEXT_WINDOW_TOKENS,
      });
      return { stopReason };
    } catch (error) {
      if (isAborted(error) || abort.signal.aborted) {
        this.log("turn cancelled", session.id);
        return { stopReason: "cancelled" };
      }
      throw error;
    } finally {
      session.busy = false;
      session.abort = null;
    }
  }
}

// ---------- 工具辅助 ----------
const TOOL_META = {
  read_file: { kind: "read", title: (a) => `读取文件 ${shortPath(a.path || "")}` },
  write_file: { kind: "edit", title: (a) => `写入文件 ${shortPath(a.path || "")}` },
  bash: { kind: "execute", title: (a) => String(a.command || "bash").slice(0, 120) },
};

/** 把用户通过表单提交的 Key 保存到配置文件（合并已有内容，无 BOM）。 */
function persistApiKey(configPath, key) {
  try {
    const dir = dirname(configPath);
    if (dir && !existsSync(dir)) mkdirSync(dir, { recursive: true });
    let raw = {};
    try {
      raw = JSON.parse(readFileSync(configPath, "utf8").replace(/^\uFEFF/, ""));
    } catch {
      // 文件不存在或损坏，按新建处理
    }
    raw.apiKey = key;
    if (!raw.version) raw.version = 1;
    writeFileSync(configPath, JSON.stringify(raw, null, 2) + "\n", "utf8");
    return true;
  } catch {
    return false;
  }
}

function shortPath(path) {
  const parts = String(path).split(/[\\/]/);
  return parts.length > 2 ? `…/${parts.slice(-2).join("/")}` : path;
}
function truncate(text, max) {
  const value = String(text);
  return value.length > max ? `${value.slice(0, max)}\n…(输出过长已截断 ${value.length - max} 字符)` : value;
}
function resourceUriToPath(uri) {
  try {
    const url = new URL(uri);
    if (url.protocol === "file:") {
      let p = decodeURIComponent(url.pathname);
      if (process.platform === "win32" && /^\/[A-Za-z]:/.test(p)) p = p.slice(1);
      return p;
    }
  } catch {
    // fallthrough
  }
  return isAbsolute(uri) ? uri : null;
}
function mergeToolCalls(events) {
  const map = new Map();
  for (const event of events) {
    if (event.type !== "tool_call") continue;
    const existing = map.get(event.index) ?? { id: null, name: null, args: "" };
    if (event.id) existing.id = event.id;
    if (event.name) existing.name = event.name;
    if (event.args) existing.args += event.args;
    map.set(event.index, existing);
  }
  return [...map.entries()].map(([index, call]) => ({
    id: call.id || `call_${Date.now().toString(36)}_${index}`,
    name: call.name || "",
    args: call.args || "{}",
  }));
}

// ---------- stdio 入口（作为子进程运行时） ----------
function isMain() {
  return process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
}
if (isMain()) {
  const agent = new T3DeepSeekAgent();
  agent.log(`t3-deepseek v${VERSION} started (config: ${agent.config.path})`);
  if (!agent.config.apiKey && !agent.config.mock) {
    agent.log("警告：未检测到 API Key。请运行 install.ps1 完成配置。");
  }
  let stdinBuffer = "";
  process.stdin.setEncoding("utf8");
  process.stdin.resume();
  process.stdin.on("data", (chunk) => {
    stdinBuffer += chunk;
    let newline;
    while ((newline = stdinBuffer.indexOf("\n")) >= 0) {
      const line = stdinBuffer.slice(0, newline).trim();
      stdinBuffer = stdinBuffer.slice(newline + 1);
      if (!line) continue;
      agent.feedLine(line);
    }
  });
  process.stdin.on("end", () => {
    agent.log("stdin closed, exiting");
    process.exit(0);
  });
}
