/**
 * Rendering coverage for the group-assignment menu (M2 / #197).
 *
 * The defect these exist for: the menu composed Base UI's `Menu.GroupLabel`
 * outside any `Menu.Group` / `Menu.RadioGroup`, which is a *render-time*
 * invariant. Clicking the group control threw
 * "Base UI: MenuGroupContext is missing" and took the whole page into the
 * global error boundary — while every pure test of the options, the labels and
 * the patch stayed green, because none of them ever rendered the menu.
 *
 * So these render the real parts. `Menu` (Base UI's `Menu.Root`) supplies the
 * root context that menu items require; no popup, portal, trigger, DOM or atom
 * registry is involved, which is what keeps a genuine composition test cheap
 * enough to sit beside the logic ones.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import type { AdeBotGroupId } from "@shuv2code/contracts";

import { Menu, MenuGroupLabel } from "../ui/menu";
import { getGroupAssignOptions, UNGROUPED_MENU_VALUE } from "./botIdentity.logic";
import { GroupAssignMenuContent } from "./GroupAssignMenu";

const BACKEND = "group_backend" as AdeBotGroupId;
const FRONTEND = "group_frontend" as AdeBotGroupId;

const groups = [
  { id: BACKEND, name: "Backend", orderIndex: 0, createdAt: "2026-08-25T00:00:00.000Z" },
  { id: FRONTEND, name: "Frontend", orderIndex: 1, createdAt: "2026-08-25T00:00:00.000Z" },
];

const render = (
  overrides: Partial<React.ComponentProps<typeof GroupAssignMenuContent>> = {},
  currentGroupId: AdeBotGroupId | null = null,
) =>
  renderToStaticMarkup(
    <Menu open>
      <GroupAssignMenuContent
        assignError={null}
        busy={false}
        createError={null}
        creating={false}
        newName=""
        options={getGroupAssignOptions(groups, currentGroupId)}
        selectedValue={currentGroupId ?? UNGROUPED_MENU_VALUE}
        onCancelCreate={() => {}}
        onCreate={() => {}}
        onNewNameChange={() => {}}
        onSelect={() => {}}
        onStartCreate={() => {}}
        {...overrides}
      />
    </Menu>,
  );

describe("GroupAssignMenuContent", () => {
  it("renders every group as a radio item under a labelled group", () => {
    const markup = render();

    // The composition that used to throw.
    expect(markup).toContain('data-slot="menu-radio-group"');
    expect(markup).toContain('data-slot="menu-label"');
    expect(markup).toContain("Group");
    // Ungrouped leads; every captain group follows.
    expect(markup).toContain("Ungrouped");
    expect(markup).toContain("Backend");
    expect(markup).toContain("Frontend");
    expect(markup.match(/role="menuitemradio"/g)).toHaveLength(3);
  });

  it("marks the bot's current group as the checked radio", () => {
    const markup = render({}, BACKEND);
    const checked = markup.match(/data-checked=""[^>]*>|<[^>]*data-checked=""/g) ?? [];
    // Exactly one selection, and the label beside it is the one filed group.
    expect(checked).toHaveLength(1);
    const backendIndex = markup.indexOf("Backend");
    const checkedIndex = markup.lastIndexOf("data-checked", backendIndex);
    expect(checkedIndex).toBeGreaterThan(-1);
  });

  it("offers the create path when it is not open", () => {
    const markup = render();
    expect(markup).toContain("New group");
    expect(markup).not.toContain('aria-label="New group name"');
  });

  it("renders the create-new-group form once it is open", () => {
    const markup = render({ creating: true, newName: "Platform" });

    expect(markup).toContain('aria-label="New group name"');
    expect(markup).toContain('value="Platform"');
    expect(markup).toContain("Create");
    expect(markup).toContain("Cancel");
    // The trigger for the form is replaced by the form, not shown beside it.
    expect(markup).not.toContain("New group…");
  });

  it("surfaces a create failure beside the field that caused it", () => {
    const markup = render({
      creating: true,
      createError: "A group named “Backend” already exists.",
    });
    expect(markup).toContain('role="alert"');
    expect(markup).toContain("already exists");
  });

  it("surfaces a move failure without losing the menu", () => {
    const markup = render({ assignError: "The bot was not moved." });
    expect(markup).toContain("The bot was not moved.");
    expect(markup).toContain('role="menuitemradio"');
  });

  it("disables the choices while a move is in flight", () => {
    const markup = render({ busy: true });
    expect(markup).toContain("data-disabled");
  });
});

/**
 * The wrapper is load-bearing, not stylistic. Pinning the invariant itself
 * means a future edit that "tidies" the radio group away fails here with the
 * reason spelled out, rather than in a browser as a blank page.
 */
describe("Base UI menu group invariant", () => {
  it("throws when a group label is composed outside a group", () => {
    expect(() =>
      renderToStaticMarkup(
        <Menu open>
          <MenuGroupLabel>Group</MenuGroupLabel>
        </Menu>,
      ),
    ).toThrow(/MenuGroupContext is missing/);
  });
});
