import type { ExecResult } from '@ai-hero/sandcastle';
import type { OutputChunk } from '@briq-cloud/sdk';

/** What `exec` returns for a command that ran out of time, as `timeout(1)` does. */
export const TIMEOUT_EXIT_CODE = 124;

/** The last `max` characters pushed. */
class Tail {
  private text = '';
  constructor(private readonly max: number) {}
  push(chunk: string): void {
    this.text += chunk;
    if (this.text.length > this.max) this.text = this.text.slice(-this.max);
  }
  toString(): string {
    return this.text;
  }
}

/**
 * Collects the output of one command.
 *
 * With `onLine`, stdout reaches it line by line as it arrives and the result keeps the last
 * `maxTail` characters of each stream. Without it, the result holds the whole output.
 */
export function collector(onLine: ((line: string) => void) | undefined, maxTail: number) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const stdoutTail = new Tail(maxTail);
  const stderrTail = new Tail(maxTail);
  let partial = '';
  const emit = (line: string) => {
    stdoutTail.push(`${line}\n`);
    onLine?.(line);
  };
  return {
    onChunk(chunk: OutputChunk): void {
      if (!onLine) {
        (chunk.stream === 'stdout' ? stdout : stderr).push(chunk.text);
      } else if (chunk.stream === 'stderr') {
        stderrTail.push(chunk.text);
      } else {
        const lines = (partial + chunk.text).split('\n');
        partial = lines.pop() ?? '';
        for (const line of lines) emit(line);
      }
    },
    finish(exitCode: number | null, timedOut: boolean): ExecResult {
      if (partial !== '') emit(partial);
      partial = '';
      const err = onLine ? stderrTail.toString() : stderr.join('');
      return {
        stdout: onLine ? stdoutTail.toString().replace(/\n$/, '') : stdout.join(''),
        stderr: timedOut
          ? `${err}${err === '' || err.endsWith('\n') ? '' : '\n'}command timed out\n`
          : err,
        // A command ended by a signal has no exit code: report it as a failure.
        exitCode: timedOut ? TIMEOUT_EXIT_CODE : (exitCode ?? 1),
      };
    },
  };
}
