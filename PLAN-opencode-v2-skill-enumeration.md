# OpenCode V2 Skill Enumeration Fix Plan

## Root Cause

OpenCode provider inventory currently loads only provider/model and agent data. The native V2 compatibility client does not expose a skill-listing method, and the provider snapshot builder is never given OpenCode skills, so every OpenCode snapshot publishes the default empty `skills` array even when the active OpenCode location has registered skills.

The two supported protocol surfaces expose equivalent metadata through different transports:

- The locked `@opencode-ai/sdk` legacy-compatible surface provides `client.app.skills()` and returns skill entries with `name`, optional `description`, `location`, and `content`.
- The OpenCode V2 API provides `GET /api/skill?location[directory]=...` and returns a location envelope whose `data` contains skill entries, including `name`, optional `description`, and `location`.

## Implementation

1. Extend `apps/server/src/provider/opencodeV2Compatibility.ts` with the native V2 skill response shape and a location-aware `skill.list` request to `GET /api/skill`. Expose that data through the compatibility client's legacy `app.skills()` method.
2. Extend `OpenCodeInventory` in `apps/server/src/provider/opencodeRuntime.ts` with normalized `ServerProviderSkill` entries. Load `client.app.skills()` concurrently with providers and agents when the SDK surface supports it, map `location` to `path`, mark discovered skills enabled, preserve non-empty descriptions, and return an empty list for clients without the method. Keep CLI-only V1 inventory explicit with an empty skill list because that CLI probe has no skill metadata surface.
3. Pass successful inventory skills into `buildServerProvider` in `apps/server/src/provider/Layers/OpenCodeProvider.ts` so OpenCode provider snapshots advertise them to web and mobile composers.

## Focused Tests

1. Extend `apps/server/src/provider/opencodeV2Compatibility.test.ts` to verify `app.skills()` calls `/api/skill` with the configured location and projects the V2 location envelope onto the legacy SDK response.
2. Add focused inventory normalization coverage for valid entries, optional descriptions, malformed empty identifiers/locations, and SDK clients without `app.skills()`.
3. Extend `apps/server/src/provider/Layers/OpenCodeProvider.test.ts` to verify normalized inventory skills are present in a ready OpenCode provider snapshot.

## Verification

- Run the focused OpenCode compatibility, runtime inventory, and provider snapshot tests with `vp test run <test-files>`.
- Run targeted formatting/lint for the changed files and the server package typecheck.
- Review the final diff and create one atomic conventional commit containing this plan, implementation, and tests.

## Boundaries And Risk

- Do not add filesystem scanning or infer skill scope; OpenCode remains the source of truth for location-specific discovery.
- Do not make skill enumeration mandatory for older SDK-compatible clients that lack `app.skills()`.
- Local legacy V1 CLI-only probes continue to report no skills because their existing health-check path intentionally avoids starting a server and the CLI inventory commands do not return skill metadata.
