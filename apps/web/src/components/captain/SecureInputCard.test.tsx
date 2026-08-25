import { createRef } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { SecureInputField } from "./SecureInputCard";

/**
 * The never-echoed contract, at the render layer (MESSENGER-PIVOT §6 M5).
 *
 * The server half is asserted in `AdeCaptainApiRosterLiveness.test.ts` — the
 * secret reaches no durable column and no roster payload. This is the client
 * half, and it is a *structural* claim rather than a behavioural one: the field
 * is uncontrolled, so the value lives only in the DOM node until submit, and
 * `SecureInputField` has no prop that could carry it. A rendering therefore
 * cannot contain the secret, whatever the captain typed.
 *
 * Rendered with `renderToStaticMarkup`, like `GroupAssignMenu.test.tsx`: this
 * is a composition claim about real markup, and it stays cheap enough to sit
 * beside the pure tests.
 */
describe("SecureInputField", () => {
  const render = (overrides: Partial<React.ComponentProps<typeof SecureInputField>> = {}) =>
    renderToStaticMarkup(
      <SecureInputField
        busy={false}
        canSubmit
        fieldId="secure-field"
        inputRef={createRef<HTMLInputElement>()}
        label="Deploy Bot needs a token"
        onChangeHasValue={() => {}}
        onSubmit={() => {}}
        {...overrides}
      />,
    );

  it("renders a masked, uncontrolled field with no value in the markup", () => {
    const markup = render();
    expect(markup).toContain('type="password"');
    // Uncontrolled: React emits `value=` for a controlled input, and a
    // controlled one would mean the secret had passed through component state.
    expect(markup).not.toContain("value=");
    // `off` is ignored by password managers; an autofilled credential from a
    // previous item would be its own leak.
    expect(markup.toLowerCase()).toContain('autocomplete="new-password"');
    expect(markup.toLowerCase()).toContain('spellcheck="false"');
  });

  it("labels the field and offers the save control", () => {
    const markup = render();
    expect(markup).toContain("Deploy Bot needs a token");
    expect(markup).toContain('for="secure-field"');
    expect(markup).toContain("Save securely");
  });

  it("disables saving until there is something to save", () => {
    expect(render({ canSubmit: false })).toContain("disabled");
    // Busy disables the field too, so an in-flight answer cannot be edited
    // under itself.
    expect(render({ busy: true })).toContain("disabled");
  });

  it("takes no prop that could carry the value", () => {
    // The structural claim, pinned: adding a `value`/`secret` prop to this
    // component is the change this test exists to fail on.
    const props = ["busy", "canSubmit", "fieldId", "inputRef", "label"];
    for (const forbidden of ["value", "secret", "note", "defaultValue"]) {
      expect(props).not.toContain(forbidden);
    }
    expect(render()).not.toContain("sk-live");
  });
});
