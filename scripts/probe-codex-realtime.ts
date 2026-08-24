// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalDate:off - raw process and wall-clock behavior are the subject of this protocol probe.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeReadline from "node:readline";
import * as NodeUtil from "node:util";

const execFileAsync = NodeUtil.promisify(NodeChildProcess.execFile);

type JsonObject = Record<string, unknown>;

export interface RealtimeProbeCase {
  readonly name: string;
  readonly startParams: JsonObject;
}

export interface ProbeOptions {
  readonly codexBinary: string;
  readonly cwd: string;
  readonly threadModel: string;
  readonly realtimeModel: string;
  readonly offerSdp: string | undefined;
  readonly timeoutMs: number;
  readonly caseNames: ReadonlySet<string> | undefined;
  readonly json: boolean;
}

interface RpcMessage extends JsonObject {
  readonly id?: number | string;
  readonly method?: string;
  readonly params?: unknown;
  readonly result?: unknown;
  readonly error?: unknown;
}

interface PendingRequest {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly timer: NodeJS.Timeout;
}

export interface RealtimeProbeResult {
  readonly caseName: string;
  readonly outcome: "started" | "realtime-error" | "request-error" | "timeout" | "process-error";
  readonly durationMs: number;
  readonly threadId: string | null;
  readonly realtimeSessionId: string;
  readonly realtimeStartParams: JsonObject;
  readonly accountAuth?: unknown;
  readonly realtimeStartResponse?: unknown;
  readonly lifecycleNotification?: RpcMessage;
  readonly requestError?: string;
  readonly stderr: string;
  readonly messages: ReadonlyArray<RpcMessage>;
}

class RpcError extends Error {
  readonly payload: unknown;

  constructor(message: string, payload: unknown) {
    super(message);
    this.payload = payload;
  }
}

class CodexAppServerClient {
  readonly child: NodeChildProcess.ChildProcessWithoutNullStreams;
  readonly messages: Array<RpcMessage> = [];
  readonly stderr: Array<string> = [];
  readonly pending = new Map<number, PendingRequest>();
  readonly notificationWaiters = new Set<() => void>();
  readonly timeoutMs: number;
  nextId = 1;

  constructor(codexBinary: string, cwd: string, timeoutMs: number) {
    this.timeoutMs = timeoutMs;
    this.child = NodeChildProcess.spawn(
      codexBinary,
      ["app-server", "--enable", "realtime_conversation"],
      {
        cwd,
        env: process.env,
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (chunk: string) => this.stderr.push(chunk));
    this.child.once("error", (error) => this.rejectAll(error));
    this.child.once("exit", (code, signal) => {
      this.rejectAll(new Error(`codex app-server exited (code=${code}, signal=${signal})`));
    });

    const lines = NodeReadline.createInterface({ input: this.child.stdout });
    lines.on("line", (line) => this.handleLine(line));
  }

  private handleLine(line: string): void {
    let message: RpcMessage;
    try {
      message = JSON.parse(line) as RpcMessage;
    } catch {
      this.stderr.push(`Non-JSON stdout: ${line}\n`);
      return;
    }
    this.messages.push(message);

    if (message.id !== undefined && message.method !== undefined) {
      this.write({
        id: message.id,
        error: { code: -32601, message: `Probe does not implement ${message.method}` },
      });
      return;
    }

    if (typeof message.id === "number") {
      const pending = this.pending.get(message.id);
      if (pending !== undefined) {
        clearTimeout(pending.timer);
        this.pending.delete(message.id);
        if (message.error !== undefined) {
          pending.reject(new RpcError(`RPC request ${message.id} failed`, message.error));
        } else {
          pending.resolve(message.result);
        }
      }
    }
    for (const wake of this.notificationWaiters) wake();
  }

  private write(message: RpcMessage): void {
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private rejectAll(error: Error): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.pending.delete(id);
    }
    for (const wake of this.notificationWaiters) wake();
  }

