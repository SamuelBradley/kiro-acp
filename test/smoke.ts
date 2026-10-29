import assert from 'node:assert/strict';
import * as os from 'node:os';
import { AcpClient } from '../src/acpClient';
import { McpBridge } from '../src/mcpBridge';
import { modelsFrom } from '../src/models';

// End-to-end check against the real kiro-cli: model discovery with effort levels, an effort change,
// and a streamed turn in which Kiro calls a tool through the loopback MCP bridge.
// Uses your kiro-cli login and a small amount of credits.

const verbose = process.env.KIRO_SMOKE_VERBOSE === '1';
let toolCalls = 0;

const bridge = new McpBridge({
	listTools: () => [{ name: 'marker_lookup', description: 'Returns the secret marker value.', inputSchema: { type: 'object', properties: {} } }],
	callTool: async () => {
		toolCalls++;
		return 'MARKER-42';
	},
});

const acp = new AcpClient({
	cwd: os.homedir(),
	log: line => verbose && console.error(`[kiro] ${line.slice(0, 300)}`),
	// Accept the first option Kiro offers. The smoke test only runs the tool it was asked to run.
	onPermission: async request => request.options[0]?.optionId,
});

async function main(): Promise<void> {
	const models = modelsFrom(await acp.discoverConfig());
	console.log(`models: ${models.map(model => model.id).join(', ')}`);
	const haiku = models.find(model => model.id === 'claude-haiku-5.5');
	assert.ok(haiku, 'expected claude-haiku-5.5 in the model list');
	assert.ok(haiku.effortLevels.includes('low'), 'expected claude-haiku-5.5 to list effort levels');

	await bridge.start();
	const { sessionId } = await acp.newSession(bridge.urlFor('smoke'));
	await acp.setOption(sessionId, 'model', haiku.id);

	const after = await acp.setOption(sessionId, 'effortLevel', 'low');
	const effort = after.find(option => option.id === 'effortLevel');
	console.log(`effortLevel: ${effort?.currentValue}`);
	assert.equal(effort?.currentValue, 'low', 'expected Kiro to accept effort low');

	let answer = '';
	let sawToolCall = false;
	const controller = new AbortController();
	const stop = await acp.prompt(sessionId, 'Call the marker_lookup tool with no arguments, then reply with only the value it returned.', update => {
		if (update?.sessionUpdate === 'agent_message_chunk' && update.content?.type === 'text') {
			answer += update.content.text;
		}
		if (update?.sessionUpdate === 'tool_call') {
			sawToolCall = true;
		}
	}, controller.signal);

	console.log(`stopReason: ${stop}`);
	console.log(`answer: ${answer.trim()}`);
	assert.equal(stop, 'end_turn');
	assert.equal(toolCalls, 1, 'expected the bridge to run marker_lookup once');
	assert.ok(answer.includes('MARKER-42'), 'expected the tool result in the answer');
	assert.ok(sawToolCall, 'expected a tool_call update');

	await acp.closeSession(sessionId).catch(() => undefined);
	console.log('smoke passed');
}

main()
	.catch(error => {
		console.error(error);
		process.exitCode = 1;
	})
	.finally(() => {
		bridge.dispose();
		acp.dispose();
	});
