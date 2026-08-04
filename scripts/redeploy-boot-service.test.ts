import { assert, it } from "@effect/vitest";

import {
  decideBootServiceRedeploy,
  evaluateRestartSamples,
  parseSystemdShow,
  toBootServiceState,
  type BootServiceState,
} from "./redeploy-boot-service.ts";

const DIST_PATH = "/home/theo/repos/shuv2code/apps/server/dist/bin.mjs";

const repoUnitShowOutput = [
  "LoadState=loaded",
  "ActiveState=active",
  "ExecMainPID=2838154",
  `ExecStart={ path=/usr/bin/node ; argv[]=/usr/bin/node ${DIST_PATH} serve ; ignore_errors=no ; start_time=[n/a] ; stop_time=[n/a] ; pid=0 ; code=(null) ; status=0/0 }`,
  "",
].join("\n");

function state(overrides: Partial<BootServiceState>): BootServiceState {
  return {
    loadState: "loaded",
    activeState: "active",
    mainPid: 1000,
    execStart: `argv[]=/usr/bin/node ${DIST_PATH} serve`,
    ...overrides,
  };
}

it("parses systemctl show output including values containing '='", () => {
  const properties = parseSystemdShow(repoUnitShowOutput);
  assert.strictEqual(properties["LoadState"], "loaded");
  assert.strictEqual(properties["ExecMainPID"], "2838154");
  assert.include(properties["ExecStart"], `argv[]=/usr/bin/node ${DIST_PATH} serve`);
});

it("maps show properties to a typed state with a numeric pid", () => {
  const parsed = toBootServiceState(parseSystemdShow(repoUnitShowOutput));
  assert.deepStrictEqual(parsed, {
    loadState: "loaded",
    activeState: "active",
    mainPid: 2838154,
    execStart: parseSystemdShow(repoUnitShowOutput)["ExecStart"],
  });
});

it("treats a missing or malformed ExecMainPID as pid 0", () => {
  assert.strictEqual(toBootServiceState({ LoadState: "loaded" }).mainPid, 0);
  assert.strictEqual(toBootServiceState({ ExecMainPID: "unset" }).mainPid, 0);
});

it("redeploys a loaded unit whose ExecStart runs this checkout's dist", () => {
  const decision = decideBootServiceRedeploy(
    toBootServiceState(parseSystemdShow(repoUnitShowOutput)),
    DIST_PATH,
  );
  assert.deepStrictEqual(decision, { kind: "redeploy", previousPid: 2838154 });
});

it("reports a unit that systemd does not know as not installed", () => {
  const decision = decideBootServiceRedeploy(
    toBootServiceState({ LoadState: "not-found", ActiveState: "inactive", ExecMainPID: "0" }),
    DIST_PATH,
  );
  assert.deepStrictEqual(decision, { kind: "not-installed" });
});

it("refuses to restart a unit pointing at a release-managed runtime", () => {
  const foreignExecStart =
    "argv[]=/home/theo/.shuv2code/runtime/node /home/theo/.shuv2code/runtime/shuv2code serve";
  const decision = decideBootServiceRedeploy(state({ execStart: foreignExecStart }), DIST_PATH);
  assert.deepStrictEqual(decision, { kind: "foreign-unit", execStart: foreignExecStart });
});

it("accepts a restart when both samples are active with one stable new pid", () => {
  const verdict = evaluateRestartSamples(1000, state({ mainPid: 2000 }), state({ mainPid: 2000 }));
  assert.deepStrictEqual(verdict, { ok: true, pid: 2000 });
});

it("accepts a first start where no previous pid existed", () => {
  const verdict = evaluateRestartSamples(0, state({ mainPid: 2000 }), state({ mainPid: 2000 }));
  assert.deepStrictEqual(verdict, { ok: true, pid: 2000 });
});

it("rejects a restart when the unit is not active in either sample", () => {
  assert.deepStrictEqual(
    evaluateRestartSamples(1000, state({ activeState: "activating" }), state({ mainPid: 2000 })),
    { ok: false, reason: "inactive" },
  );
  assert.deepStrictEqual(
    evaluateRestartSamples(1000, state({ mainPid: 2000 }), state({ activeState: "failed" })),
    { ok: false, reason: "inactive" },
  );
});

it("flags a pid change between samples as a crash loop", () => {
  assert.deepStrictEqual(
    evaluateRestartSamples(1000, state({ mainPid: 2000 }), state({ mainPid: 2001 })),
    { ok: false, reason: "crash-loop" },
  );
});

it("flags an unchanged pid as a restart that did not take effect", () => {
  assert.deepStrictEqual(
    evaluateRestartSamples(1000, state({ mainPid: 1000 }), state({ mainPid: 1000 })),
    { ok: false, reason: "pid-unchanged" },
  );
});
