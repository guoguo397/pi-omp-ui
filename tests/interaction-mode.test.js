import assert from "node:assert/strict";
import { test } from "node:test";
import { MODE_ENTRY, MODE_STATUS, registerInteractionMode } from "../extensions/lib/interaction-mode.js";

function create(interfaceMode = "tui", initialEntries = []) {
	const handlers = new Map();
	const commands = new Map();
	const statuses = new Map();
	const notifications = [];
	const listeners = new Set();
	let entries = [...initialEntries];
	let idle = true;
	const ctx = {
		mode: interfaceMode,
		isIdle: () => idle,
		sessionManager: { getBranch: () => entries },
		ui: {
			setStatus(key, text) { if (text === undefined) statuses.delete(key); else statuses.set(key, text); },
			notify: (text, level) => notifications.push({ text, level }),
			onTerminalInput(handler) { listeners.add(handler); return () => listeners.delete(handler); },
		},
	};
	const controller = registerInteractionMode({
		on(name, handler) { handlers.set(name, handler); },
		registerCommand(name, command) { commands.set(name, command); },
		appendEntry(customType, data) { entries.push({ type: "custom", customType, data }); },
	});
	return {
		ctx, controller, commands, statuses, notifications, listeners,
		get entries() { return entries; },
		set entries(value) { entries = value; },
		set idle(value) { idle = value; },
		emit: (name, event = {}) => handlers.get(name)?.(event, ctx),
		command: (args = "") => commands.get("omp-mode").handler(args, ctx),
		input(data) { return [...listeners].map((handler) => handler(data)).find(Boolean); },
	};
}

const modeEntry = (mode) => ({ type: "custom", customType: MODE_ENTRY, data: { mode } });
const prompt = () => ({ messageType: "user", systemPromptOptions: { sections: { existing: "preserve me" } } });

test("execution is the default and does not change tool execution or run shell commands", async () => {
	const session = create();
	session.emit("session_start");
	assert.equal(session.controller.getMode(), "execute");
	assert.match(session.statuses.get(MODE_STATUS), /⏵⏵ accept edits on \(shift\+tab to cycle\)/);
	for (const toolName of ["edit", "write", "powershell", "bash", "codemode", "mcp__server__write", "custom"]) {
		assert.equal(session.emit("tool_call", { toolName }), undefined);
	}
	assert.equal(session.emit("user_bash"), undefined);
	assert.equal(session.entries.length, 0, "no unnecessary persistence on startup");
	await session.command();
	assert.match(session.notifications.at(-1).text, /execute/);
	await session.command("auto");
	assert.equal(session.notifications.at(-1).level, "warning");
	assert.equal(session.controller.getMode(), "execute", "there is no third mode");
});

test("Shift+Tab toggles exactly two modes and persists them without touching the active tool set", () => {
	const session = create();
	session.emit("session_start");
	assert.deepEqual(session.input("\x1b[Z"), { consume: true });
	assert.equal(session.controller.getMode(), "plan");
	assert.match(session.statuses.get(MODE_STATUS), /⏸ plan mode/);
	assert.deepEqual(session.entries, [modeEntry("plan")]);
	assert.deepEqual(session.input("\x1b[9;2u"), { consume: true }, "Kitty Shift+Tab is supported");
	assert.equal(session.controller.getMode(), "execute");
	assert.deepEqual(session.entries, [modeEntry("plan"), modeEntry("execute")]);
	assert.equal(session.input("ordinary text"), undefined);
});

test("plan mode blocks edits, shells, codemode, MCP and unknown tools, including nested calls", async () => {
	const session = create();
	session.emit("session_start");
	await session.command("plan");
	for (const toolName of ["read", "grep", "find", "ls"]) {
		assert.equal(session.emit("tool_call", { toolName, input: {} }), undefined);
	}
	for (const toolName of ["edit", "write", "bash", "powershell", "codemode", "tool_search", "flash", "custom", "mcp__mysql__read_query", "mcp__wordcraft__write", "tools.read", "Read"]) {
		for (const parentToolCallId of [undefined, "parent/1"]) {
			const result = session.emit("tool_call", { toolName, parentToolCallId, input: {} });
			assert.equal(result.block, true, toolName);
			assert.match(result.reason, /Plan mode:.*blocked/);
		}
	}
	assert.deepEqual(session.emit("user_bash", { command: "git status" }), { result: {
		output: "Plan mode: shell commands are blocked. Use /omp-mode execute first.",
		exitCode: 1, cancelled: false, truncated: false,
	} });
	await session.command("execute");
	assert.equal(session.emit("tool_call", { toolName: "write" }), undefined);
	assert.equal(session.emit("user_bash"), undefined);
});

