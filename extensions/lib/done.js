import { readSettings, updateSettings } from "./settings.js";

/** 优先将完成统计交给输入框；未接管输入框时才回退到独立通知。 */
export function registerDone(pi, { onUpdate = () => false } = {}) {
	let enabled = readSettings().doneEnabled !== false;
	let sessionStartedAt = Date.now();
	let runStartedAt;
	let message = "";
	const refresh = (ctx, notify = false) => {
		if (ctx.mode !== "tui") return;
		const text = enabled ? message : "";
		const embedded = onUpdate(text, ctx);
		if (notify && text && !embedded) ctx.ui.notify(ctx.ui.theme.fg("success", text), "info");
	};

	pi.on("session_start", (_event, ctx) => {
		sessionStartedAt = Date.now();
		runStartedAt = undefined;
		message = "";
		refresh(ctx);
	});

	pi.on("before_agent_start", (_event, ctx) => {
		runStartedAt = Date.now();
		// 新一轮开始时恢复原生运行指示，避免上轮统计盖住进度。
		message = "";
		refresh(ctx);
	});

	// agent_end 之后仍可能重试、压缩或继续执行；仅在最终 settled 时通知。
	pi.on("agent_settled", (_event, ctx) => {
		const startedAt = runStartedAt;
		runStartedAt = undefined;
		if (!enabled || ctx.mode !== "tui") return;

		const now = Date.now();
		const runTime = startedAt == null ? "" : `本次 ${formatDuration(now - startedAt)} · `;
		const usage = collectUsage(ctx.sessionManager.getEntries());
		const input = usage.input + usage.cacheRead + usage.cacheWrite;
		const total = input + usage.output;
		const cost = usage.cost > 0 ? ` · $${usage.cost.toFixed(4)}` : "";
		message =
			`${runTime}会话累计 ${formatDuration(now - sessionStartedAt)} · ` +
			`tokens ${formatTokens(total)}（输入 ${formatTokens(input)} / 输出 ${formatTokens(usage.output)}）${cost}`;

		refresh(ctx, true);
	});

	pi.on("session_shutdown", (_event, ctx) => {
		runStartedAt = undefined;
		message = "";
		refresh(ctx);
	});

	pi.registerCommand("omp-done", {
		description: "Toggle completion timing and cumulative token display (on|off|status)",
		handler: async (args, ctx) => {
			if (ctx.mode !== "tui") return;
			const action = args.trim().toLowerCase() || "status";
			if (action === "on" || action === "off") {
				enabled = action === "on";
				updateSettings({ doneEnabled: enabled });
				refresh(ctx);
			} else if (action !== "status") {
				ctx.ui.notify("Usage: /omp-done on|off|status", "warning");
				return;
			}
			ctx.ui.notify(`omp-done is ${enabled ? "enabled" : "disabled"} (saved)`, "info");
		},
	});
}

/** 与 Pi 内置会话统计一致，包含所有分支、压缩、摘要及工具报告的嵌套用量。 */
export function collectUsage(entries) {
	const total = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
	const add = (usage) => {
		if (!usage) return;
		total.input += usage.input ?? 0;
		total.output += usage.output ?? 0;
		total.cacheRead += usage.cacheRead ?? 0;
		total.cacheWrite += usage.cacheWrite ?? 0;
		total.cost += usage.cost?.total ?? 0;
	};

	for (const entry of entries) {
		if (entry.type === "usage") add(entry.usage);
		else if (entry.type === "branch_summary" || entry.type === "compaction") add(entry.usage);
		else if (entry.type === "message") {
			const { message } = entry;
			if (message.role === "assistant" || message.role === "toolResult") add(message.usage);
		}
	}
	return total;
}

export function formatDuration(ms) {
	const seconds = Math.max(0, Math.round(ms / 1000));
	const h = Math.floor(seconds / 3600);
	const m = Math.floor((seconds % 3600) / 60);
	const s = seconds % 60;
	if (h) return `${h}h ${m}m ${s}s`;
	if (m) return `${m}m ${s}s`;
	return `${s}s`;
}

export function formatTokens(count) {
	if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
	if (count >= 1_000) return `${(count / 1_000).toFixed(1)}k`;
	return String(count);
}
