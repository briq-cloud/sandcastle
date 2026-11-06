import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IsolatedSandboxHandle } from '@ai-hero/sandcastle';
import { BriqOperationError, type ExecInput, type NativeOptions } from '@briq-cloud/sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WORKTREE_PATH, briq } from './index.js';

// A fake `nativeSandbox`. Commands run in a real local `sh`, with the working directory the host
// has (the sandbox's own paths do not exist here). Files live in memory, except an upload under
// `/tmp/sandcastle-copyin-`, which is written to the host so that a command can unpack it.
const fake = vi.hoisted(() => ({
  options: undefined as unknown,
  created: [] as unknown[],
  destroyed: [] as string[],
  execs: [] as unknown[],
  files: new Map<string, { data: Uint8Array; mode?: number }>(),
  dirs: [] as string[],
  mkdirFails: false,
  exit: undefined as { exitCode: number | null; timedOut: boolean } | undefined,
}));

vi.mock('@briq-cloud/sdk', async (importOriginal) => {
  const real = await importOriginal<typeof import('@briq-cloud/sdk')>();
  const { writeFileSync } = await import('node:fs');
  return {
    ...real,
    nativeSandbox: (options: NativeOptions) => {
      fake.options = options;
      if (!options.apiKey) throw new real.BriqOperationError('auth', 'A Briq API key is required');
      return {
        create: async (input: unknown) => {
          fake.created.push(input);
          return { id: 'bq_test1' };
        },
        destroy: async (id: string) => {
          fake.destroyed.push(id);
        },
        exec: async (_id: string, input: ExecInput) => {
          fake.execs.push(input);
          if (fake.exit) return fake.exit;
          const cwd = existsSync(input.cwd) ? input.cwd : tmpdir();
          const child = spawn('sh', ['-c', input.command], {
            cwd,
            env: { PATH: process.env.PATH ?? '', ...input.env },
            stdio: ['pipe', 'pipe', 'pipe'],
          });
          child.stdout.on('data', (d: Buffer) =>
            input.onChunk({ stream: 'stdout', text: d.toString() }),
          );
          child.stderr.on('data', (d: Buffer) =>
            input.onChunk({ stream: 'stderr', text: d.toString() }),
          );
          // A command that exits without reading its input closes the pipe: not an error here.
          child.stdin.on('error', () => undefined);
          child.stdin.end(input.stdin ?? '');
          const exitCode = await new Promise<number | null>((resolve) =>
            child.on('close', (code) => resolve(code)),
          );
          return { exitCode, timedOut: false };
        },
        files: {
          mkdir: async (_id: string, path: string) => {
            if (fake.mkdirFails) throw new real.BriqOperationError('provider', 'mkdir failed');
            fake.dirs.push(path);
          },
          write: async (_id: string, path: string, data: Uint8Array, opts?: { mode?: number }) => {
            fake.files.set(path, {
              data,
              ...(opts?.mode === undefined ? {} : { mode: opts.mode }),
            });
            if (path.startsWith('/tmp/sandcastle-copyin-')) writeFileSync(path, data);
          },
          read: async (_id: string, path: string) => {
            const file = fake.files.get(path);
            if (!file) throw new real.BriqOperationError('file_not_found', 'No such file');
            return file.data;
          },
        },
      };
    },
  };
});

// `create` is internal to Sandcastle and absent from its declarations: it is what `run()` calls.
type Internal = {
  create(options: { env: Record<string, string> }): Promise<IsolatedSandboxHandle>;
};

const create = (
  options: Parameters<typeof briq>[0] = { apiKey: 'test-key' },
  env: Record<string, string> = {},
) => (briq(options) as unknown as Internal).create({ env });

let scratch: string;
beforeEach(async () => {
  fake.options = undefined;
  fake.created = [];
  fake.destroyed = [];
  fake.execs = [];
  fake.files.clear();
  fake.dirs = [];
  fake.mkdirFails = false;
  fake.exit = undefined;
  scratch = await mkdtemp(join(tmpdir(), 'briq-sandcastle-test-'));
});
afterEach(async () => {
  await rm(scratch, { recursive: true, force: true });
});

