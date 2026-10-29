import { randomUUID } from 'node:crypto';
import type { AcpClient, ConfigOption } from './acpClient';
import type { KiroConversation } from './conversation';
import { usageFrom, type UsageReport } from './kiroAgent';
import type { BridgeTool, McpBridge } from './mcpBridge';

/**
 * What a turn needs to start. `prompt` is sent when the Kiro session already holds the earlier messages.
 * `transcript` is sent when a new session has to be created, so it must carry the whole chat.
 */
export interface TurnSetup {
	readonly agent: string;
	readonly model: string;
	readonly effort?: string;
	readonly prompt: string;
	readonly transcript: string;
	readonly tools: readonly BridgeTool[];
}

/** The result of a tool call, handed back to Kiro. */
export interface ToolResult {
	readonly callId: string;
	readonly text: string;
	readonly isError: boolean;
}

/** What a consumer of the turn receives, in order. */
export type TurnEvent =
	| { readonly kind: 'text'; readonly text: string }
	| { readonly kind: 'tool'; readonly callId: string; readonly name: string; readonly input: unknown }
	| { readonly kind: 'done'; readonly stopReason: string }
	| { readonly kind: 'error'; readonly error: Error };

export interface TurnHooks {
	readonly onUsage: (usage: UsageReport) => void;
	readonly log: (line: string) => void;
	/** Called once the turn has ended. The conversation's Kiro session stays as it is for the next message. */
	readonly onFinish: (turn: KiroTurn) => void;
}

/** ponytail: a handed-off tool call that nobody answers within this time cancels the turn. Fixed limit, no setting. */
const TOOL_WAIT_MS = 10 * 60_000;

interface PendingCall {
	readonly settle: (result: ToolResult) => void;
}

function currentValue(options: readonly ConfigOption[], id: string): string | undefined {
	return options.find(option => option.id === id)?.currentValue;
}

