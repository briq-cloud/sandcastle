import {
  type IsolatedSandboxHandle,
  type IsolatedSandboxProvider,
  createIsolatedSandboxProvider,
} from '@ai-hero/sandcastle';
import { type NativeOptions, type SandboxSize, fail, nativeSandbox } from '@briq-cloud/sdk';
import { collector } from './exec.js';
import { copyFileOut, copyIn } from './files.js';

export interface BriqOptions {
  /** A briq API key. Default: the `BRIQ_API_KEY` environment variable. */
  apiKey?: string;
  /** The API's origin. Default: `BRIQ_API_URL`, else `https://api.briq.cloud`. */
  baseUrl?: string;
  /**
   * The image of the sandbox. It needs `sh`, `python3`, `git` and `tar`, plus the agent's CLI.
   * Default: briq's sandbox image, which has all of them except the CLI.
   */
  image?: string;
  /** The size of each sandbox: `small`, `medium`, `large` or `xlarge`. Default: `small`. */
  size?: SandboxSize;
  /** Environment variables for every command, merged with the environment Sandcastle passes. */
  env?: Record<string, string>;
  /** The briq stack that holds the sandboxes. Default: `sandcastle`. */
  stack?: string;
  /** Labels to set on each sandbox. */
  labels?: Record<string, string>;
  /** The longest one command may run, in milliseconds, up to one hour. Default: one hour. */
  commandTimeoutMs?: number;
  /** Characters of each stream kept in the result of a command that streams. Default: 64 KiB. */
  maxOutputTailChars?: number;
  /** Replaces `fetch`, for tests. */
  fetch?: typeof fetch;
}

const SIZES: readonly string[] = ['small', 'medium', 'large', 'xlarge'];
const MAX_COMMAND_MS = 3_600_000;
const DEFAULT_TAIL_CHARS = 64 * 1024;
/** Where the repo lives in the sandbox. Sandcastle clones into a sibling and moves it here. */
export const WORKTREE_PATH = '/workspace/repo';

/**
 * A Sandcastle sandbox provider that runs each agent in its own briq.
 *
 * ```ts
 * import { run, claudeCode } from '@ai-hero/sandcastle';
 * import { briq } from '@briq-cloud/sandcastle';
 *
 * await run({ agent: claudeCode('claude-opus-4-8'), sandbox: briq(), promptFile: '.sandcastle/prompt.md' });
 * ```
 *
 * `create` starts a briq and `close` destroys it. The environment Sandcastle passes (the agent's
 * login, for example) goes to each command and is never stored on the briq.
 */
export function briq(options: BriqOptions = {}): IsolatedSandboxProvider {
  const {
    env,
    commandTimeoutMs = MAX_COMMAND_MS,
    maxOutputTailChars = DEFAULT_TAIL_CHARS,
  } = options;
  if (
    !Number.isInteger(commandTimeoutMs) ||
    commandTimeoutMs < 1 ||
    commandTimeoutMs > MAX_COMMAND_MS
  )
    throw fail(
      'invalid_argument',
      'commandTimeoutMs is a whole number of milliseconds, 1 to 3600000',
    );

  if (options.size !== undefined && !SIZES.includes(options.size))
    throw fail('unsupported', 'size is one of small, medium, large, xlarge');

  return createIsolatedSandboxProvider({
    name: 'briq',
    ...(env ? { env } : {}),
    create: async (createOptions): Promise<IsolatedSandboxHandle> => {
      const apiKey = options.apiKey || process.env.BRIQ_API_KEY || '';
      const baseUrl = options.baseUrl || process.env.BRIQ_API_URL || undefined;
      const sdkOptions: NativeOptions = {
        apiKey,
        marker: 'briq/sandcastle',
        stack: options.stack ?? 'sandcastle',
        ...(baseUrl ? { baseUrl } : {}),
        ...(options.image ? { image: options.image } : {}),
        ...(options.fetch ? { fetch: options.fetch } : {}),
      };
      const sandbox = nativeSandbox(sdkOptions);
      // No `env` here: briq would store it. The commands carry it instead.
      const { id } = await sandbox.create({
        labels: { ...options.labels },
        ...(options.size ? { size: options.size } : {}),
      });

      const run = (
        command: string,
        opts?: { onLine?: (line: string) => void; cwd?: string; stdin?: string },
      ) => {
        const out = collector(opts?.onLine, maxOutputTailChars);
        return sandbox
          .exec(id, {
            command,
            cwd: opts?.cwd ?? WORKTREE_PATH,
            env: createOptions.env,
            timeoutMs: commandTimeoutMs,
            ...(opts?.stdin === undefined ? {} : { stdin: opts.stdin }),
            onChunk: out.onChunk,
          })
          .then((result) => out.finish(result.exitCode, result.timedOut));
      };

      try {
        await sandbox.files.mkdir(id, WORKTREE_PATH);
      } catch (error) {
        // No handle exists yet, so nothing else would destroy the briq.
        await sandbox.destroy(id).catch(() => undefined);
        throw error;
      }

      const transfer = {
        files: sandbox.files,
        id,
        run: (command: string) => run(command, { cwd: '/' }),
      };
      let closed = false;
      return {
        worktreePath: WORKTREE_PATH,
        sandboxId: id,
        // The sandbox runs as root, so `sudo` changes nothing.
        exec: (command, opts) => run(command, opts),
        copyIn: (hostPath, sandboxPath) => copyIn(transfer, hostPath, sandboxPath),
        copyFileOut: (sandboxPath, hostPath) => copyFileOut(transfer, sandboxPath, hostPath),
        close: async () => {
          if (closed) return;
          closed = true;
          await sandbox.destroy(id);
        },
      };
    },
  });
}
