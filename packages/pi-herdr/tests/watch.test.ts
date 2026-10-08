import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { HerdrActionRuntime, type HerdrToolResult } from "../extensions/herdr-action-context.js";
import { HerdrClient } from "../extensions/herdr-client.js";
import { handlePaneAction } from "../extensions/herdr-pane-actions.js";
import { PaneAliasStore } from "../extensions/herdr-state.js";
import { READ_SOURCE, type HerdrToolInput, type PaneInfo, type PaneReadResult } from "../extensions/herdr-types.js";

type ExecResult = Awaited<ReturnType<ExtensionAPI["exec"]>>;

const pane: PaneInfo = {
	pane_id: "pane-2",
	workspace_id: "workspace-1",
	tab_id: "tab-1",
	focused: false,
	agent_status: "unknown",
	revision: 1,
};

function matchedOutput(text = "starting\nready"): ExecResult {
	const read: PaneReadResult = {
		pane_id: pane.pane_id,
		workspace_id: pane.workspace_id,
		tab_id: pane.tab_id,
		source: "recent",
		text,
		revision: 2,
		truncated: false,
	};
	return {
		code: 0,
		killed: false,
		stderr: "",
		stdout: JSON.stringify({ result: {
			type: "output_matched",
			pane_id: pane.pane_id,
			revision: 2,
			matched_line: "ready",
			read,
		} }),
	};
}

function watchHarness(
	watchExec: ExtensionAPI["exec"] = async () => matchedOutput(),
	signal?: AbortSignal,
) {
	const calls: string[][] = [];
	const updates: HerdrToolResult[] = [];
	const exec: ExtensionAPI["exec"] = async (command, args, options) => {
		assert.equal(command, "herdr");
		assert.equal(options?.signal, signal);
		calls.push(args);
		if (args[0] === "pane" && args[1] === "get") {
			assert.deepEqual(args, ["pane", "get", pane.pane_id]);
			return { code: 0, killed: false, stderr: "", stdout: JSON.stringify({ result: { pane } }) };
		}
		return watchExec(command, args, options);
	};
	// Only the external command boundary is stubbed; resolution and JSON/error handling are real.
	const client = new HerdrClient({ exec } as ExtensionAPI, "pane-1");
	const aliases = new PaneAliasStore();
	aliases.recordAlias("server", pane.pane_id, pane.workspace_id);
	const runtime = new HerdrActionRuntime(client, aliases, "pane-1", pane.workspace_id, signal, (update) => {
		updates.push(update);
	});
	return { runtime, calls, updates };
}

const watch: HerdrToolInput = { action: "watch", pane: "server", match: "ready" };

describe("watch", () => {
	it("uses pane wait-output with literal matching by default or when regex is false", async () => {
		for (const regex of [undefined, false]) {
			const { runtime, calls, updates } = watchHarness();
			const result = await handlePaneAction({ ...watch, match: "ready [1].*", regex, raw: false }, runtime);
			assert.deepEqual(calls, [
				["pane", "get", pane.pane_id],
				["pane", "wait-output", pane.pane_id, "--match", "ready [1].*"],
			]);
			assert.deepEqual(result?.content, [{ type: "text", text: "Matched: ready\n\nstarting\nready" }]);
			assert.equal(result?.details.action, "watch");
			assert.equal(result?.details.pane, "server");
			assert.equal(result?.details.paneId, pane.pane_id);
			assert.equal(result?.details.matchedLine, "ready");
			assert.deepEqual(result?.details.aliases, { server: { paneId: pane.pane_id, workspaceId: pane.workspace_id } });
			assert.deepEqual(updates[0]?.content, [{ type: "text", text: "Watching server..." }]);
		}
	});

	it("passes the pattern as the regex flag's value, with all optional flags", async () => {
		for (const source of Object.values(READ_SOURCE)) {
			const { runtime, calls } = watchHarness();
			await handlePaneAction({
				...watch, pane: pane.pane_id, match: "^ready\\s+\\d+$", regex: true,
				source, lines: 50, timeout: 5000, raw: true,
			}, runtime);
			assert.deepEqual(calls[1], [
				"pane", "wait-output", pane.pane_id, "--regex", "^ready\\s+\\d+$",
				"--source", source, "--lines", "50", "--timeout", "5000", "--raw",
			]);
		}
	});

	it("forwards zero-valued options and falls back to the matched line when read text is empty", async () => {
		const { runtime, calls } = watchHarness(async () => matchedOutput(""));
		const result = await handlePaneAction({ ...watch, lines: 0, timeout: 0 }, runtime);
		assert.deepEqual(calls[1], ["pane", "wait-output", pane.pane_id, "--match", "ready", "--lines", "0", "--timeout", "0"]);
		assert.deepEqual(result?.content, [{ type: "text", text: "Matched: ready\n\nready" }]);
	});

	it("rejects missing required fields and workspace/tab targets before invoking Herdr", async () => {
		const cases: Array<[HerdrToolInput, RegExp]> = [
			[{ ...watch, pane: undefined }, /'pane' is required for watch/],
			[{ ...watch, match: undefined }, /'match' is required for watch/],
			[{ ...watch, workspace: "workspace-1" }, /watch targets panes, not workspace/],
			[{ ...watch, tab: "tab-1" }, /watch targets panes, not tab/],
		];
		for (const [params, error] of cases) {
			const { runtime, calls } = watchHarness();
			await assert.rejects(handlePaneAction(params, runtime), error);
			assert.deepEqual(calls, []);
		}
	});

	it("clears progress updates after success, CLI rejection, or cancellation", async (t) => {
		for (const outcome of ["success", "exit-error", "json-error", "aborted", "killed"] as const) {
			await t.test(outcome, async (t) => {
				t.mock.timers.enable({ apis: ["setInterval"] });
				const controller = new AbortController();
				const { runtime, updates } = watchHarness(async () => {
					t.mock.timers.tick(1000);
					const result = matchedOutput();
					if (outcome === "exit-error") return { ...result, code: 1, stderr: "wait timed out" };
					if (outcome === "json-error") return { ...result, stdout: JSON.stringify({ error: { message: "invalid regex" } }) };
					if (outcome === "aborted") controller.abort();
					return { ...result, killed: outcome === "killed" };
				}, controller.signal);
				const pending = handlePaneAction(watch, runtime);
				if (outcome === "success") {
					assert.ok(await pending);
				} else {
					const error = outcome === "exit-error" ? /wait timed out/
						: outcome === "json-error" ? /invalid regex/ : /Aborted/;
					await assert.rejects(pending, error);
				}
				assert.equal(updates.length, 2);
				t.mock.timers.tick(2000);
				assert.equal(updates.length, 2, "watch must stop publishing updates after settling");
			});
		}
	});
});
