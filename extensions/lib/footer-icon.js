import { FooterComponent } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, truncateToWidth } from "@earendil-works/pi-tui";
import { COMPACT_TOOLS, title } from "../tool-ui/format.js";
import { MODE_STATUS, modeLabel } from "./interaction-mode.js";

/**
 * Claude Code 风格状态栏，随扩展自动启用。
 * 仅包装内置 footer，不调用 setFooter，因此不会覆盖其他扩展的自定义状态栏。
 * session / footerData / getSessionStats 是 Pi 1.3.0 内置组件的适配点。
 */
const PATCH_KEY = Symbol.for("pi.omp-editor.footer-icon-patch");

/** 外部名称不可把换行、ANSI 或控制字符带入状态栏。 */
function singleLine(value) {
	return stripTerminalSequences(String(value ?? ""))
		.replace(/[\x00-\x1f\x7f-\x9f]/g, " ")
		.replace(/ +/g, " ").trim();
}

function filename(path) {
	return singleLine(path).replace(/\\/g, "/").replace(/\/+$/, "").split("/").at(-1) || "/";
}

function elapsedLabel(ms = 0) {
	const minutes = Math.floor(Math.max(0, ms) / 60_000);
	if (minutes < 1) return "<1m";
	if (minutes < 60) return `${minutes}m`;
	return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function tokens(count = 0) {
	if (count < 1000) return String(count);
	if (count < 1_000_000) return `${(count / 1000).toFixed(1)}k`;
	return `${(count / 1_000_000).toFixed(1)}M`;
}

/** 只统计有可访问工具的 MCP 命名空间，不把配置数冒充已连接数。 */
export function countMcpServers(tools = []) {
	const servers = new Set();
	for (const tool of tools) {
		if (tool.exposure === "hidden") continue;
		const namespace = tool.namespace?.name;
		const match = /^mcp__(.+?)__/.exec(tool.name ?? "");
		if (namespace?.startsWith("mcp__")) servers.add(namespace.slice(5));
		else if (match) servers.add(match[1]);
	}
	return servers.size;
}

/** 从 SKILL.md 路径取技能名；独立 Markdown 技能无目录名，不误判。 */
function skillNameFromPath(path) {
	if (typeof path !== "string") return undefined;
	const normalized = path.replace(/\\/g, "/").replace(/\/+$/, "");
	return /\/([^/]+)\/SKILL\.md$/i.exec(normalized)?.[1];
}

const SUB_AGENT_TOOL = /sub_?agent/i;
const SKILL_COMMAND = /^\/skill:([a-z0-9][a-z0-9-]*)/i;

/**
 * 会话累计的子 agent 与技能调用：技能来自模型读取 SKILL.md 及 /skill: 命令，
 * 子 agent 来自名称匹配的子代理工具；进程内子 agent（如 titler）由 recordAgent 补充。
 */
export function collectSessionUsage(entries = []) {
	const skills = new Map();
	const agents = new Map();
	const add = (map, name) => {
		if (typeof name === "string" && name) map.set(name, (map.get(name) ?? 0) + 1);
	};
	for (const entry of entries) {
		if (entry.type !== "message") continue;
		const message = entry.message;
		if (message?.role === "assistant") {
			for (const part of message.content ?? []) {
				if (part?.type !== "toolCall") continue;
				const name = String(part.name ?? "");
				if (/^read$/i.test(name)) add(skills, skillNameFromPath(part.arguments?.path));
				else if (SUB_AGENT_TOOL.test(name)) add(agents, name);
			}
		} else if (message?.role === "user") {
			const content = message.content;
			const text = typeof content === "string" ? content : (content ?? [])
				.filter((part) => part?.type === "text").map((part) => part.text).join("\n");
			add(skills, SKILL_COMMAND.exec(text.trim())?.[1]);
		}
	}
	return { skills, agents };
}

/** 按已保存的工具结果累计调用，避免把 assistant 的请求和结果重复计算。 */
export function collectToolUsage(entries = []) {
	const counts = new Map();
	const outcomes = new Map();
	let total = 0;
	let incomplete = false;
	const add = (name, status = "ok") => {
		if (typeof name !== "string" || !name) return;
		counts.set(name, (counts.get(name) ?? 0) + 1);
		// 同名工具只要存在失败就不能显示绿色成功标记，未完成记录次之。
		if (status === "error" || !outcomes.has(name) || (status === "unfinished" && outcomes.get(name) !== "error")) {
			outcomes.set(name, status);
		}
		total++;
	};
	for (const entry of entries) {
		if (entry.type !== "message" || entry.message?.role !== "toolResult") continue;
		const message = entry.message;
		add(message.toolName, message.isError ? "error" : "ok");
		// 原生记录包含各层嵌套调用；不再叠加 details.calls，以免重复或混入模型调用。
		for (const call of message.nestedCalls?.calls ?? []) add(call.name, call.status);
		if (message.nestedCalls?.complete === false) incomplete = true;
	}
	return { total, counts, incomplete, outcomes };
}

/** 本轮成功响应的加权平均输出速率；使用 Pi 原生请求耗时，不混入工具或调用间等待。 */
export function collectOutputSpeed(entries = []) {
	let output = 0;
	let durationMs = 0;
	for (const entry of entries) {
		if (entry.type !== "message" || entry.message?.role !== "assistant") continue;
		const message = entry.message;
		// 失败、取消及尚未完成的响应不参与统计；工具内嵌模型用量也不混入。
		if (!["stop", "length", "toolUse"].includes(message.stopReason)) continue;
		const count = message.usage?.output;
		const duration = message.durationMs;
		// 任一成功调用缺少用量或计时，整轮隐藏，不能把部分调用冒充本轮平均值。
		if (!Number.isFinite(count) || count < 0 || !Number.isFinite(duration) || duration <= 0) return undefined;
		output += count;
		durationMs += duration;
	}
	const speed = output / (durationMs / 1000);
	return Number.isFinite(speed) && speed > 0 ? speed : undefined;
}

/** 纯渲染函数：主题颜色在每次 render 时重新计算，有调用记录时在状态行前插入工具汇总。 */
export function renderClaudeFooter(view, width, theme) {
	const columns = Math.max(0, Math.floor(width));
	const fg = (token, text) => theme.fg(token, text);
	const separator = fg("dim", " | ");
	const model = fg("accent", `[${singleLine(view.modelName) || "no-model"}]`);
	const project = fg("warning", filename(view.cwd));
	const git = view.branch ? ` ${fg("thinkingHigh", "git:(")}${fg("accent", singleLine(view.branch))}${fg("thinkingHigh", ")")}` : "";
	const header = model + separator + project + git + separator + fg("dim", `⏱ ${elapsedLabel(view.elapsedMs)}`);

	// 压缩后的未知用量不能误显示为 0%；进度条始终限制在 0–100%。
	const known = typeof view.percent === "number" && Number.isFinite(view.percent);
	const percent = known ? Math.max(0, Math.min(100, view.percent)) : 0;
	const color = percent > 90 ? "error" : percent > 70 ? "warning" : "success";
	const percentLabel = known ? `${Math.round(percent)}%` : "?%";
	const barWidth = Math.min(16, Math.max(0, columns - 9 - percentLabel.length));
	const filled = Math.round(barWidth * percent / 100);
	const bar = fg(color, "█".repeat(filled)) + fg("dim", "░".repeat(barWidth - filled));
	const context = fg("muted", "Context ") + (barWidth ? `${bar} ` : "") + fg(known ? color : "dim", percentLabel);

	const counts = new Map();
	for (const file of view.contextFiles ?? []) {
		const name = filename(file.path);
		counts.set(name, (counts.get(name) ?? 0) + 1);
	}
	const files = [...counts].map(([name, count]) => `${count} ${name}`).join(" · ") || "0 context files";
	const resources = [fg("dim", files), fg("dim", `${view.mcpCount ?? 0} MCPs`)];
	// 外部名称统一走单行清理，次数只在重复调用时标注。
	const nameList = (map) => [...(map ?? [])]
		.map(([name, count]) => count > 1 ? `${singleLine(name)} ×${count}` : singleLine(name))
		.filter(Boolean).join(" · ");
	const agents = nameList(view.agents);
	const skills = nameList(view.skills);
	if (agents) resources.push(fg("dim", `Agents ${agents}`));
	if (skills) resources.push(fg("dim", `Skills ${skills}`));

	// 运行进度由输入框显示，底部不再重复 working；空闲及压缩状态仍保留。
	const state = view.compacting ? "compacting" : view.busy ? "" : "ready";
	const hasMode = view.interactionMode === "execute" || view.interactionMode === "plan";
	const status = hasMode ? [
		fg(view.interactionMode === "plan" ? "warning" : "thinkingHigh", modeLabel(view.interactionMode)) + fg("dim", " (shift+tab to cycle)"),
	] : [];
	if (state && (!hasMode || view.compacting)) status.push(fg(view.compacting ? "warning" : "success", `▶ ${state}`));
	if (view.thinkingLevel) status.push(fg("muted", `thinking ${singleLine(view.thinkingLevel)}`));
	if (view.usage) {
		const usage = view.usage;
		status.push(fg("dim", `↑${tokens(usage.input + usage.cacheRead + usage.cacheWrite)} ↓${tokens(usage.output)}`));
		if (!view.busy && Number.isFinite(view.outputSpeed) && view.outputSpeed > 0) {
			status.push(fg("dim", `${view.outputSpeed.toFixed(1)} tok/s`));
		}
		if (usage.cost > 0) status.push(fg("dim", `$${usage.cost.toFixed(4)}`));
	}
	// 不猜测子代理数或权限模式，原样保留其他扩展通过 setStatus 提供的内容。
	for (const [key, value] of [...(view.statuses ?? [])].sort(([a], [b]) => a.localeCompare(b))) {
		if (hasMode && key === MODE_STATUS) continue;
		// 插件状态允许保留颜色，但不允许换行。
		status.push(String(value).replace(/[\r\n\t]/g, " "));
	}
	const lines = [header, context, resources.join(separator)];
	if (view.toolUsage?.total > 0) {
		const usage = view.toolUsage;
		const tools = [...usage.counts].sort(([a, x], [b, y]) => y - x || a.localeCompare(b))
			.map(([name, count]) => {
				const outcome = usage.outcomes?.get(name);
				const icon = outcome === "error" ? fg("error", "✗") : outcome === "unfinished" ? fg("warning", "!") : fg("success", "✓");
				return `${icon} ${fg("muted", COMPACT_TOOLS.has(name) ? title(name) : singleLine(name))} ${fg("dim", `×${count}`)}`;
			});
		lines.push((usage.incomplete ? fg("warning", "≥ ") : "") + tools.join(separator));
	}
	lines.push(status.join(fg("dim", " · ")));
	return lines.map((line) => columns === 0 ? "" : truncateToWidth(line, columns, "…"));
}

function installFooterPatch(getView, getTheme) {
	globalThis[PATCH_KEY]?.dispose();
	const prototype = FooterComponent.prototype;
	const originalRender = prototype.render;
	const state = { active: true };
	const toolUsageCache = new WeakMap();
	const sessionUsageCache = new WeakMap();
	const render = function (width) {
		// 内部接口变化时安全回退，避免状态栏阻断整个 TUI 渲染。
		if (!state.active || !this.session || !this.footerData || typeof this.getSessionStats !== "function") {
			return originalRender.call(this, width);
		}
		const session = this.session;
		const stats = this.getSessionStats();
		const { contextUsage, usageTotals } = stats;
		const view = getView();
		// 同时检查本轮起点：新一轮即使尚未新增条目，也不能沿用上一轮统计。
		if (!toolUsageCache.has(stats) || toolUsageCache.get(stats).start !== view.toolStart) {
			const entries = view.toolStart === undefined ? [] : (session.sessionManager.getEntries?.() ?? []).slice(view.toolStart);
			toolUsageCache.set(stats, { start: view.toolStart, usage: collectToolUsage(entries) });
		}
		const model = session.routedModel?.model ?? session.state.model;
		// 技能与子 agent 为会话累计值，与本轮工具统计共用 stats 失效时机。
		if (!sessionUsageCache.has(stats)) {
			sessionUsageCache.set(stats, collectSessionUsage(session.sessionManager.getEntries?.() ?? []));
		}
		return renderClaudeFooter({
			...view,
			modelName: model?.name || model?.id,
			cwd: session.sessionManager.getCwd(),
			branch: this.footerData.getGitBranch(),
			percent: contextUsage?.percent,
			contextFiles: session.resourceLoader?.getAgentsFiles().agentsFiles ?? [],
			mcpCount: countMcpServers(session.getAllTools?.()),
			thinkingLevel: session.routedModel?.thinkingLevel ?? session.state.thinkingLevel,
			compacting: session.isCompacting,
			usage: usageTotals,
			toolUsage: toolUsageCache.get(stats).usage,
			agents: view.mergeAgents?.(sessionUsageCache.get(stats).agents) ?? sessionUsageCache.get(stats).agents,
			skills: sessionUsageCache.get(stats).skills,
			statuses: this.footerData.getExtensionStatuses(),
		}, width, getTheme());
	};
	prototype.render = render;
	const patch = {
		dispose() {
			if (!state.active) return;
			state.active = false;
			if (prototype.render === render) prototype.render = originalRender;
			if (globalThis[PATCH_KEY] === patch) delete globalThis[PATCH_KEY];
		},
	};
	globalThis[PATCH_KEY] = patch;
	return patch;
}

export function registerFooterIcon(pi, { getMode = () => undefined } = {}) {
	let patch;
	let startedAt = Date.now();
	let busy = false;
	let toolStart;
	let outputSpeed;
	let activeContext;
	// 进程内子 agent 不产生会话条目，按会话 ID 记录，重载后仍随会话保留。
	const recordedAgents = new Map();

	const stop = () => {
		patch?.dispose();
		patch = undefined;
		activeContext = undefined;
	};
	const start = (ctx) => {
		if (ctx.mode !== "tui" || patch) return;
		activeContext = ctx;
		patch = installFooterPatch(
			() => ({
				elapsedMs: Date.now() - startedAt, busy, toolStart, outputSpeed,
				interactionMode: getMode(),
				mergeAgents: (scanned) => {
					const recorded = recordedAgents.get(ctx.sessionManager.getSessionId?.() ?? "");
					if (!recorded?.size) return scanned;
					const merged = new Map(scanned);
					for (const [name, count] of recorded) merged.set(name, (merged.get(name) ?? 0) + count);
					return merged;
				},
			}),
			() => activeContext.ui.theme,
		);
	};

	pi.on("session_start", (_event, ctx) => {
		stop();
		startedAt = Date.now();
		busy = false;
		toolStart = undefined;
		outputSpeed = undefined;
		start(ctx);
	});
	pi.on("before_agent_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		busy = true;
		outputSpeed = undefined;
		// 与顶边本轮耗时使用同一开始事件；只统计此后保存的工具结果及模型响应。
		toolStart = ctx.sessionManager.getEntryCount?.() ?? ctx.sessionManager.getEntries().length;
	});
	// 等到重试、压缩和后续排队任务全部结束，不在中间 agent_end 显示 ready。
	pi.on("agent_settled", (_event, ctx) => {
		if (ctx.mode !== "tui" || !busy) return;
		busy = false;
		const entries = ctx.sessionManager.getEntries?.();
		outputSpeed = toolStart === undefined || !entries ? undefined : collectOutputSpeed(entries.slice(toolStart));
	});
	pi.on("session_shutdown", () => {
		busy = false;
		toolStart = undefined;
		outputSpeed = undefined;
		stop();
	});

	return {
		/** 记录会话内不产生条目的子 agent 调用；会话数设上限，避免长进程累积。 */
		recordAgent(sessionId, name) {
			if (typeof name !== "string" || !name) return;
			const key = String(sessionId ?? "");
			if (!recordedAgents.has(key)) {
				if (recordedAgents.size >= 32) recordedAgents.delete(recordedAgents.keys().next().value);
				recordedAgents.set(key, new Map());
			}
			const counts = recordedAgents.get(key);
			counts.set(name, (counts.get(name) ?? 0) + 1);
		},
	};
}
