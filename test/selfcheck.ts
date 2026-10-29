import assert from 'node:assert/strict';
import { splitLines } from '../src/framing';
import { McpBridge } from '../src/mcpBridge';
import { effortRequested, modelsFrom, toChatModelInfo, validEffort } from '../src/models';
import { transcriptOf } from '../src/transcript';

// Framing: a line split across two chunks is joined, and blank lines are dropped.
const first = splitLines('{"a":1}\n{"b":');
assert.deepEqual(first.lines, ['{"a":1}']);
assert.equal(first.rest, '{"b":');
const second = splitLines(first.rest + '2}\n\n');
assert.deepEqual(second.lines, ['{"b":2}']);
assert.equal(second.rest, '');

// Models: ids and context size come from the config option, and effort levels from each model's _meta.
const models = modelsFrom([{
	id: 'model',
	category: 'model',
	type: 'select',
	options: [
		{ value: 'auto', name: 'Auto', description: 'Chosen by task' },
		{
			value: 'claude-sonnet-5.5',
			name: 'Claude Sonnet 5.5',
			description: 'Claude Sonnet 5.5 model with 1M context window',
			_meta: { kiro: { effortLevels: ['low', 'medium', 'high', 'xhigh', 'max'], defaultEffortLevel: 'high' } },
		},
	],
}]);
const [auto, sonnet] = models;
assert.deepEqual(models.map(model => model.id), ['auto', 'claude-sonnet-5.5']);
assert.equal(auto.contextWindow, 200_000);
assert.equal(sonnet.contextWindow, 1_000_000);
assert.deepEqual(auto.effortLevels, []);

// Effort: only levels the model lists are sent, and the picker's choice is read from the request options.
assert.equal(validEffort(sonnet, 'high'), 'high');
assert.equal(validEffort(sonnet, 'none'), undefined);
assert.equal(validEffort(auto, 'low'), undefined);
assert.equal(effortRequested({ modelConfiguration: { reasoningEffort: 'low' } }), 'low');
assert.equal(effortRequested({}), undefined);

// The picker info: effort models get a configuration schema with the default; others do not.
assert.equal((toChatModelInfo(auto) as { configurationSchema?: unknown }).configurationSchema, undefined);
const schema = (toChatModelInfo(sonnet) as { configurationSchema?: any }).configurationSchema;
assert.deepEqual(schema.properties.reasoningEffort.enum, ['low', 'medium', 'high', 'xhigh', 'max']);
assert.equal(schema.properties.reasoningEffort.default, 'high');
assert.equal(schema.properties.reasoningEffort.enumItemLabels[3], 'xHigh');

// Transcript: a single message is sent as-is; earlier messages are marked as context and the latest is set apart.
assert.equal(transcriptOf([{ role: 'user', text: 'hi' }]), 'hi');
const transcript = transcriptOf([{ role: 'user', text: 'hi' }, { role: 'assistant', text: 'hello' }, { role: 'user', text: 'name?' }]);
assert.ok(transcript.includes('[assistant] hello'));
assert.ok(transcript.endsWith('<latest_user_message>\nname?\n</latest_user_message>'));

// MCP bridge: tools/list and tools/call work over HTTP, an unknown path is refused, and a released session stops answering.
const bridge = new McpBridge({
	listTools: () => [{ name: 'echo', description: 'Echo the input', inputSchema: { type: 'object' } }],
	callTool: async (sessionKey, name, input) => `${sessionKey}:${name}:${JSON.stringify(input)}`,
});

async function main(): Promise<void> {
	await bridge.start();
	const url = bridge.urlFor('chat-1');
	const post = (body: object, target = url) => fetch(target, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify(body),
	});

	const listed = await (await post({ jsonrpc: '2.0', id: 1, method: 'tools/list' })).json() as any;
	assert.equal(listed.result.tools[0].name, 'echo');

	const called = await (await post({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'echo', arguments: { x: 1 } } })).json() as any;
	assert.equal(called.result.content[0].text, 'chat-1:echo:{"x":1}');

	const unknown = await post({ jsonrpc: '2.0', id: 3, method: 'tools/list' }, url.replace(/\/mcp\/[0-9a-f]+$/, `/mcp/${'f'.repeat(32)}`));
	assert.equal(unknown.status, 404);

	bridge.release('chat-1');
	const released = await post({ jsonrpc: '2.0', id: 4, method: 'tools/list' });
	assert.equal(released.status, 404);

	bridge.dispose();
	console.log('selfcheck passed');
}

main().catch(error => {
	bridge.dispose();
	console.error(error);
	process.exit(1);
});