  request(method: string, params: unknown): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out after ${this.timeoutMs}ms`));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.write({ id, method, params });
    });
  }

  notify(method: string): void {
    this.write({ method });
  }

  async waitForNotification(
    fromIndex: number,
    predicate: (message: RpcMessage) => boolean,
  ): Promise<RpcMessage | undefined> {
    const deadline = Date.now() + this.timeoutMs;
    while (Date.now() < deadline) {
      const found = this.messages.slice(fromIndex).find(predicate);
      if (found !== undefined) return found;
      await new Promise<void>((resolve) => {
        const remaining = Math.max(1, deadline - Date.now());
        const timer = setTimeout(() => {
          this.notificationWaiters.delete(wake);
          resolve();
        }, remaining);
        const wake = () => {
          clearTimeout(timer);
          this.notificationWaiters.delete(wake);
          resolve();
        };
        this.notificationWaiters.add(wake);
      });
    }
    return undefined;
  }

  async close(): Promise<void> {
    if (this.child.exitCode !== null || this.child.signalCode !== null) return;
    this.child.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.child.kill("SIGKILL");
        resolve();
      }, 1_000);
      this.child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
}

const productionFields = {
  version: "v3",
  outputModality: "audio",
  clientManagedHandoffs: true,
  includeStartupContext: false,
  prompt: "Act as the realtime voice interface for an existing coding thread.",
  initialItems: [
    {
      role: "developer",
      text: "The durable coding thread and realtime voice transport are separate sessions.",
    },
  ],
  transport: { type: "websocket" },
} as const;

export function buildRealtimeProbeCases(
  realtimeModel: string,
  offerSdp?: string,
): ReadonlyArray<RealtimeProbeCase> {
  const transport = offerSdp
    ? ({ type: "webrtc", sdp: offerSdp } as const)
    : ({ type: "websocket" } as const);
  const minimal = {
    version: "v3",
    outputModality: "audio",
    clientManagedHandoffs: true,
    transport,
  } as const;
  return [
    {
      name: "production-v3",
      startParams: { ...productionFields, transport },
    },
    {
      name: "production-v3-explicit-model",
      startParams: { ...productionFields, transport, model: realtimeModel },
    },
    { name: "minimal-v3", startParams: minimal },
    {
      name: "minimal-v3-explicit-model",
      startParams: { ...minimal, model: realtimeModel },
    },
    {
      name: "minimal-no-version",
      startParams: {
        outputModality: "audio",
        clientManagedHandoffs: true,
        transport,
      },
    },
    { name: "minimal-v2", startParams: { ...minimal, version: "v2" } },
    { name: "minimal-v1", startParams: { ...minimal, version: "v1" } },
  ];
}

function errorText(error: unknown): string {
  if (error instanceof RpcError) return `${error.message}: ${JSON.stringify(error.payload)}`;
  return error instanceof Error ? (error.stack ?? error.message) : String(error);
}

function notificationThreadId(message: RpcMessage): string | undefined {
  const params = message.params;
  if (typeof params !== "object" || params === null) return undefined;
  const threadId = (params as JsonObject).threadId;
  return typeof threadId === "string" ? threadId : undefined;
}

function summarizeAccountAuth(response: unknown): unknown {
  if (typeof response !== "object" || response === null) return response;
  const account = (response as JsonObject).account;
  if (typeof account !== "object" || account === null) return { account: null };
  const fields = account as JsonObject;
  return {
    account: {
      ...(typeof fields.type === "string" ? { type: fields.type } : {}),
      ...(typeof fields.planType === "string" ? { planType: fields.planType } : {}),
    },
  };
}

function redactAccountEmail(message: RpcMessage): RpcMessage {
  if (typeof message.result !== "object" || message.result === null) return message;
  const result = message.result as JsonObject;
  const account = result.account;
  if (typeof account !== "object" || account === null || !("email" in account)) return message;
  return {
    ...message,
    result: {
      ...result,
      account: { ...(account as JsonObject), email: "[redacted]" },
    },
  };
}

async function runProbeCase(
  probeCase: RealtimeProbeCase,
  options: ProbeOptions,
): Promise<RealtimeProbeResult> {
  const startedAt = Date.now();
  const realtimeSessionId = NodeCrypto.randomUUID();
  const client = new CodexAppServerClient(options.codexBinary, options.cwd, options.timeoutMs);
  let threadId: string | null = null;
  let accountReadResponse: unknown;
  let realtimeStartResponse: unknown;
  let lifecycleNotification: RpcMessage | undefined;
  let requestError: string | undefined;
  let outcome: RealtimeProbeResult["outcome"] = "process-error";
  const realtimeStartParams: JsonObject = {
    ...probeCase.startParams,
    threadId: "pending",
    realtimeSessionId,
  };

  try {
    await client.request("initialize", {
      clientInfo: {
        name: "shuv2code_realtime_probe",
        title: "shuv2code Codex Realtime Probe",
        version: "1.0.0",
      },
      capabilities: { experimentalApi: true },
    });
    client.notify("initialized");
    accountReadResponse = await client.request("account/read", {});
    const threadStart = (await client.request("thread/start", {
      cwd: options.cwd,
      approvalPolicy: "never",
      sandbox: "danger-full-access",
      approvalsReviewer: "user",
      ephemeral: true,
      model: options.threadModel,
      threadSource: "shuv2code_voice_transport_v1",
    })) as { readonly thread?: { readonly id?: unknown } };
    const openedThreadId = threadStart.thread?.id;
    if (typeof openedThreadId !== "string" || openedThreadId.length === 0) {
      throw new Error(`thread/start returned no thread id: ${JSON.stringify(threadStart)}`);
    }
    threadId = openedThreadId;
    realtimeStartParams.threadId = threadId;
    const notificationIndex = client.messages.length;
    try {
      realtimeStartResponse = await client.request("thread/realtime/start", realtimeStartParams);
    } catch (error) {
      requestError = errorText(error);
      outcome = "request-error";
    }
    if (outcome !== "request-error") {
      lifecycleNotification = await client.waitForNotification(
        notificationIndex,
        (message) =>
          notificationThreadId(message) === threadId &&
          (message.method === "thread/realtime/started" ||
            message.method === "thread/realtime/error" ||
            message.method === "thread/realtime/closed"),
      );
      if (lifecycleNotification?.method === "thread/realtime/started") {
        outcome = "started";
        await client.request("thread/realtime/stop", { threadId }).catch(() => undefined);
      } else if (lifecycleNotification?.method === "thread/realtime/error") {
        outcome = "realtime-error";
      } else {
        outcome = "timeout";
      }
    }
  } catch (error) {
    requestError = errorText(error);
    outcome = "process-error";
  } finally {
    await client.close();
  }

  return {
    caseName: probeCase.name,
    outcome,
    durationMs: Date.now() - startedAt,
    threadId,
    realtimeSessionId,
    realtimeStartParams,
    ...(accountReadResponse !== undefined
      ? { accountAuth: summarizeAccountAuth(accountReadResponse) }
      : {}),
    ...(realtimeStartResponse !== undefined ? { realtimeStartResponse } : {}),
    ...(lifecycleNotification !== undefined ? { lifecycleNotification } : {}),
    ...(requestError !== undefined ? { requestError } : {}),
    stderr: client.stderr.join(""),
    messages: client.messages.map(redactAccountEmail),
  };
}

export function parseProbeOptions(args: ReadonlyArray<string>): ProbeOptions {
  let codexBinary = "codex";
  let cwd = process.cwd();
  let threadModel = "gpt-5.6-sol";
  let realtimeModel = "gpt-realtime";
  let offerSdp: string | undefined;
  let timeoutMs = 15_000;
  let caseNames: ReadonlySet<string> | undefined;
  let json = false;

  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    const value = args[index + 1];
    if (arg === "--json") json = true;
    else if (arg === "--codex" && value !== undefined) [codexBinary, index] = [value, index + 1];
    else if (arg === "--cwd" && value !== undefined) [cwd, index] = [value, index + 1];
    else if (arg === "--thread-model" && value !== undefined)
      [threadModel, index] = [value, index + 1];
    else if (arg === "--realtime-model" && value !== undefined)
      [realtimeModel, index] = [value, index + 1];
    else if (arg === "--offer-sdp-base64" && value !== undefined) {
      offerSdp = Buffer.from(value, "base64").toString("utf8");
      index++;
    } else if (arg === "--timeout-ms" && value !== undefined) {
      timeoutMs = Number(value);
      index++;
    } else if (arg === "--cases" && value !== undefined) {
      caseNames = new Set(
        value
          .split(",")
          .map((name) => name.trim())
          .filter(Boolean),
      );
      index++;
    } else {
      throw new Error(`Unknown or incomplete argument: ${arg}`);
    }
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000) {
    throw new Error("--timeout-ms must be an integer of at least 1000");
  }
  return { codexBinary, cwd, threadModel, realtimeModel, offerSdp, timeoutMs, caseNames, json };
}

async function main(): Promise<void> {
  const options = parseProbeOptions(process.argv.slice(2));
  const allCases = buildRealtimeProbeCases(options.realtimeModel, options.offerSdp);
  const selectedCases =
    options.caseNames === undefined
      ? allCases
      : allCases.filter((probeCase) => options.caseNames?.has(probeCase.name));
  if (selectedCases.length === 0) throw new Error("No probe cases selected");
  if (options.caseNames !== undefined) {
    const known = new Set(allCases.map((probeCase) => probeCase.name));
    const unknown = [...options.caseNames].filter((name) => !known.has(name));
    if (unknown.length > 0) throw new Error(`Unknown probe cases: ${unknown.join(", ")}`);
  }

  const version = (await execFileAsync(options.codexBinary, ["--version"])).stdout.trim();
  const results: Array<RealtimeProbeResult> = [];
  for (const probeCase of selectedCases) results.push(await runProbeCase(probeCase, options));
  const report = {
    generatedAt: new Date().toISOString(),
    codexBinary: options.codexBinary,
    codexVersion: version,
    cwd: options.cwd,
    threadModel: options.threadModel,
    realtimeModel: options.realtimeModel,
    results,
  };

  if (options.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    process.stdout.write(`Codex realtime probe: ${version}\n`);
    for (const result of results) {
      process.stdout.write(
        `${result.outcome === "started" ? "PASS" : "FAIL"} ${result.caseName} (${result.durationMs}ms): ${result.outcome}\n`,
      );
      if (result.lifecycleNotification !== undefined) {
        process.stdout.write(`  ${JSON.stringify(result.lifecycleNotification)}\n`);
      }
      if (result.requestError !== undefined) process.stdout.write(`  ${result.requestError}\n`);
    }
    process.stdout.write("Use --json for complete raw protocol messages and stderr.\n");
  }
  if (!results.some((result) => result.outcome === "started")) process.exitCode = 1;
}

if (import.meta.main) {
  main().catch((error) => {
    process.stderr.write(`${errorText(error)}\n`);
    process.exitCode = 1;
  });
}