test("mode guidance composes with prompt sections for user and custom runs, and does not auto-execute a plan", async () => {
	const session = create();
	session.emit("session_start");
	await session.command("plan");
	for (const messageType of ["user", "custom"]) {
		const event = { ...prompt(), messageType };
		session.emit("before_agent_start", event);
		assert.equal(event.systemPromptOptions.sections.existing, "preserve me");
		assert.match(event.systemPromptOptions.sections.omp_interaction_mode, /PLAN MODE/);
		assert.match(event.systemPromptOptions.sections.omp_interaction_mode, /Do not modify files/);
		session.emit("agent_settled");
		assert.equal(session.controller.getMode(), "plan", "plan completion never switches automatically");
	}
	await session.command("execute");
	const event = prompt();
	session.emit("before_agent_start", event);
	assert.match(event.systemPromptOptions.sections.omp_interaction_mode, /EXECUTION MODE/);
	assert.doesNotMatch(event.systemPromptOptions.sections.omp_interaction_mode, /Only read, grep/);
	assert.equal(event.systemPromptOptions.sections.existing, "preserve me");
});

test("switching is rejected until final settlement and also while the host is busy", async () => {
	const session = create();
	session.emit("session_start");
	session.emit("before_agent_start", prompt());
	assert.deepEqual(session.input("\x1b[Z"), { consume: true });
	assert.equal(session.controller.getMode(), "execute");
	assert.equal(session.entries.length, 0);
	session.emit("agent_end");
	await session.command("plan");
	assert.equal(session.controller.getMode(), "execute", "retry/queued continuation remains busy");
	session.emit("agent_settled", { aborted: true });
	session.idle = false;
	await session.command("plan");
	assert.equal(session.controller.getMode(), "execute", "host startup/compaction also prevents switching");
	session.idle = true;
	await session.command("plan");
	assert.equal(session.controller.getMode(), "plan");
	session.emit("before_agent_start", prompt());
	await session.command("execute");
	assert.equal(session.controller.getMode(), "plan", "running plan cannot silently become execution");
	assert.equal(session.emit("tool_call", { toolName: "write" }).block, true);
	session.emit("agent_settled");
	await session.command("execute");
	assert.equal(session.controller.getMode(), "execute");
});

test("pasted keys, key releases and modal prompts are not consumed or treated as mode changes", () => {
	const session = create();
	session.emit("session_start");
	for (const data of ["\x1b[200~", "\x1b[Z", "\x1b[201~", "\x1b[200~\x1b[Z\x1b[201~", "\x1b[9;2:3u"]) {
		assert.equal(session.input(data), undefined);
	}
	assert.equal(session.controller.getMode(), "execute");
	session.emit("ui_prompt_start");
	session.emit("ui_prompt_start");
	session.emit("ui_prompt_end");
	assert.equal(session.input("\x1b[Z"), undefined);
	session.emit("ui_prompt_end");
	session.input("\x1b[Z");
	assert.equal(session.controller.getMode(), "plan");
});

test("reload, resume and tree navigation restore the active branch; new sessions default to execution", async () => {
	const session = create();
	session.emit("session_start");
	await session.command("plan");
	await session.command("plan");
	assert.equal(session.entries.length, 1, "setting current mode is idempotent");
	session.emit("session_shutdown");
	assert.equal(session.listeners.size, 0);
	assert.equal(session.statuses.size, 0);
	const reloaded = create("tui", session.entries);
	reloaded.emit("session_start");
	assert.equal(reloaded.controller.getMode(), "plan");
	reloaded.entries = [modeEntry("execute")];
	reloaded.emit("session_tree");
	assert.equal(reloaded.controller.getMode(), "execute");
	reloaded.entries = [modeEntry("execute"), modeEntry("plan")];
	reloaded.emit("session_tree");
	assert.equal(reloaded.controller.getMode(), "plan");
	reloaded.emit("session_start");
	assert.equal(reloaded.listeners.size, 1, "startup replaces old input subscription");
	reloaded.entries = [];
	reloaded.emit("session_start");
	assert.equal(reloaded.controller.getMode(), "execute");
});

test("RPC, JSON and print modes neither restrict tools nor change prompts, statuses or persisted mode", async () => {
	for (const mode of ["rpc", "json", "print"]) {
		const session = create(mode, [modeEntry("plan")]);
		session.ctx.sessionManager.getBranch = () => { throw new Error("must not read branch outside TUI"); };
		session.emit("session_start");
		await session.command("plan");
		const event = prompt();
		session.emit("before_agent_start", event);
		assert.deepEqual(event.systemPromptOptions.sections, { existing: "preserve me" });
		assert.equal(session.emit("tool_call", { toolName: "edit" }), undefined);
		assert.equal(session.emit("user_bash"), undefined);
		session.emit("session_tree");
		session.emit("session_shutdown");
		assert.equal(session.listeners.size, 0);
		assert.equal(session.statuses.size, 0);
		assert.equal(session.notifications.length, 0);
		assert.deepEqual(session.entries, [modeEntry("plan")]);
	}
});
