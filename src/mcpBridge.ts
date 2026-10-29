import { randomBytes } from 'node:crypto';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';

export interface BridgeTool {
	readonly name: string;
	readonly description: string;
	readonly inputSchema: object;
}

export interface BridgeHost {
	listTools(): readonly BridgeTool[];
	/** Runs a tool for the chat session `sessionKey` and returns its text result. Throws on failure. */
	callTool(sessionKey: string, name: string, input: unknown): Promise<string>;
}

interface JsonRpcMessage {
	readonly id?: number | string;
	readonly method: string;
	readonly params?: any;
}

const PROTOCOL_VERSION = '2025-06-18';

/**
 * A loopback MCP server (Streamable HTTP, JSON responses only) that exposes VS Code's tools to Kiro.
 * Each chat session gets its own random path, so one session cannot call another session's tools.
 */
export class McpBridge {
	private server?: http.Server;
	private port = 0;
	private readonly sessionByToken = new Map<string, string>();
	private readonly tokenBySession = new Map<string, string>();

	constructor(private readonly host: BridgeHost) { }

	async start(): Promise<void> {
		if (this.server) {
			return;
		}
		const server = http.createServer((request, response) => void this.handle(request, response));
		await new Promise<void>((resolve, reject) => {
			server.once('error', reject);
			server.listen(0, '127.0.0.1', () => resolve());
		});
		this.server = server;
		this.port = (server.address() as AddressInfo).port;
	}

	/** The MCP endpoint a session passes to `session/new`. Stable for the life of the bridge. */
	urlFor(sessionKey: string): string {
		let token = this.tokenBySession.get(sessionKey);
		if (!token) {
			token = randomBytes(16).toString('hex');
			this.tokenBySession.set(sessionKey, token);
			this.sessionByToken.set(token, sessionKey);
		}
		return `http://127.0.0.1:${this.port}/mcp/${token}`;
	}

	/** Forgets a session's endpoint once its turn is over, so the URL stops answering. */
	release(sessionKey: string): void {
		const token = this.tokenBySession.get(sessionKey);
		if (token) {
			this.tokenBySession.delete(sessionKey);
			this.sessionByToken.delete(token);
		}
	}

	dispose(): void {
		this.server?.close();
		this.server = undefined;
		this.sessionByToken.clear();
		this.tokenBySession.clear();
	}

	private async handle(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
		const match = /^\/mcp\/([0-9a-f]{32})$/.exec(request.url ?? '');
		const sessionKey = match ? this.sessionByToken.get(match[1]) : undefined;
		if (!sessionKey || request.method !== 'POST') {
			response.writeHead(404).end();
			return;
		}

		let body = '';
		for await (const chunk of request) {
			body += chunk;
		}

		let message: JsonRpcMessage;
		try {
			message = JSON.parse(body);
		} catch {
			response.writeHead(400).end();
			return;
		}

		const reply = await this.dispatch(sessionKey, message);
		if (reply === undefined) {
			response.writeHead(202).end();
			return;
		}
		response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(reply));
	}

	private async dispatch(sessionKey: string, message: JsonRpcMessage): Promise<object | undefined> {
		const id = message.id;
		if (id === undefined) {
			return undefined; // Notifications such as notifications/initialized get no reply.
		}

		switch (message.method) {
			case 'initialize':
				return result(id, {
					protocolVersion: message.params?.protocolVersion ?? PROTOCOL_VERSION,
					capabilities: { tools: {} },
					serverInfo: { name: 'vscode', version: '1.0.0' },
				});
			case 'ping':
				return result(id, {});
			case 'tools/list':
				return result(id, { tools: this.host.listTools() });
			case 'tools/call':
				try {
					const text = await this.host.callTool(sessionKey, message.params?.name, message.params?.arguments ?? {});
					return result(id, { content: [{ type: 'text', text }] });
				} catch (error) {
					// A failed tool is a tool result the model can read, not a protocol error.
					const text = error instanceof Error ? error.message : String(error);
					return result(id, { isError: true, content: [{ type: 'text', text }] });
				}
			default:
				return { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not supported: ${message.method}` } };
		}
	}
}

function result(id: number | string, value: object): object {
	return { jsonrpc: '2.0', id, result: value };
}
