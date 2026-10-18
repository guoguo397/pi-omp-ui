import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { generateSessionTitle, TITLE_TIMEOUT_MS } from "./title-agent.js";

export const AUTO_TITLE_MAX = 40;

/** 只清理模型生成的标题；绝不拿用户输入作为命名失败的后备值。 */
export function normalizeSessionTitle(text) {
	const line = stripTerminalSequences(String(text ?? ""))
		.replace(/[\x00-\x09\x0b\x0c\x0e-\x1f\x7f-\x9f]/g, " ")
		.split(/\r\n|[\r\n]/).find((value) => value.trim()) ?? "";
	const title = line.trim().replace(/^#{1,6}\s*/, "").replace(/^(?:标题|title)\s*[:：]\s*/i, "")
		.replace(/^["'“‘`]+|["'”’`]+$/g, "").replace(/\s+/g, " ").trim();
	if (!title || title.startsWith("/")) return "";
	const chars = [...title];
	return chars.length > AUTO_TITLE_MAX ? `${chars.slice(0, AUTO_TITLE_MAX - 1).join("")}…` : title;
}

/** 仅取当前分支的用户与成功回复正文，排除工具、图片、推理及其他分支，限制额外请求的大小。 */
export function buildTitleContext(entries) {
	const lastAssistant = entries.findLast((entry) => entry.type === "message" && entry.message?.role === "assistant")?.message;
	if (!lastAssistant || !["stop", "length"].includes(lastAssistant.stopReason)) return "";
	const messages = [];
	for (const entry of entries) {
		if (entry.type !== "message") continue;
		const message = entry.message;
		if (message?.role !== "user" && message?.role !== "assistant") continue;
		if (message.role === "assistant" && !["stop", "length"].includes(message.stopReason)) continue;
		const text = (typeof message.content === "string" ? message.content : (message.content ?? [])
			.filter((part) => part.type === "text").map((part) => part.text).join("\n")).trim();
		if (!text || (message.role === "user" && text.startsWith("/"))) continue;
		messages.push({ role: message.role, text: text.slice(0, 2000) });
	}
	if (!messages.some((message) => message.role === "user") || !messages.some((message) => message.role === "assistant")) return "";
	// 长会话保留最初任务和最近对话，避免全量历史带来的费用和延迟。
	const selected = messages.length > 6 ? [messages[0], ...messages.slice(-5)] : messages;
	return selected.map((message) => `${message.role}: ${message.text}`).join("\n\n").slice(0, 12_000);
}

/** 首轮正常交互结束后，调度标题专用子 agent；已有名称永不覆盖。 */
export function registerAutoTitle(pi, { onUpdate = () => {}, onInvoke = () => {} } = {}) {
	let pendingInput = false;
	let request;
	let warned = false;
	const reset = () => {
		pendingInput = false;
		request?.controller.abort();
		clearTimeout(request?.timeout);
		request = undefined;
	};
	pi.on("session_start", () => { warned = false; reset(); });
	pi.on("session_shutdown", reset);
	pi.on("session_tree", reset);
	pi.on("session_info_changed", reset);
	pi.on("input", (event, ctx) => {
		if (ctx.mode !== "tui" || event.source !== "interactive" || pi.getSessionName()) return;
		const text = event.text.trim();
		if (text && !text.startsWith("/")) pendingInput = true;
	});
	pi.on("agent_settled", (event, ctx) => {
		const shouldGenerate = pendingInput;
		pendingInput = false;
		if (!shouldGenerate || event.aborted || ctx.mode !== "tui" || pi.getSessionName() || request) return;
		const text = buildTitleContext(ctx.sessionManager.getBranch());
		if (!text) return;
		const job = { controller: new AbortController(), sessionId: ctx.sessionManager.getSessionId() };
		request = job;
		// 子 agent 不产生会话条目，在请求开始时上报，供状态栏累计会话用量。
		onInvoke(ctx);
		job.timeout = setTimeout(() => job.controller.abort(), TITLE_TIMEOUT_MS);
		job.timeout.unref?.();

		// 不返回此 Promise：命名请求不得延迟 agent_settled、后续输入或完成统计。
		void (async () => {
			try {
				const generated = await generateSessionTitle(text, ctx, job.controller.signal);
				if (request !== job || job.controller.signal.aborted || ctx.sessionManager.getSessionId() !== job.sessionId || pi.getSessionName()) return;
				const title = normalizeSessionTitle(generated);
				if (!title) throw new Error("标题子 agent 返回了无效标题");
				pi.setSessionName(title);
				onUpdate(ctx);
			} catch (error) {
				// 失败不打断主流程，也不改用主模型；每个会话最多提示一次，后续交互可重试。
				if (request === job && !warned && ctx.sessionManager.getSessionId() === job.sessionId && !pi.getSessionName()) {
					warned = true;
					const reason = stripTerminalSequences(String(error?.message ?? error)).replace(/[\x00-\x1f\x7f-\x9f]/g, " ").slice(0, 240);
					ctx.ui.notify(`自动会话命名失败：${reason}`, "warning");
				}
			} finally {
				clearTimeout(job.timeout);
				if (request === job) request = undefined;
			}
		})();
	});
}