describe('provider', () => {
  it('is an isolated provider named briq, with the environment it was given', () => {
    const provider = briq({ apiKey: 'k', env: { A: '1' } });
    expect(provider).toMatchObject({ tag: 'isolated', name: 'briq', env: { A: '1' } });
    expect(briq().env).toEqual({});
  });

  it('refuses a command timeout the API cannot honour, before any request', () => {
    for (const commandTimeoutMs of [0, 1.5, 3_600_001]) {
      expect(() => briq({ commandTimeoutMs })).toThrow(/commandTimeoutMs/);
    }
    expect(fake.created).toEqual([]);
  });

  it('refuses a size briq does not have, before any request', () => {
    for (const size of ['nano', 'huge', '']) {
      expect(() => briq({ size: size as 'small' })).toThrow(/size/);
    }
    expect(() => briq({ size: 'xlarge' })).not.toThrow();
    expect(fake.created).toEqual([]);
  });
});

describe('create', () => {
  it('starts one briq in its own stack, marked as ours, with no environment, at the default size', async () => {
    const handle = await create(
      { apiKey: 'k', stack: 'agents', labels: { team: 'ci' } },
      { SECRET: 'x' },
    );
    expect(fake.options).toMatchObject({ apiKey: 'k', stack: 'agents', marker: 'briq/sandcastle' });
    expect(fake.options).not.toHaveProperty('image');
    expect(fake.created).toEqual([{ labels: { team: 'ci' } }]);
    expect(handle.sandboxId).toBe('bq_test1');
    expect(handle.worktreePath).toBe(WORKTREE_PATH);
    expect(fake.dirs).toEqual([WORKTREE_PATH]);
  });

  it('creates the briq at the size asked for', async () => {
    await create({ apiKey: 'k', size: 'large' });
    expect(fake.created).toEqual([{ labels: {}, size: 'large' }]);
  });

  it('reads the key and the API origin from the environment', async () => {
    vi.stubEnv('BRIQ_API_KEY', 'from-env');
    vi.stubEnv('BRIQ_API_URL', 'http://localhost:3001');
    try {
      await create({});
      expect(fake.options).toMatchObject({ apiKey: 'from-env', baseUrl: 'http://localhost:3001' });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('passes a custom image through', async () => {
    await create({ apiKey: 'k', image: 'ghcr.io/me/agent:1' });
    expect(fake.options).toMatchObject({ image: 'ghcr.io/me/agent:1' });
  });

  it('fails with the SDK error when there is no key', async () => {
    vi.stubEnv('BRIQ_API_KEY', '');
    try {
      await expect(create({})).rejects.toMatchObject({ code: 'auth' });
    } finally {
      vi.unstubAllEnvs();
    }
    expect(fake.created).toEqual([]);
  });

  it('destroys the briq when the worktree cannot be made', async () => {
    fake.mkdirFails = true;
    await expect(create()).rejects.toBeInstanceOf(BriqOperationError);
    expect(fake.destroyed).toEqual(['bq_test1']);
  });
});

describe('exec', () => {
  it('runs in the worktree and sends the environment with the command, not the briq', async () => {
    const handle = await create({ apiKey: 'k' }, { ANTHROPIC_API_KEY: 'sk-test' });
    const result = await handle.exec('echo "$ANTHROPIC_API_KEY"');
    expect(result).toEqual({ stdout: 'sk-test\n', stderr: '', exitCode: 0 });
    expect(fake.execs[0]).toMatchObject({
      command: 'echo "$ANTHROPIC_API_KEY"',
      cwd: WORKTREE_PATH,
      env: { ANTHROPIC_API_KEY: 'sk-test' },
      timeoutMs: 3_600_000,
    });
    expect(JSON.stringify(fake.created)).not.toContain('sk-test');
  });

  it('streams lines, joins a line split across chunks, and keeps the last characters', async () => {
    const handle = await create({ apiKey: 'k', maxOutputTailChars: 8 });
    const lines: string[] = [];
    const result = await handle.exec(
      'printf "one\\ntwo\\nthr"; printf "ee\\nfour" ; echo oops >&2',
      {
        onLine: (line: string) => lines.push(line),
      },
    );
    expect(lines).toEqual(['one', 'two', 'three', 'four']);
    expect(result.stdout).toBe('ee\nfour');
    expect(result.stderr).toBe('oops\n');
  });

  it('returns a failing exit code and the stderr', async () => {
    const handle = await create();
    expect(await handle.exec('echo bad >&2; exit 3')).toEqual({
      stdout: '',
      stderr: 'bad\n',
      exitCode: 3,
    });
  });

  it('pipes stdin and honours cwd', async () => {
    const handle = await create();
    const result = await handle.exec('cat; pwd', { stdin: 'hello\n', cwd: scratch });
    expect(result.stdout).toContain('hello\n');
    expect(fake.execs[0]).toMatchObject({ cwd: scratch, stdin: 'hello\n' });
  });

  it('reports a command ended by a signal, and one that timed out, as failures', async () => {
    const handle = await create({ apiKey: 'k', commandTimeoutMs: 5000 });
    fake.exit = { exitCode: null, timedOut: false };
    expect((await handle.exec('sleep 100')).exitCode).toBe(1);
    fake.exit = { exitCode: null, timedOut: true };
    const timedOut = await handle.exec('sleep 100');
    expect(timedOut.exitCode).toBe(124);
    expect(timedOut.stderr).toContain('timed out');
    expect(fake.execs[1]).toMatchObject({ timeoutMs: 5000 });
  });
});

describe('files', () => {
  it('copies a file in with its mode, making the directory first', async () => {
    const handle = await create();
    const file = join(scratch, 'repo.bundle');
    await writeFile(file, 'bundle bytes');
    await chmod(file, 0o640);
    await handle.copyIn(file, '/tmp/sc-x/repo.bundle');
    expect(fake.dirs).toContain('/tmp/sc-x');
    const stored = fake.files.get('/tmp/sc-x/repo.bundle');
    expect(Buffer.from(stored?.data ?? []).toString()).toBe('bundle bytes');
    expect(stored?.mode).toBe(0o640);
  });

  it('copies a directory in as a tarball and unpacks it, leaving no archive', async () => {
    const handle = await create();
    const source = join(scratch, 'src');
    await mkdir(join(source, 'sub'), { recursive: true });
    await writeFile(join(source, 'sub', 'a.txt'), 'a');
    const target = join(scratch, "it's here");
    await handle.copyIn(source, target);
    expect(await readFile(join(target, 'sub', 'a.txt'), 'utf8')).toBe('a');
    const [archive] = [...fake.files.keys()];
    expect(archive).toMatch(/^\/tmp\/sandcastle-copyin-.*\.tar\.gz$/);
    expect(existsSync(archive as string)).toBe(false);
  });

  it('fails a directory copy when unpacking fails, and still removes the archive', async () => {
    const handle = await create();
    const source = join(scratch, 'src');
    await mkdir(source);
    const blocker = join(scratch, 'file');
    await writeFile(blocker, '');
    await expect(handle.copyIn(source, join(blocker, 'inside'))).rejects.toThrow(
      /could not unpack/,
    );
    const [archive] = [...fake.files.keys()];
    expect(existsSync(archive as string)).toBe(false);
  });

  it('copies a file out, creating the host directories', async () => {
    const handle = await create();
    fake.files.set('/tmp/out.patch', { data: new TextEncoder().encode('diff') });
    const target = join(scratch, 'a', 'b', 'out.patch');
    await handle.copyFileOut('/tmp/out.patch', target);
    expect(await readFile(target, 'utf8')).toBe('diff');
    expect((await stat(target)).isFile()).toBe(true);
  });

  it('names a missing file as the SDK error', async () => {
    const handle = await create();
    await expect(handle.copyFileOut('/nope', join(scratch, 'x'))).rejects.toMatchObject({
      code: 'file_not_found',
    });
  });
});

describe('close', () => {
  it('destroys the briq once, however often it is called', async () => {
    const handle = await create();
    await handle.close();
    await handle.close();
    expect(fake.destroyed).toEqual(['bq_test1']);
  });
});