function describe(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * One prompt within a conversation. Kiro calls VS Code's tools through the MCP bridge. Each call becomes a
 * `tool` event, so the chat can run the tool with its own context. The turn waits in `callTool` until
 * `resolveTools` supplies the result.
 */
export class KiroTurn {
	tools: readonly BridgeTool[] = [];
	/** True when the turn ended with an error. The conversation should then be discarded. */
	failed = false;

	private readonly events: TurnEvent[] = [];
	private wake?: () => void;
	private readonly calls = new Map<string, PendingCall>();
	private readonly controller = new AbortController();
	private waitTimer?: ReturnType<typeof setTimeout>;

	constructor(
		readonly conversation: KiroConversation,
		private readonly acp: AcpClient,
		private readonly bridge: McpBridge,
		private readonly hooks: TurnHooks,
	) { }

	/** Starts the prompt. Read the events with `next()`. */
	start(setup: TurnSetup): void {
		this.tools = setup.tools;
		void this.run(setup);
	}

	/** The next event of the turn. Waits for one when none is queued. */
	next(): Promise<TurnEvent> {
		const queued = this.events.shift();
		if (queued) {
			return Promise.resolve(queued);
		}
		return new Promise(resolve => {
			this.wake = () => {
				this.wake = undefined;
				resolve(this.events.shift() as TurnEvent);
			};
		});
	}

	/** True when this turn has a tool call waiting for a result with this id. */
	owns(callId: string): boolean {
		return this.calls.has(callId);
	}

	/** Gives Kiro the results of its tool calls. Results for calls this turn does not own are ignored. */
	resolveTools(results: readonly ToolResult[]): void {
		for (const result of results) {
			const call = this.calls.get(result.callId);
			if (call) {
				this.calls.delete(result.callId);
				call.settle(result);
			}
		}
		this.armWaitTimer();
	}

	/** Called by the MCP bridge when Kiro calls one of the VS Code tools. */
	callTool(name: string, input: unknown): Promise<string> {
		return new Promise<string>((resolve, reject) => {
			if (this.controller.signal.aborted) {
				reject(new Error('The chat request was cancelled.'));
				return;
			}
			if (!this.tools.some(tool => tool.name === name)) {
				reject(new Error(`The ${name} tool is not enabled for this chat request.`));
				return;
			}
			const callId = `kiro-${randomUUID()}`;
			this.calls.set(callId, {
				settle: result => result.isError ? reject(new Error(result.text)) : resolve(result.text),
			});
			this.push({ kind: 'tool', callId, name, input });
			this.armWaitTimer();
		});
	}

	/** Stops the turn. Tool calls that are still waiting get an error result. */
	cancel(): void {
		this.controller.abort();
		this.settleAll('The chat request was cancelled.');
	}

	private async run(setup: TurnSetup): Promise<void> {
		try {
			if (this.controller.signal.aborted) {
				this.push({ kind: 'done', stopReason: 'cancelled' });
				return;
			}
			await this.bridge.start();
			const { sessionId, restored } = await this.attach(setup.agent);
			await this.acp.setOption(sessionId, 'model', setup.model);
			if (setup.effort) {
				await this.acp.setOption(sessionId, 'effortLevel', setup.effort);
			}
			const text = restored ? setup.prompt : setup.transcript;
			const stopReason = await this.acp.prompt(sessionId, text, update => this.onUpdate(update), this.controller.signal);
			this.push({ kind: 'done', stopReason });
		} catch (error) {
			this.failed = true;
			this.push({ kind: 'error', error: error instanceof Error ? error : new Error(String(error)) });
		} finally {
			this.finish();
		}
	}

	/**
	 * Returns the conversation's Kiro session, ready for a prompt. An open session is used as it is. A saved
	 * session is reopened, which brings back its history. When there is none, or Kiro cannot reopen it, a new
	 * session is created and the caller has to send the whole transcript.
	 */
	private async attach(agent: string): Promise<{ sessionId: string; restored: boolean }> {
		const conversation = this.conversation;
		const url = this.bridge.urlFor(conversation.key);
		if (conversation.acpSessionId && conversation.isOpen) {
			return { sessionId: conversation.acpSessionId, restored: true };
		}

		if (conversation.acpSessionId) {
			const saved = conversation.acpSessionId;
			try {
				if (!(await this.acp.hasSession(saved))) {
					throw new Error('Kiro no longer lists this session');
				}
				await this.acp.loadSession(saved, url);
				conversation.loadedIn = this.acp.processId;
				this.hooks.log(`Reopened Kiro session ${saved}.`);
			} catch (error) {
				this.hooks.log(`Could not reopen Kiro session ${saved} (${describe(error)}). Starting a new session.`);
				conversation.acpSessionId = undefined;
				conversation.loadedIn = undefined;
			}
			if (conversation.acpSessionId) {
				await this.switchAgent(saved, agent);
				return { sessionId: saved, restored: true };
			}
		}

		const created = await this.acp.newSession(url);
		conversation.acpSessionId = created.sessionId;
		conversation.loadedIn = this.acp.processId;
		await this.switchAgent(created.sessionId, agent);
		return { sessionId: created.sessionId, restored: false };
	}

	/** Sets the agent that owns the tools. Without it Kiro would also get its built-in file and shell tools. */
	private async switchAgent(sessionId: string, agent: string): Promise<void> {
		const options = await this.acp.setOption(sessionId, 'mode', agent);
		if (currentValue(options, 'mode') !== agent) {
			throw new Error(`Kiro did not switch to the ${agent} agent, so the request was not sent.`);
		}
	}

	private finish(): void {
		clearTimeout(this.waitTimer);
		this.settleAll('The Kiro turn ended before the tool call finished.');
		this.hooks.onFinish(this);
	}

	private onUpdate(update: any): void {
		if (update?.sessionUpdate === 'agent_message_chunk' && update.content?.type === 'text') {
			this.push({ kind: 'text', text: update.content.text });
			return;
		}
		const usage = usageFrom(update);
		if (usage) {
			this.hooks.onUsage(usage);
		}
	}

	private push(event: TurnEvent): void {
		this.events.push(event);
		this.wake?.();
	}

	private settleAll(text: string): void {
		for (const [callId, call] of this.calls) {
			call.settle({ callId, text, isError: true });
		}
		this.calls.clear();
	}

	private armWaitTimer(): void {
		clearTimeout(this.waitTimer);
		if (this.calls.size > 0) {
			this.waitTimer = setTimeout(() => this.cancel(), TOOL_WAIT_MS);
		}
	}
}
