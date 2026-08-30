// dsh-tauri-turnrewind — client bundle (browser).
// Registers a keyed renderer for the `conversation.chat.commandview` slot at
// key "undo", replacing the generic plain-text command card with a diff-aware
// view that renders deletions red and additions green.
//
// Hand-written against the DSH client module contract:
//   window.__ModuleLoader__.load({ id, factory }) where factory receives a
//   CommonJS-style `require` and must export `apply` (cordis plugin) + `inject`
//   (list of cordis services the apply() context needs).
window.__ModuleLoader__.load({
	id: "dsh-tauri-turnrewind/client",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		var React = require("react");
		var jsxRuntime = require("react/jsx-runtime");
		var jsx = jsxRuntime.jsx;
		var jsxs = jsxRuntime.jsxs;

		var inject = ["slots"];

		// ------------------------------------------------------------------
		// Unified-diff line classification.
		// ------------------------------------------------------------------
		function classifyLine(raw) {
			var line = raw;
			if (/^\s*diff --git /.test(line)) return { kind: "meta", text: line.trim() };
			if (/^\s*index /.test(line)) return { kind: "meta", text: line.trim() };
			if (/^\s*---\s+a\//.test(line)) return { kind: "meta", text: line.trim() };
			if (/^\s*\+\+\+\s+b\//.test(line)) return { kind: "meta", text: line.trim() };
			if (/^\s*@@/.test(line)) return { kind: "hunk", text: line.trim() };
			if (/^\s*-/.test(line)) return { kind: "del", text: line.replace(/^\s*-/, "") };
			if (/^\s*\+/.test(line)) return { kind: "add", text: line.replace(/^\s*\+/, "") };
			return { kind: "ctx", text: line.replace(/^\s+/, "") };
		}

		function isDiffLine(raw) {
			return /^\s*(diff --git |index |--- |\+\+\+ |@@|-[^-]|\+[^+]|-$|\+$)/.test(raw);
		}

		// A "section separator" we emit in the preview, e.g. "--- undo-demo.txt".
		function isFileSeparator(raw) {
			return /^---\s+(?!a\/)\S/.test(raw);
		}

		// ------------------------------------------------------------------
		// Rendering.
		// ------------------------------------------------------------------
		var COLORS = {
			delBg: "rgba(248,81,73,0.16)",
			delSign: "#f85149",
			addBg: "rgba(46,160,67,0.16)",
			addSign: "#3fb950",
			hunk: "#79b8ff",
			meta: "#8b949e",
			ctx: "#c9d1d9",
			border: "#30363d",
			bg: "var(--dsw-alias-markdown-code-block, #161b22)",
			label: "var(--dsw-alias-label-tertiary, #8b949e)",
			title: "var(--dsw-alias-label-secondary, #c9d1d9)",
		};

		function diffLineStyle(kind) {
			switch (kind) {
				case "del": return { background: COLORS.delBg, color: COLORS.ctx };
				case "add": return { background: COLORS.addBg, color: COLORS.ctx };
				case "hunk": return { color: COLORS.hunk };
				case "meta": return { color: COLORS.meta };
				default: return { color: COLORS.ctx };
			}
		}

		function signFor(kind) {
			if (kind === "del") return "-";
			if (kind === "add") return "+";
			return " ";
		}

		function DiffLine(props) {
			var entry = props.entry;
			var style = diffLineStyle(entry.kind);
			return jsxs("div", {
				style: Object.assign(
					{ display: "flex", fontFamily: "var(--ds-font-family-code, monospace)", fontSize: "12.5px", lineHeight: "20px", paddingLeft: 8, paddingRight: 8, whiteSpace: "pre-wrap", wordBreak: "break-all" },
					style
				),
				children: [
					jsx("span", {
						style: { width: 16, flex: "none", color: entry.kind === "del" ? COLORS.delSign : entry.kind === "add" ? COLORS.addSign : COLORS.meta, userSelect: "none" },
						children: signFor(entry.kind)
					}),
					jsx("span", { style: { flex: 1 }, children: entry.text })
				]
			});
		}

		function UndoCommandView(props) {
			var node = props.node || {};
			var outcome = node.outcome;
			var text = outcome && typeof outcome.text === "string" ? outcome.text : "";
			var state = outcome == null ? "running" : outcome.kind === "error" ? "error" : "ok";
			var summary = text ? text.split("\n")[0] : (state === "error" ? "失败" : state === "running" ? "运行中" : "已完成");
			var body = text.indexOf("\n") >= 0 ? text : null;
			var expandedState = React.useState(body !== null);
			var expanded = expandedState[0];
			var setExpanded = expandedState[1];

			var lines = body ? body.split("\n") : [];
			var rows = [];
			for (var i = 0; i < lines.length; i++) {
				var raw = lines[i];
				if (isFileSeparator(raw)) {
					rows.push(jsx("div", {
						style: { fontFamily: "var(--ds-font-family-code, monospace)", fontSize: "12.5px", lineHeight: "20px", paddingLeft: 8, paddingRight: 8, color: COLORS.title, fontWeight: 600 },
						children: raw.replace(/^---\s+/, "")
					}, "fs" + i));
				}
				else if (isDiffLine(raw)) {
					rows.push(jsx(DiffLine, { entry: classifyLine(raw) }, "l" + i));
				}
				else {
					rows.push(jsx("div", {
						style: { fontFamily: "var(--ds-font-family-code, monospace)", fontSize: "12.5px", lineHeight: "20px", paddingLeft: 8, paddingRight: 8, color: COLORS.label, whiteSpace: "pre-wrap", wordBreak: "break-word" },
						children: raw
					}, "p" + i));
				}
			}

			return jsxs("div", {
				style: { border: "1px solid " + COLORS.border, background: COLORS.bg, borderRadius: 12, margin: "4px 0 4px 4px", overflow: "hidden", maxWidth: "100%" },
				children: [
					jsxs("button", {
						type: "button",
						onClick: function () { setExpanded(function (v) { return !v; }); },
						style: { display: "flex", alignItems: "center", gap: 8, width: "100%", textAlign: "left", background: "transparent", border: "none", cursor: "pointer", padding: "8px 12px", color: COLORS.title, fontSize: 13 },
						children: [
							jsx("span", { style: { transform: expanded ? "rotate(90deg)" : "rotate(0deg)", transition: "transform .12s", display: "inline-block", color: COLORS.label }, children: "▸" }),
							jsx("span", { style: { fontWeight: 500 }, children: node.name || "undo" }),
							jsx("span", { style: { color: COLORS.label, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1, minWidth: 0 }, children: summary })
						]
					}),
					expanded && body !== null ? jsx("div", {
						style: { borderTop: "1px solid " + COLORS.border, paddingTop: 8, paddingBottom: 8, maxHeight: 340, overflow: "auto" },
						children: rows
					}) : null
				]
			});
		}

		function apply(ctx) {
			ctx.slots.inject("conversation.chat.commandview", function () {
				return ctx.slots.register({
					name: "conversation.chat.commandview",
					key: "undo"
				}, UndoCommandView);
			});
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
