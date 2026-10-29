/** Splits buffered stdout into complete newline-delimited JSON lines. The unfinished tail is returned as `rest`. */
export function splitLines(buffer: string): { lines: string[]; rest: string } {
	const parts = buffer.split('\n');
	const rest = parts.pop() ?? '';
	return { lines: parts.filter(line => line.trim().length > 0), rest };
}
