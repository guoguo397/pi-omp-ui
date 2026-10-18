import { randomUUID } from "node:crypto";
import { lstatSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, resolve } from "node:path";
import { Agent } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";

export const FLASH_MODEL = "deepseek/deepseek-flash";
export const FLASH_THINKING = "low";
const TOOLS = new Set(["read", "grep", "find", "ls", "edit", "write"]);
const WRITES = new Set(["edit", "write"]);
const GUIDANCE = `For a clear, low-risk task that requires changing exactly ONE known file, delegate the complete task to flash.
Pass the target path and a self-contained task with relevant context and acceptance criteria. Read multiple files if needed to establish scope first.
Do not delegate ambiguous, risky or multi-file tasks (including required test/documentation changes), or split a multi-file task into single-file delegations.
If unsure, handle it yourself. Do not modify files alongside the delegation. Review the result and run necessary validation yourself.`;
const WORKER_GUIDANCE = `You are flash, a lightweight single-file worker, not the main agent.
Follow the inherited project and safety instructions. Only the designated file may be edited or created; other files may be read.
Do not delegate, use shells/MCP/codemode, expand the task, or claim tests ran. The parent agent handles validation and the final user reply.
If another file, a risky operation or clarification is needed, stop and explain what the parent must handle, including any changes already made.
Read before editing, prefer targeted edit over rewriting existing files, and return a concise factual summary with any remaining work.`;

/** 固定真实路径，避免相对路径、目录链接或文件链接绕过单文件限制；允许新建文件。 */
function filePath(value, cwd) {
	if (typeof value !== "string" || !value.trim()) throw new Error("flash 需要明确的目标文件路径");
	let path = value.startsWith("~/") || value.startsWith("~\\") ? resolve(homedir(), value.slice(2)) : resolve(cwd, value);
	try { path = realpathSync(path); }
	catch (error) {
		if (error.code !== "ENOENT") throw error;
		if (lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink()) throw new Error("flash 不支持目标路径中的悬空链接");
		path = resolve(filePath(dirname(path), cwd), basename(path));
	}
	// Pi 文件工具会规范化这些空格；拒绝歧义，避免校验与实际写入指向不同文件。
	if (/[\u00a0\u2000-\u200a\u202f\u205f\u3000]/.test(path)) throw new Error("flash 不支持含特殊空格的目标路径，请由主 agent 处理");
	return path;
}

