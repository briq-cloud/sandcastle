import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, posix } from 'node:path';
import type { ExecResult } from '@ai-hero/sandcastle';
import type { NativeFiles } from '@briq-cloud/sdk';

/** A string as one shell word. */
export const quote = (s: string): string => `'${s.replaceAll("'", `'\\''`)}'`;

/** Pack `dir` into a gzipped tarball at `archive` on the host. */
async function tarDirectory(archive: string, dir: string): Promise<void> {
  const child = spawn('tar', ['-czf', archive, '-C', dir, '.'], {
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  await once(child, 'close');
  if (child.exitCode !== 0) throw new Error(`tar exited with ${child.exitCode}: ${stderr.trim()}`);
}

export interface Transfer {
  files: NativeFiles;
  id: string;
  run: (command: string) => Promise<ExecResult>;
}

/** Copy a host file, or a host directory as one tarball, into the sandbox. */
export async function copyIn(
  { files, id, run }: Transfer,
  hostPath: string,
  sandboxPath: string,
): Promise<void> {
  const info = await stat(hostPath);
  if (!info.isDirectory()) {
    await files.mkdir(id, posix.dirname(sandboxPath));
    // Keep the host's permission bits, as `cp` does.
    await files.write(id, sandboxPath, await readFile(hostPath), { mode: info.mode & 0o7777 });
    return;
  }
  const name = `sandcastle-copyin-${randomUUID()}.tar.gz`;
  const local = join(tmpdir(), name);
  const remote = `/tmp/${name}`;
  try {
    await tarDirectory(local, hostPath);
    await files.write(id, remote, await readFile(local));
    // Remove the archive even when unpacking fails, and keep tar's exit code.
    const result = await run(
      `mkdir -p ${quote(sandboxPath)} && tar -xzf ${quote(remote)} -C ${quote(sandboxPath)}; s=$?; rm -f ${quote(remote)}; exit $s`,
    );
    if (result.exitCode !== 0)
      throw new Error(`could not unpack ${hostPath} into ${sandboxPath}: ${result.stderr.trim()}`);
  } finally {
    await rm(local, { force: true });
  }
}

/** Copy one file out of the sandbox, creating the host's parent directories. */
export async function copyFileOut(
  { files, id }: Transfer,
  sandboxPath: string,
  hostPath: string,
): Promise<void> {
  const content = await files.read(id, sandboxPath);
  await mkdir(dirname(hostPath), { recursive: true });
  await writeFile(hostPath, content);
}
