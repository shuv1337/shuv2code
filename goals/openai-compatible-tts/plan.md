# OpenAI-compatible text-to-speech plan

## Solution approach

Add one server-authoritative `textToSpeech` configuration rather than treating speech as an agent-runtime provider instance. The browser will submit only message text to an authenticated same-origin T3 Code route; the server will apply the configured OpenAI Audio API request shape, attach an optional secret Bearer token, and proxy the resulting audio bytes back. A small timeline-owned playback controller will guarantee one active request or clip at a time and expose the state to read-aloud buttons on terminal assistant messages.

## Ordered implementation

1. Define the provider-neutral speech contract and defaults.
   - Extend `packages/contracts/src/settings.ts` with a `TextToSpeechSettings` schema containing `enabled`, `endpoint`, redacted API-key state, `model`, `voice`, `responseFormat`, and bounded `speed`; add it to `ServerSettings` and `ServerSettingsPatch`.
   - Keep the endpoint as a full `/v1/audio/speech` URL so local, hosted, and nonstandard OpenAI-compatible installations require no URL-joining assumptions.
   - Extend `packages/contracts/src/settings.test.ts` for defaults, legacy-settings decoding, valid custom configuration, partial patches, and invalid speed/config values.
   - Verification: `vp test run packages/contracts/src/settings.test.ts`.

2. Persist and redact the optional API key with the existing server secret store.
   - Extend `apps/server/src/serverSettings.ts` so TTS API-key writes, replacement, preservation, clearing, disk redaction, in-memory materialization, and client redaction follow the existing provider-environment secret lifecycle.
   - Add focused cases to `apps/server/src/serverSettings.test.ts`, including proof that settings responses never contain the saved key and that an unrelated speech-settings edit preserves it.
   - Verification: `vp test run apps/server/src/serverSettings.test.ts`.

3. Add an authenticated speech proxy.
   - Add a small module under `apps/server/src/textToSpeech/` that validates readiness, constructs the exact OpenAI-compatible JSON body, conditionally attaches `Authorization: Bearer`, calls the configured endpoint through Effect HTTP, accepts audio response bytes/content type, and maps configuration, upstream status, and transport failures to safe user-facing errors.
   - Register `POST /api/text-to-speech` in `apps/server/src/http.ts` behind orchestration operate scope. Decode a non-empty `{ input }` body, return audio bytes with `Cache-Control: no-store` and `X-Content-Type-Options: nosniff`, and avoid exposing provider details or the key.
   - Add focused service/route tests with a mock HTTP client to verify request fields, optional auth, byte/content-type passthrough, disabled/misconfigured handling, upstream failures, and auth enforcement.
   - Verification: `vp test run apps/server/src/textToSpeech/TextToSpeech.test.ts apps/server/src/http.test.ts` (use a narrower new route test file instead of `http.test.ts` if the existing harness supports it).

4. Add the dedicated Speech settings page.
   - Create `apps/web/src/components/settings/SpeechSettingsPanel.tsx` with controls for enablement, endpoint, model, voice, response format, speed, API-key replacement, and explicit API-key clearing.
   - Add `apps/web/src/routes/settings.speech.tsx`, update `SettingsSidebarNav.tsx`, and regenerate `routeTree.gen.ts` through the existing TanStack/Vite workflow.
   - Use existing environment-scoped settings hooks, optimistic patches, settings layout, and reset patterns; never retain or redisplay the saved key in browser state.
   - Add focused UI/presentation tests for the page and navigation entry.
   - Verification: `vp test run apps/web/src/components/settings/SpeechSettingsPanel.test.tsx`.

5. Add single-clip chat playback and message actions.
   - Add a small browser playback controller/hook under `apps/web/src/` that owns the abort controller, object URL, and `HTMLAudioElement`; it will stop and clean up before every new request, toggle stop for the active message, and recover cleanly after request, decode, playback, or unmount failures.
   - Add a ghost read-aloud button beside the existing copy action in `apps/web/src/components/chat/MessagesTimeline.tsx` for every terminal, completed, non-empty assistant message. Show loading, playing, and idle icons/labels, and report failures through the existing toast system.
   - Extend timeline logic/presentation tests and add focused controller tests with injected browser primitives to verify eligibility, one-active-message semantics, same-message stop, aborts, object-URL cleanup, ended playback, and error recovery.
   - Verification: `vp test run apps/web/src/components/chat/MessagesTimeline.logic.test.ts apps/web/src/components/chat/MessagesTimeline.test.tsx apps/web/src/textToSpeech/SpeechPlaybackController.test.ts`.

6. Run scoped static checks and integrated provider verification.
   - Run formatting, lint, and type checks only for the affected packages/files; do not run the repo-wide suites.
   - Use the required `test-t3-app` workflow to launch one isolated web environment and authenticate through its pairing URL.
   - Configure `http://127.0.0.1:8880/v1/audio/speech` with the installed Kokoro model/voice, generate and audibly inspect a short prior agent message, stop it, and start a different message.
   - Reconfigure the same page to a reachable remote deployment of the OpenAI-compatible `openai-edge-tts` implementation backed by Microsoft Edge TTS, repeat playback, and confirm no API key is required or that a configured test key is sent only from the server.
   - Stop the isolated T3 Code environment and any temporary remote/local test process after verification.

## Risks and open questions

- Public `openai-edge-tts` demo deployments are not guaranteed to remain reachable. If no maintained public endpoint is available, use a temporary, user-scoped remote deployment of the upstream implementation for the verification pass and tear it down afterward.
- Provider response formats vary in MIME accuracy. The proxy will preserve a valid upstream audio content type and fall back to the configured response format when the upstream header is absent or generic.
- Very long agent messages may exceed a provider's own input limit. V1 deliberately sends one manual request and surfaces the provider error; synthesis chunking and concatenation remain outside the accepted lean scope.
