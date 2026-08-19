// @ts-expect-error Direct Vitest import bypasses the broken Vite+ test adapter on this checkout.
import { describe, expect, it } from "vitest";

import { VoiceSurfacePortalMount } from "./VoiceSurfaceHost.logic";

interface FakeContainer {
  parent: FakeTarget | null;
  removeCount: number;
  remove(): void;
}

interface FakeTarget {
  readonly name: string;
  appendCount: number;
  append(container: FakeContainer): void;
}

function fixture() {
  const container: FakeContainer = {
    parent: null,
    removeCount: 0,
    remove() {
      this.removeCount += 1;
      this.parent = null;
    },
  };
  const target = (name: string): FakeTarget => ({
    name,
    appendCount: 0,
    append(child) {
      this.appendCount += 1;
      child.parent = this;
    },
  });
  return {
    container,
    inline: target("inline"),
    sheet: target("sheet"),
    mount: new VoiceSurfacePortalMount(container as unknown as HTMLDivElement),
  };
}

describe("VoiceSurfacePortalMount", () => {
  it("moves one stable portal container between responsive hosts", () => {
    const { container, inline, sheet, mount } = fixture();

    mount.attach(inline as unknown as HTMLDivElement);
    expect(container.parent).toBe(inline);
    mount.attach(sheet as unknown as HTMLDivElement);

    expect(container.parent).toBe(sheet);
    expect(inline.appendCount).toBe(1);
    expect(sheet.appendCount).toBe(1);
  });

  it("ignores stale detach cleanup after the portal has moved", () => {
    const { container, inline, sheet, mount } = fixture();

    mount.attach(inline as unknown as HTMLDivElement);
    mount.attach(sheet as unknown as HTMLDivElement);
    const detached = mount.detach(inline as unknown as HTMLDivElement);

    expect(container.parent).toBe(sheet);
    expect(container.removeCount).toBe(0);
    expect(detached).toBe(false);
  });

  it("detaches without replacing the portal container", () => {
    const { container, inline, mount } = fixture();

    mount.attach(inline as unknown as HTMLDivElement);
    const detached = mount.detach(inline as unknown as HTMLDivElement);

    expect(container.parent).toBeNull();
    expect(container.removeCount).toBe(1);
    expect(mount.container).toBe(container);
    expect(detached).toBe(true);
  });
});
