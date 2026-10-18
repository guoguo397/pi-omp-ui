import { isKeyRelease, matchesKey } from "@earendil-works/pi-tui";

export const MODE_ENTRY = "omp-interaction-mode";
export const MODE_STATUS = "omp-interaction-mode";
export const PLAN_TOOLS = new Set(["read", "grep", "find", "ls"]);

const PLAN_GUIDANCE = `You are in PLAN MODE (read-only exploration).
Only read, grep, find and ls tool calls are permitted. Shell commands (including bash and powershell), edit, write, codemode, MCP and all other tools are blocked, including nested calls.
Analyze the request and inspect relevant files as needed. Ask clarifying questions when necessary, then present an actionable numbered plan with affected files, risks and validation steps.
Do not modify files, run commands, save a plan to disk, or attempt to bypass these restrictions. Remain in plan mode after answering. The user must explicitly switch to execution mode before implementation.`;
const EXECUTE_GUIDANCE = `You are in EXECUTION MODE (accept edits on).
Follow the user's current request using the normally available tools. Earlier plan-mode restrictions no longer apply to this run. This mode does not bypass Pi or other extensions' permissions and does not by itself authorize unrelated actions.`;

export function modeLabel(mode) {
	return mode === "plan" ? "⏸ plan mode" : "⏵⏵ accept edits on";
}

/** 两态工作流；不改变原有工具集，以调用拦截兜底，避免恢复工具集时覆盖其他扩展。 */
export function registerInteractionMode(pi) {
	let mode = "execute";
	let busy = false;
	let promptDepth = 0;
	let inPaste = false;
	let unsubscribe;

	const showStatus = (ctx) => ctx.ui.setStatus(MODE_STATUS, `${modeLabel(mode)} (shift+tab to cycle)`);
	const restore = (ctx) => {
		const entries = ctx.sessionManager.getBranch();
		const entry = entries.findLast((item) => item.type === "custom" && item.customType === MODE_ENTRY);
		mode = entry?.data?.mode === "plan" ? "plan" : "execute";
		showStatus(ctx);
	};
	const change = (next, ctx) => {
		if (ctx.mode !== "tui") return;
		if (next === mode) return;
		if (busy || !ctx.isIdle()) {
			ctx.ui.notify("请先等待本轮结束或按 Escape 中止，再切换执行 / 计划模式。", "warning");
			return;
		}
		// 先保存，失败时保持当前模式，不让界面状态与重载后的状态不一致。
		pi.appendEntry(MODE_ENTRY, { mode: next });
		mode = next;
		showStatus(ctx);
		ctx.ui.notify(next === "plan"
			? "计划模式：仅允许 read / grep / find / ls，只分析并输出方案。"
			: "执行模式：accept edits on，恢复原有工具调用行为。", "info");
	};

	pi.on("session_start", (_event, ctx) => {
		unsubscribe?.();
		unsubscribe = undefined;
		busy = false;
		promptDepth = 0;
		inPaste = false;
		if (ctx.mode !== "tui") return;
		restore(ctx);
		// Shift+Tab 是 Pi 保留的思考快捷键，registerShortcut 无法覆盖；使用公开输入监听 API。
		unsubscribe = ctx.ui.onTerminalInput((data) => {
			const pasted = inPaste || data.includes("\x1b[200~");
			if (data.includes("\x1b[200~")) inPaste = true;
			if (data.includes("\x1b[201~")) inPaste = false;
			if (pasted || promptDepth || isKeyRelease(data) || !matchesKey(data, "shift+tab")) return;
			change(mode === "plan" ? "execute" : "plan", ctx);
			return { consume: true };
		});
	});
	pi.on("session_tree", (_event, ctx) => {
		if (ctx.mode === "tui") restore(ctx);
	});
	pi.on("ui_prompt_start", () => { promptDepth++; });
	pi.on("ui_prompt_end", () => { promptDepth = Math.max(0, promptDepth - 1); });
	pi.on("before_agent_start", (event, ctx) => {
		if (ctx.mode !== "tui") return;
		busy = true;
		event.systemPromptOptions.sections.omp_interaction_mode = mode === "plan" ? PLAN_GUIDANCE : EXECUTE_GUIDANCE;
	});
	pi.on("agent_settled", () => { busy = false; });
	pi.on("tool_call", (event, ctx) => {
		if (ctx.mode !== "tui" || mode !== "plan" || PLAN_TOOLS.has(event.toolName)) return;
		return { block: true, reason: `Plan mode: ${event.toolName} is blocked. Only read, grep, find and ls are allowed. Ask the user to switch with Shift+Tab or /omp-mode execute before making changes.` };
	});
	pi.on("user_bash", (_event, ctx) => {
		if (ctx.mode !== "tui" || mode !== "plan") return;
		return { result: { output: "Plan mode: shell commands are blocked. Use /omp-mode execute first.", exitCode: 1, cancelled: false, truncated: false } };
	});
	pi.on("session_shutdown", (_event, ctx) => {
		unsubscribe?.();
		unsubscribe = undefined;
		busy = false;
		promptDepth = 0;
		inPaste = false;
		if (ctx.mode === "tui") ctx.ui.setStatus(MODE_STATUS, undefined);
	});
	pi.registerCommand("omp-mode", {
		description: "Switch execution / read-only plan mode (execute|plan|status)",
		handler: async (args, ctx) => {
			if (ctx.mode !== "tui") return;
			const action = args.trim().toLowerCase() || "status";
			if (action === "execute" || action === "plan") change(action, ctx);
			else if (action === "status") ctx.ui.notify(`${modeLabel(mode)} (${mode})`, "info");
			else ctx.ui.notify("Usage: /omp-mode execute|plan|status", "warning");
		},
	});
	return { getMode: () => mode };
}
