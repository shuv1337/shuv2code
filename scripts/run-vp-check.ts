// @effect-diagnostics nodeBuiltinImport:off - CI guard spools vp check onto a regular file so a non-blocking stdout cannot panic the printer.
// pc_7b01f27e78e2: Vite+ can panic on stdout EAGAIN (os error 11) and still exit 0.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

export const VP_STDOUT_PANIC_MARKERS = [
  "Vite+ panicked. This is a bug in Vite+",
  "failed printing to stdout: Resource temporarily unavailable (os error 11)",
] as const;

export const VP_CHECK_REPLAY_CHUNK_BYTES = 16 * 1024;

const DEFAULT_EAGAIN_ATTEMPTS = 50;
const EAGAIN_WAIT_MS = 20;

export type ByteWriter = (buffer: Buffer, offset: number, length: number) => number;

export function outputShowsVpStdoutPanic(output: string): boolean {
  return VP_STDOUT_PANIC_MARKERS.some((marker) => output.includes(marker));
}

/**
 * A captured Vite+ stdout panic with status 0 (or no status) did not finish
 * cleanly. Any other status is the process status, including a nonzero panic.
 */
export function resolveVpCheckExitStatus(status: number | null, output: string): number {
  if (outputShowsVpStdoutPanic(output) && (status === null || status === 0)) {
    return 1;
  }
  if (status === null) {
    return 1;
  }
  return status;
}

function isEagain(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return false;
  }
  return error.code === "EAGAIN" || error.code === "EWOULDBLOCK" || error.code === "EINTR";
}

function waitForWritable(milliseconds: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

/** Write `data` in bounded chunks, retrying EAGAIN. Returns false when replay must stop. */
export function writeAllRetryingEagain(
  data: Buffer,
  write: ByteWriter,
  wait: (milliseconds: number) => void = waitForWritable,
  maxConsecutiveFailures = DEFAULT_EAGAIN_ATTEMPTS,
): boolean {
  let offset = 0;
  let consecutiveFailures = 0;
  while (offset < data.length) {
    const length = Math.min(VP_CHECK_REPLAY_CHUNK_BYTES, data.length - offset);
    try {
      const wrote = write(data, offset, length);
      if (wrote > 0) {
        offset += wrote;
        consecutiveFailures = 0;
        continue;
      }
      consecutiveFailures += 1;
    } catch (error) {
      if (!isEagain(error)) {
        return false;
      }
      consecutiveFailures += 1;
    }
    if (consecutiveFailures >= maxConsecutiveFailures) {
      return false;
    }
    wait(EAGAIN_WAIT_MS);
  }
  return true;
}

function defaultReplay(data: Buffer): void {
  writeAllRetryingEagain(data, (buffer, offset, length) =>
    NodeFS.writeSync(1, buffer, offset, length),
  );
}

export function runSpoolledVpCheck(options?: {
  readonly command?: string;
  readonly args?: readonly string[];
  readonly replay?: (data: Buffer) => void;
}): { readonly status: number; readonly output: string } {
  const command = options?.command ?? "vp";
  const args = options?.args ?? ["check"];
  const replay = options?.replay ?? defaultReplay;
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "vp-check-"));
  try {
    const logPath = NodePath.join(directory, "vp-check.log");
    const fd = NodeFS.openSync(logPath, "w");
    let spawned: NodeChildProcess.SpawnSyncReturns<Buffer>;
    try {
      spawned = NodeChildProcess.spawnSync(command, [...args], {
        stdio: ["ignore", fd, fd],
      });
    } finally {
      NodeFS.closeSync(fd);
    }

    const output = NodeFS.readFileSync(logPath);
    replay(output);
    if (spawned.error) {
      replay(Buffer.from(`${spawned.error.message}\n`));
    }
    if (spawned.signal) {
      replay(Buffer.from(`vp check ended by signal ${spawned.signal}\n`));
    }

    const outputText = output.toString("utf8");
    const status = resolveVpCheckExitStatus(spawned.status, outputText);
    if (outputShowsVpStdoutPanic(outputText) && (spawned.status === null || spawned.status === 0)) {
      replay(
        Buffer.from(
          "vp check panicked while printing diagnostics and reported success; exiting 1.\n",
        ),
      );
    }
    return { status, output: outputText };
  } finally {
    NodeFS.rmSync(directory, { recursive: true, force: true });
  }
}

export function main(argv: readonly string[]): number {
  return runSpoolledVpCheck({ args: ["check", ...argv] }).status;
}

if (import.meta.main) {
  process.exitCode = main(process.argv.slice(2));
}
