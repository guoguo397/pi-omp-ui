import { AssistantMessageComponent, ToolExecutionComponent, keyText } from "@earendil-works/pi-coding-agent";
import { Container, Spacer } from "@earendil-works/pi-tui";
import { COMPACT_TOOLS, status } from "./format.js";
import { fitGroupRow, fitLine, padding, renderGroupHeader, renderTool } from "./render.js";

const PATCH_KEY = Symbol.for("pi-omp-editor.tool-ui");
const CC_KEYS = ["pi.ccstyle.global-tool-render-patch", "pi.ccstyle.tool-grouping-patch"];

/** 不接管已安装的 ccstyle，也不修改它的设置；卸载对方并 /reload 后可独立接管。 */
export function hasExternalToolUi() {
	return CC_KEYS.some((key) => globalThis[Symbol.for(key)]?.active === true);
}

function isCompact(tool) {
	return tool instanceof ToolExecutionComponent && COMPACT_TOOLS.has(tool.toolName);
}

function isGroupable(tool) {
	return isCompact(tool) && tool.toolName !== "edit" && tool.toolName !== "write" &&
		!(tool.result?.content ?? []).some((item) => item.type === "image");
}

function isEmpty(component) {
	return component instanceof Spacer ||
		(component instanceof AssistantMessageComponent && component.contentContainer?.children?.length === 0);
}

/** 虚拟分组只参与渲染和鼠标命中，工具始终留在原组件树，保留原生遍历/展开逻辑。 */
class ToolGroup {
	constructor(tools, state) {
		this.tools = tools;
		this.state = state;
		this.layout = [];
	}

	invalidate() {}

	render(width) {
		this.layout = [];
		if (width < 1) return [];
		const { tools, state } = this;
		const theme = state.theme();
		const expanded = tools.some((tool) => tool.expanded);
		const pad = padding(tools[0], width);
		const inner = Math.max(1, width - pad * 2);
		const indent = " ".repeat(pad);
		const lines = ["", indent + fitLine(renderGroupHeader(tools, theme, expanded, state.hint()), inner)];
		if (expanded) {
			for (const tool of tools) {
				const output = tool.render(width);
				this.layout.push({ tool, y: lines.length, height: output.length });
				lines.push(...output);
			}
		} else {
			const shown = tools.slice(-8);
			if (shown.length < tools.length) lines.push(indent + fitLine(theme.fg("dim", `├ … ${tools.length - shown.length} earlier calls`), inner));
			for (let index = 0; index < shown.length; index++) {
				lines.push(indent + fitGroupRow(shown[index], inner, theme, index === shown.length - 1));
			}
		}
		if (tools.some((tool) => status(tool) === "running")) state.animate(tools[0]);
		return lines;
	}

	handleMouse(event) {
		if (event.type === "click" && event.button === "left" && event.y === 1) {
			const expanded = !this.tools.some((tool) => tool.expanded);
			for (const tool of this.tools) tool.setExpanded(expanded);
			this.tools[0].ui?.requestRender();
			return { handled: true };
		}
		for (const { tool, y, height } of this.layout) {
			if (event.y >= y && event.y < y + height) return tool.handleMouse({ ...event, y: event.y - y, height });
		}
		return undefined;
	}
}

function project(children, state) {
	const projected = [];
	let changed = false;
	for (let index = 0; index < children.length;) {
		const first = children[index];
		if (!isGroupable(first)) { projected.push(first); index++; continue; }
		const tools = [first];
		let end = index + 1;
		let cursor = end;
		while (cursor < children.length) {
			if (isEmpty(children[cursor])) { cursor++; continue; }
			if (!isGroupable(children[cursor])) break;
			tools.push(children[cursor]);
			end = ++cursor;
		}
		if (tools.length === 1) { projected.push(first); index++; continue; }
		let group = state.groups.get(first);
		if (!group) { group = new ToolGroup(tools, state); state.groups.set(first, group); }
		else group.tools = tools;
		projected.push(group);
		changed = true;
		index = end;
	}
	return changed ? projected : undefined;
}

/** Pi 1.3.0 的组件适配仅覆盖 render/handleMouse，不改工具定义、结果或执行路径。 */
export function installToolUi({ theme, hint }) {
	globalThis[PATCH_KEY]?.dispose();
	const toolPrototype = ToolExecutionComponent.prototype;
	const containerPrototype = Container.prototype;
	const original = { toolRender: toolPrototype.render, toolMouse: toolPrototype.handleMouse, containerRender: containerPrototype.render };
	const state = {
		active: true,
		groups: new WeakMap(),
		theme,
		hint: hint ?? (() => `${keyText("app.tools.expand") || "Ctrl+O"} to show more`),
		timer: undefined,
		isEnabled: () => state.active && !hasExternalToolUi(),
		animate(tool) {
			if (state.timer !== undefined || !state.isEnabled()) return;
			state.timer = setTimeout(() => {
				state.timer = undefined;
				if (state.isEnabled()) tool.ui?.requestRender();
			}, 90);
			state.timer.unref?.();
		},
	};
	const toolRender = function (width) {
		if (!state.isEnabled() || !isCompact(this)) return original.toolRender.call(this, width);
		if (status(this) === "running") state.animate(this);
		return renderTool(this, width, state.theme(), state.hint());
	};
	const toolMouse = function (event) {
		if (!state.isEnabled() || !isCompact(this)) return original.toolMouse.call(this, event);
		if (event.type !== "click" || event.button !== "left" || event.y < 1 || event.y >= event.height) return undefined;
		this.setExpanded(!this.expanded);
		this.ui?.requestRender();
		return { handled: true };
	};
	const containerRender = function (width) {
		if (!state.isEnabled() || this instanceof ToolExecutionComponent || !Array.isArray(this.children)) return original.containerRender.call(this, width);
		const children = project(this.children, state);
		if (!children) return original.containerRender.call(this, width);
		const lines = [];
		const layout = [];
		for (const component of children) {
			const output = component.render(width);
			layout.push({ component, height: output.length });
			for (const line of output) lines.push(line);
		}
		// 与 Pi 1.3.0 的 Container.handleMouse 契约一致，坐标按实际渲染高度分发。
		this.mouseLayout = { width, children: layout };
		return lines;
	};
	toolPrototype.render = toolRender;
	toolPrototype.handleMouse = toolMouse;
	containerPrototype.render = containerRender;
	const patch = {
		dispose() {
			if (!state.active) return;
			state.active = false;
			clearTimeout(state.timer);
			if (toolPrototype.render === toolRender) toolPrototype.render = original.toolRender;
			if (toolPrototype.handleMouse === toolMouse) toolPrototype.handleMouse = original.toolMouse;
			if (containerPrototype.render === containerRender) containerPrototype.render = original.containerRender;
			if (globalThis[PATCH_KEY] === patch) delete globalThis[PATCH_KEY];
		},
	};
	globalThis[PATCH_KEY] = patch;
	return patch;
}
