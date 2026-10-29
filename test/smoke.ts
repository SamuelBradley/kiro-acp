import assert from 'node:assert/strict';
import * as os from 'node:os';
import * as path from 'node:path';
import { AcpClient } from '../src/acpClient';
import { KiroConversation } from '../src/conversation';
import { AGENT_NAME, installAgentProfile } from '../src/kiroAgent';
import { McpBridge, type BridgeTool } from '../src/mcpBridge';
import { modelsFrom } from '../src/models';
import { KiroTurn } from '../src/turn';

// End-to-end check against the real kiro-cli. One conversation goes through four steps:
// 1. a tool call, answered by this script the way the extension answers it;
// 2. a follow-up after its Kiro session was closed in this process;
// 3. a follow-up in a new kiro-cli process, as after a VS Code restart;
// 4. a follow-up whose saved session Kiro no longer has, which starts again from the transcript.
// Steps 2 and 3 can only be answered from Kiro's saved history, because the follow-up text does not contain it.
// Uses your kiro-cli login and a small amount of credits.

const verbose = process.env.KIRO_SMOKE_VERBOSE === '1';
const FOLLOW_UP = 'Do not call any tool. Reply with only the value that the marker_lookup tool returned earlier in this conversation.';

const tools: BridgeTool[] = [{ name: 'marker_lookup', description: 'Returns the secret marker value.', inputSchema: { type: 'object', properties: {} } }];
const turns = new Map<string, KiroTurn>();
const clients: AcpClient[] = [];

const bridge = new McpBridge({
	listTools: sessionKey => turns.get(sessionKey)?.tools ?? [],
	callTool: (sessionKey, name, input) => {
		const turn = turns.get(sessionKey);
		return turn ? turn.callTool(name, input) : Promise.reject(new Error('no turn is running'));
	},
});

function startClient(): AcpClient {
	const client = new AcpClient({
		cwd: os.homedir(),
		log: line => verbose && console.error(`[kiro] ${line.slice(0, 300)}`),
		// Accept the first option Kiro offers. The smoke test only runs the tool it was asked to run.
		onPermission: async request => request.options[0]?.optionId,
	});
	clients.push(client);
	return client;
}

/** Runs one turn to its end, playing VS Code's part for any tool call. */
async function runTurn(
	client: AcpClient,
	conversation: KiroConversation,
	prompt: string,
	model: string,
	transcript = prompt,
): Promise<{ answer: string; stop: string; handedOff: string[] }> {
	conversation.busy = true;
	const turn = new KiroTurn(conversation, client, bridge, {
		onUsage: () => undefined,
		log: line => verbose && console.error(`[turn] ${line}`),
		onFinish: finished => {
			turns.delete(finished.conversation.key);
			finished.conversation.busy = false;
		},
	});
	turns.set(conversation.key, turn);
	turn.start({ agent: AGENT_NAME, model, effort: 'low', prompt, transcript, tools });

	let answer = '';
	const handedOff: string[] = [];
	for (;;) {
		const event = await turn.next();
		if (event.kind === 'text') {
			answer += event.text;
		} else if (event.kind === 'tool') {
			handedOff.push(event.name);
			turn.resolveTools([{ callId: event.callId, text: 'MARKER-42', isError: false }]);
		} else if (event.kind === 'done') {
			return { answer, stop: event.stopReason, handedOff };
		} else {
			throw event.error;
		}
	}
}

async function main(): Promise<void> {
	// Kiro reads its agent list when it starts, so the profile must exist before the first kiro-cli process.
	installAgentProfile(path.join(os.homedir(), '.kiro', 'agents'));
	let client = startClient();
	const models = modelsFrom(await client.discoverConfig());
	console.log(`models: ${models.map(model => model.id).join(', ')}`);
	const haiku = models.find(model => model.id === 'claude-haiku-5.5');
	assert.ok(haiku, 'expected claude-haiku-5.5 in the model list');
	assert.ok(haiku.effortLevels.includes('low'), 'expected claude-haiku-5.5 to list effort levels');

	const conversation = new KiroConversation(client, bridge);
	try {
		// 1. The tool call.
		const first = await runTurn(client, conversation, 'Call the marker_lookup tool with no arguments, then reply with only the value it returned.', haiku.id);
		console.log(`first answer: ${first.answer.trim()}`);
		assert.equal(first.stop, 'end_turn');
		assert.deepEqual(first.handedOff, ['marker_lookup'], 'expected one tool call handed to the caller');
		assert.ok(first.answer.includes('MARKER-42'), 'expected the tool result in the first answer');
		const session = conversation.acpSessionId;
		assert.ok(session, 'expected a Kiro session after the first turn');

		// 2. The session is closed to free memory, and the follow-up reopens it in this process.
		await conversation.suspend();
		assert.equal(conversation.isOpen, false, 'expected the session to be closed');
		const second = await runTurn(client, conversation, FOLLOW_UP, haiku.id);
		console.log(`follow-up after close: ${second.answer.trim()}`);
		assert.equal(second.stop, 'end_turn');
		assert.deepEqual(second.handedOff, [], 'expected the follow-up to be answered without a tool call');
		assert.ok(second.answer.includes('MARKER-42'), 'expected the reopened session to recall the value');
		assert.equal(conversation.acpSessionId, session, 'expected the same Kiro session');

		// 3. A new kiro-cli process, with the chat state a restarted VS Code would load.
		const saved = conversation.toSaved();
		assert.ok(saved, 'expected the conversation to be saveable');
		await conversation.suspend();
		client.dispose();
		client = startClient();
		const restarted = new KiroConversation(client, bridge, saved);
		const third = await runTurn(client, restarted, FOLLOW_UP, haiku.id);
		console.log(`follow-up after restart: ${third.answer.trim()}`);
		assert.equal(third.stop, 'end_turn');
		assert.deepEqual(third.handedOff, [], 'expected the restarted follow-up to be answered without a tool call');
		assert.ok(third.answer.includes('MARKER-42'), 'expected the saved session to be reopened in the new process');
		assert.equal(restarted.acpSessionId, session, 'expected the same Kiro session after the restart');
		await restarted.suspend();

		// 4. The saved session is gone, so the turn starts a new session and sends the whole transcript.
		const savedMissing = `sess_missing_${Date.now()}`;
		const gone = new KiroConversation(client, bridge, { key: `chat-gone-${Date.now()}`, acpSessionId: savedMissing, userMessages: [], lastUsed: Date.now() });
		const fourth = await runTurn(
			client,
			gone,
			'What code word did I give you? Reply with only the word.',
			haiku.id,
			'Earlier messages in this chat:\n[user] The code word is ZEBRA-9.\n\nAnswer this message:\nWhat code word did I give you? Reply with only the word.',
		);
		console.log(`fallback answer: ${fourth.answer.trim()}`);
		assert.equal(fourth.stop, 'end_turn');
		assert.ok(fourth.answer.includes('ZEBRA-9'), 'expected the fallback to answer from the transcript');
		assert.notEqual(gone.acpSessionId, savedMissing, 'expected a new Kiro session to replace the missing one');
		await gone.suspend();
	} finally {
		await conversation.suspend();
	}
	assert.equal(turns.size, 0, 'expected no turn to be left running');
	console.log('smoke passed');
}

main()
	.catch(error => {
		console.error(error);
		process.exitCode = 1;
	})
	.finally(() => {
		for (const turn of turns.values()) {
			turn.cancel();
		}
		bridge.dispose();
		for (const client of clients) {
			client.dispose();
		}
	});
