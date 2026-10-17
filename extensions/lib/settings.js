import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const SETTINGS_PATH = join(getAgentDir(), "extension-settings", "omp-editor.json");

export function readSettings(path = SETTINGS_PATH) {
	try {
		const value = JSON.parse(readFileSync(path, "utf8"));
		return value && typeof value === "object" && !Array.isArray(value) ? value : {};
	} catch {
		return {};
	}
}

/** 各项功能共用文件；切换其中一项不能覆盖其他功能或未知配置。 */
export function updateSettings(partial, path = SETTINGS_PATH) {
	const next = { ...readSettings(path), ...partial };
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`, "utf8");
}
