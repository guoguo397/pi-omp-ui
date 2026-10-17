import { FooterComponent } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, truncateToWidth } from "@earendil-works/pi-tui";
import { readSettings, updateSettings } from "./settings.js";

/**
 * Claude Code 风格状态栏。沿用旧模块名和配置键，兼容已保存的开关。
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

/** 纯渲染函数：按列宽裁剪四行，主题颜色在每次 render 时重新计算。 */
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
	const resources = fg("dim", files) + separator + fg("dim", `${view.mcpCount ?? 0} MCPs`);

	const state = view.compacting ? "compacting" : view.busy ? "working" : "ready";
	const status = [fg(view.busy || view.compacting ? "warning" : "success", `▶ ${state}`)];
	if (view.thinkingLevel) status.push(fg("muted", `thinking ${singleLine(view.thinkingLevel)}`));
	if (view.usage) {
		const usage = view.usage;
		status.push(fg("dim", `↑${tokens(usage.input + usage.cacheRead + usage.cacheWrite)} ↓${tokens(usage.output)}`));
		if (usage.cost > 0) status.push(fg("dim", `$${usage.cost.toFixed(4)}`));
	}
	// 不猜测子代理数或权限模式，原样保留其他扩展通过 setStatus 提供的内容。
	for (const [, value] of [...(view.statuses ?? [])].sort(([a], [b]) => a.localeCompare(b))) {
		// 插件状态允许保留颜色，但不允许换行。
		status.push(String(value).replace(/[\r\n\t]/g, " "));
	}
	return [header, context, resources, status.join(fg("dim", " · "))]
		.map((line) => columns === 0 ? "" : truncateToWidth(line, columns, "…"));
}

function installFooterPatch(getView, getTheme) {
	globalThis[PATCH_KEY]?.dispose();
	const prototype = FooterComponent.prototype;
	const originalRender = prototype.render;
	const state = { active: true };
	const render = function (width) {
		// 内部接口变化时安全回退，避免状态栏阻断整个 TUI 渲染。
		if (!state.active || !this.session || !this.footerData || typeof this.getSessionStats !== "function") {
			return originalRender.call(this, width);
		}
		const session = this.session;
		const { contextUsage, usageTotals } = this.getSessionStats();
		const model = session.routedModel?.model ?? session.state.model;
		return renderClaudeFooter({
			...getView(),
			modelName: model?.name || model?.id,
			cwd: session.sessionManager.getCwd(),
			branch: this.footerData.getGitBranch(),
			percent: contextUsage?.percent,
			contextFiles: session.resourceLoader?.getAgentsFiles().agentsFiles ?? [],
			mcpCount: countMcpServers(session.getAllTools?.()),
			thinkingLevel: session.routedModel?.thinkingLevel ?? session.state.thinkingLevel,
			compacting: session.isCompacting,
			usage: usageTotals,
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

export function registerFooterIcon(pi) {
	let enabled = readSettings().footerIconEnabled !== false;
	let patch;
	let startedAt = Date.now();
	let busy = false;
	let activeContext;

	const stop = () => {
		patch?.dispose();
		patch = undefined;
		activeContext = undefined;
	};
	const start = (ctx) => {
		if (ctx.mode !== "tui" || !enabled || patch) return;
		activeContext = ctx;
		patch = installFooterPatch(
			() => ({ elapsedMs: Date.now() - startedAt, busy }),
			() => activeContext.ui.theme,
		);
	};

	pi.on("session_start", (_event, ctx) => {
		stop();
		startedAt = Date.now();
		busy = false;
		start(ctx);
	});
	pi.on("before_agent_start", (_event, ctx) => {
		if (ctx.mode === "tui") busy = true;
	});
	// 等到重试、压缩和后续排队任务全部结束，不在中间 agent_end 显示 ready。
	pi.on("agent_settled", (_event, ctx) => {
		if (ctx.mode === "tui") busy = false;
	});
	pi.on("session_shutdown", () => { stop(); });

	pi.registerCommand("omp-footer", {
		description: "Toggle the Claude Code-style status bar (on|off|status)",
		handler: async (args, ctx) => {
			if (ctx.mode !== "tui") return;
			const action = args.trim().toLowerCase() || "status";
			if (action === "on" || action === "off") {
				enabled = action === "on";
				updateSettings({ footerIconEnabled: enabled });
				if (enabled) start(ctx);
				else stop();
				ctx.ui.notify(`omp-footer ${enabled ? "enabled" : "disabled"} (saved)`, "info");
				return;
			}
			if (action !== "status") {
				ctx.ui.notify("Usage: /omp-footer on|off|status", "warning");
				return;
			}
			ctx.ui.notify(`omp-footer is ${enabled ? "enabled" : "disabled"} (saved)`, "info");
		},
	});
}