export function registerFlash(pi, { getMode }) {
	let active;
	let registered = false;
	const cancel = () => active?.abort(new Error("flash 因会话切换或重载而取消"));
	pi.on("session_shutdown", cancel);
	pi.on("session_tree", cancel);
	pi.on("before_agent_start", (event, ctx) => {
		if (ctx.mode !== "tui") return;
		event.systemPromptOptions.sections.omp_flash = getMode() === "execute" && pi.getActiveTools().includes("flash") ? GUIDANCE : "";
	});
	pi.on("session_start", (_event, ctx) => {
		cancel();
		if (ctx.mode !== "tui" || registered) return;
		registered = true;
		pi.registerTool({
			name: "flash", label: "flash",
			description: "Delegate a clear, low-risk task requiring changes to exactly one known file to deepseek/deepseek-flash (low thinking). Never use for multi-file tasks. Parent reviews and runs tests.",
			exposure: "model-only", executionMode: "sequential",
			reachesTools: () => [...TOOLS],
			parameters: Type.Object({
				path: Type.String({ minLength: 1, description: "The only file allowed to change (relative to cwd or absolute)" }),
				task: Type.String({ minLength: 1, description: "Self-contained lightweight task, relevant context and acceptance criteria" }),
			}),
			async execute(_id, { path, task }, parentSignal, onUpdate, ctx) {
				if (ctx.mode !== "tui" || getMode() !== "execute") throw new Error("flash 仅在交互式执行模式可用");
				if (active) throw new Error("flash 正在运行，请等待完成后再调度");
				const controller = new AbortController();
				active = controller;
				const signal = parentSignal ? AbortSignal.any([parentSignal, controller.signal]) : controller.signal;
				const timeout = setTimeout(() => controller.abort(new Error("flash 超时（120 秒）")), 120_000);
				timeout.unref?.();
				const details = { agent: "flash", started: false, path, writeAttempted: false };
				const usage = {
					input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
				};
				const pendingTools = new Set();
				let agent;
				let rounds = 0;
				let calls = 0;
				let failure;
				const cancelled = Promise.withResolvers();
				const abort = () => { agent?.abort(); cancelled.reject(signal.reason); };
				// 验证失败也可能早于 race，先安装拒绝处理，避免未处理的取消 Promise。
				void cancelled.promise.catch(() => { });
				const check = () => {
					signal.throwIfAborted();
					if (getMode() !== "execute") throw new Error("flash 执行模式已失效");
				};
				try {
					check();
					if (!task.trim()) throw new Error("flash 任务不能为空");
					details.path = filePath(path, ctx.cwd);
					const [provider, modelId] = FLASH_MODEL.split("/");
					const model = ctx.modelRegistry.find(provider, modelId);
					if (!model) throw new Error(`未找到模型 ${FLASH_MODEL}，请由主 agent 处理`);
					const tools = ctx.tools.filter((tool) => TOOLS.has(tool.name)).map((tool) => ({
						name: tool.name, label: tool.label, description: tool.description, parameters: tool.parameters,
						async execute(_callId, args) {
							check();
							if (failure) throw new Error(failure);
							if (++calls > 24) throw new Error("flash 超过 24 次工具调用，请交回主 agent");
							if (WRITES.has(tool.name)) {
								if (filePath(args.path, ctx.cwd) !== details.path) throw new Error(`flash 只能修改 ${details.path}`);
								args = { ...args, path: details.path };
								details.writeAttempted = true;
							}
							onUpdate?.({ content: [{ type: "text", text: `flash → ${tool.name}` }], details: { ...details } });
							const pending = ctx.executeTool(tool.name, args, { signal });
							pendingTools.add(pending);
							try { const result = await pending; check(); return result; }
							finally { pendingTools.delete(pending); }
						},
					}));
					agent = new Agent({
						initialState: {
							systemPrompt: `${ctx.getSystemPrompt()}\n\n${WORKER_GUIDANCE}\nDesignated writable file: ${JSON.stringify(details.path)}`,
							model, thinkingLevel: FLASH_THINKING, tools,
						},
						sessionId: `flash:${randomUUID()}`, toolExecution: "sequential",
						streamFn(selectedModel, context, options) {
							check();
							if (++rounds > 8) throw new Error("flash 超过 8 轮请求，请交回主 agent");
							details.started = true;
							return ctx.modelRegistry.streamSimple(selectedModel, context, { ...options, maxTokens: 4096 });
						},
						finishTurn({ toolResults }) {
							const failed = toolResults.find((result) => result.isError);
							if (!failed) return;
							failure = failed.content.filter((part) => part.type === "text").map((part) => part.text).join("\n").trim() || "flash 工具执行失败（未提供错误文本）";
							return { action: "end" };
						},
					});
					agent.subscribe((event) => {
						if (event.type !== "message_end" || event.message.role !== "assistant") return;
						const used = event.message.usage;
						for (const key of ["input", "output", "cacheRead", "cacheWrite", "totalTokens"]) usage[key] += used?.[key] ?? 0;
						for (const key of Object.keys(usage.cost)) usage.cost[key] += used?.cost?.[key] ?? 0;
					});
					signal.addEventListener("abort", abort, { once: true });
					await Promise.race([agent.prompt(task), cancelled.promise]);
					check();
					const message = agent.state.messages.findLast((item) => item.role === "assistant");
					if (failure || message?.stopReason !== "stop") throw new Error(failure || message?.errorMessage || agent.state.errorMessage || `flash 未完成：${message?.stopReason ?? "无结果"}`);
					const text = message.content.filter((part) => part.type === "text").map((part) => part.text).join("\n").trim();
					if (!text) throw new Error("flash 未返回有效结果");
					return { content: [{ type: "text", text: `${text.slice(0, 12_000)}\n\n目标文件：${details.path}。请主 agent 核对改动并运行必要验证。` }], details, usage };
				} catch (error) {
					return { isError: true, content: [{ type: "text", text: `flash 未完成：${error?.message ?? error}。${details.writeAttempted ? `已尝试写入 ${details.path}，请先核对现状；不会自动回滚或重跑。` : "请主 agent 接手。"}` }], details, usage };
				} finally {
					clearTimeout(timeout);
					signal.removeEventListener("abort", abort);
					agent?.abort();
					// 不等待可能忽略取消的供应商，但必须等已启动的文件操作结束才释放 worker。
					await Promise.allSettled([...pendingTools]);
					if (active === controller) active = undefined;
				}
			},
		});
	});
}
