import { readSettings } from "./settings.js";

export const AUTO_TITLE_MAX = 40;

/** 由首条输入生成会话标题：折叠空白，跳过斜杠命令与空文本。 */
export function deriveSessionTitle(text, max = AUTO_TITLE_MAX) {
	const title = String(text ?? "").replace(/\s+/g, " ").trim();
	if (!title || title.startsWith("/")) return "";
	const chars = [...title];
	return chars.length > max ? `${chars.slice(0, max - 1).join("")}…` : title;
}

/** 会话未命名时，用首条交互输入自动命名（之后不再改动）。设置 autoTitle: false 可关闭。 */
export function registerAutoTitle(pi) {
	pi.on("input", (event) => {
		if (readSettings().autoTitle === false) return;
		if (event?.source !== "interactive") return;
		if (pi.getSessionName?.()) return;
		const title = deriveSessionTitle(event.text);
		if (title) pi.setSessionName?.(title);
	});
}
