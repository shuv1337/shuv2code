import { describe, expect, it } from "vite-plus/test";

import {
  VP_CHECK_REPLAY_CHUNK_BYTES,
  outputShowsVpStdoutPanic,
  resolveVpCheckExitStatus,
  runSpoolledVpCheck,
  writeAllRetryingEagain,
} from "./run-vp-check.ts";

const panicLine = "Vite+ panicked. This is a bug in Vite+, not your code.\n";
const eagainLine = "failed printing to stdout: Resource temporarily unavailable (os error 11)\n";

describe("resolveVpCheckExitStatus", () => {
  it("keeps a clean success", () => {
    expect(resolveVpCheckExitStatus(0, "pass: All files are correctly formatted\n")).toBe(0);
  });

  it("keeps a real lint failure", () => {
    expect(resolveVpCheckExitStatus(2, "error: lint failed\n")).toBe(2);
  });

  it("fails a stdout panic that exited 0", () => {
    expect(outputShowsVpStdoutPanic(panicLine)).toBe(true);
    expect(resolveVpCheckExitStatus(0, panicLine)).toBe(1);
    expect(resolveVpCheckExitStatus(0, eagainLine)).toBe(1);
  });

  it("keeps a nonzero panic status", () => {
    expect(resolveVpCheckExitStatus(129, panicLine)).toBe(129);
  });

  it("fails when the process reports no status", () => {
    expect(resolveVpCheckExitStatus(null, "")).toBe(1);
    expect(resolveVpCheckExitStatus(null, panicLine)).toBe(1);
  });
});

describe("writeAllRetryingEagain", () => {
  it("bounds each write", () => {
    const lengths: Array<number> = [];
    const data = Buffer.alloc(VP_CHECK_REPLAY_CHUNK_BYTES + 1024, 1);
    const wroteAll = writeAllRetryingEagain(
      data,
      (_buffer, _offset, length) => {
        lengths.push(length);
        return length;
      },
      () => {},
    );

    expect(wroteAll).toBe(true);
    expect(lengths).toEqual([VP_CHECK_REPLAY_CHUNK_BYTES, 1024]);
  });

  it("retries EAGAIN and then finishes", () => {
    let calls = 0;
    const data = Buffer.from("abcdef");
    const wroteAll = writeAllRetryingEagain(
      data,
      () => {
        calls += 1;
        if (calls < 3) {
          throw Object.assign(new Error("again"), { code: "EAGAIN" });
        }
        return data.length;
      },
      () => {},
      5,
    );

    expect(wroteAll).toBe(true);
    expect(calls).toBe(3);
  });

  it("stops after consecutive EAGAIN failures", () => {
    let calls = 0;
    const wroteAll = writeAllRetryingEagain(
      Buffer.from("abcdef"),
      () => {
        calls += 1;
        throw Object.assign(new Error("again"), { code: "EWOULDBLOCK" });
      },
      () => {},
      2,
    );

    expect(wroteAll).toBe(false);
    expect(calls).toBe(2);
  });

  it("stops on a non-retryable write error", () => {
    const wroteAll = writeAllRetryingEagain(
      Buffer.from("abcdef"),
      () => {
        throw Object.assign(new Error("closed"), { code: "EPIPE" });
      },
      () => {},
    );

    expect(wroteAll).toBe(false);
  });
});

describe("runSpoolledVpCheck", () => {
  it("spools stdout and stderr and keeps a clean exit status", () => {
    const replayed: Array<Buffer> = [];
    const result = runSpoolledVpCheck({
      command: process.execPath,
      args: ["-e", "process.stdout.write('out\\n'); process.stderr.write('err\\n')"],
      replay: (data) => replayed.push(Buffer.from(data)),
    });

    expect(result.status).toBe(0);
    expect(result.output).toContain("out\n");
    expect(result.output).toContain("err\n");
    expect(Buffer.concat(replayed).toString("utf8")).toBe(result.output);
  });

  it("turns a stdout panic with exit 0 into failure", () => {
    const replayed: Array<Buffer> = [];
    const result = runSpoolledVpCheck({
      command: process.execPath,
      args: ["-e", `process.stdout.write(${JSON.stringify(panicLine)})`],
      replay: (data) => replayed.push(Buffer.from(data)),
    });

    expect(result.status).toBe(1);
    expect(result.output).toContain("Vite+ panicked");
    expect(Buffer.concat(replayed).toString("utf8")).toContain("exiting 1");
  });

  it("preserves a real nonzero status", () => {
    const result = runSpoolledVpCheck({
      command: process.execPath,
      args: ["-e", "process.stderr.write('lint failed\\n'); process.exit(2)"],
      replay: () => {},
    });

    expect(result.status).toBe(2);
    expect(result.output).toContain("lint failed");
  });

  it("fails when the command cannot start", () => {
    const replayed: Array<Buffer> = [];
    const result = runSpoolledVpCheck({
      command: "vp-check-missing-binary-xyz",
      args: [],
      replay: (data) => replayed.push(Buffer.from(data)),
    });

    expect(result.status).toBe(1);
    expect(Buffer.concat(replayed).toString("utf8")).toMatch(/ENOENT|spawn/i);
  });
});
