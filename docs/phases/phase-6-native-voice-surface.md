# Phase 6: Native Voice Surface

Status: proposed

## Overview and motivation

The lab established the visual language, but production still renders a Controller-only surface from inside `ChatView`. That prevents environment-wide Controller when no thread is active, encourages Call retargeting, and risks remount/flicker during route and panel relayout.

This slice promotes the proven surface into a persistent native host and makes the two product meanings immediately legible.

## User-visible result

- Controller and Call are clearly labeled and scoped: **All threads** versus **This thread**.
- Voice can be opened with no active thread; Controller remains available.
- Starting audio is obvious in either mode.
- Controller uses the distinct warm/orange transcript language.
- Call foregrounds the living presence and only temporal user, activity, and spoken-agent text.
- Controls occupy a stable bottom action region with phase and duration immediately above.
- An active session collapses to a small global presence without changing owner.
- Resizing, maximizing, collapsing, routing, or phase changes do not flash or recreate the canvas.

## Host architecture

Create one `VoiceSurfaceHost` under the authenticated `_chat` route layout, not inside an individual `ChatView`. It consumes:

- environment-scoped surface preference from `rightPanelStore`;
- active media session from app-root `VoiceSessionProvider`;
- current route thread as optional Call context only;
- normalized Controller or Call presentation from client-runtime.

`ChatView` keeps thread-specific diff/files/preview/terminal tenants. It exposes layout coordination to the host but no longer owns Voice lifecycle or rendering.

```text
AppRoot
  VoiceSessionProvider        persistent media/runtime owner
  Router
    _chat layout
      ChatRouteContent        current route/thread
      VoiceSurfaceHost        persistent environment surface
      VoiceSessionTray        persistent collapsed active session
```

## Presentation component boundaries

```ts
VoiceSurfaceHost; // placement, expanded/collapsed, current context
VoiceSurface; // mode selection and shared chrome
ControllerSurface; // catalog, orange history, Controller start/controls
CallSurface; // presence, temporal projection, Call start/controls
VoicePresence; // pure renderer with imperative signal refs
VoiceActionBar; // mute/speaker/end/start
VoiceSessionTray; // collapsed owner/phase controls
```

The lab may compose the same pure presentation components with simulated inputs. It must not contain production branching or backend adapters.

## Presence and no-flicker contract

Retain the dependency-free WebGL implementation and existing render policy. Do not add Three.js.

- Mount one canvas for the lifetime of the expanded Call surface.
- Keep a fixed backing-store strategy; `ResizeObserver` updates layout/aspect uniforms without replacing the canvas or WebGL context.
- Pass audio levels through refs/typed buffers, not React state.
- Blend phase energy, palette, line entry/exit, curvature, vapor density, and highlight position continuously.
- Never flip palette on phase transitions; colors interpolate over a minimum transition interval.
- Listening is cooler/quieter and input-reactive; thinking has slow internal movement; speaking has coherent output-reactive light movement.
- Pause when hidden, use reduced motion, degrade to static CSS fallback for software/constrained rendering, and honor existing active/ambient frame caps.

## Layout behavior

- Expanded surface fills the Voice tenant instead of placing a small card in unused space.
- Header carries mode/scope/context and settings, not decorative labels.
- Call context is one restrained thread-owned strip.
- Living presence uses the available middle field.
- Temporal text occupies a bounded region and never becomes a second scrollable thread.
- Listening/phase plus duration sit above the bottom action bar.
- Controls remain in stable positions through phase changes.
- Narrow/sheet and inline side-panel layouts share component state; a breakpoint change moves the host without remounting the media or presence owner.

## Entry points

| Entry                      | Behavior                                                               |
| -------------------------- | ---------------------------------------------------------------------- |
| Thread composer microphone | Open Call for this exact thread; a second explicit action starts media |
| Right-panel Voice action   | Open last selected mode; Controller when no callable thread exists     |
| Global command/keybinding  | Open Controller                                                        |
| Active collapsed tray      | Reopen the active owner/mode                                           |
| Call context strip         | Navigate back to the exact called thread                               |

Mode selection never auto-starts the microphone and never transfers an active session.

## Files

### New

- `apps/web/src/components/voice/VoiceSurfaceHost.tsx`
- `apps/web/src/components/voice/VoiceSurfaceHost.test.tsx`
- `apps/web/src/components/voice/ControllerSurface.tsx`
- `apps/web/src/components/voice/CallSurface.tsx`
- `apps/web/src/components/voice/VoiceActionBar.tsx`
- `apps/web/src/components/voice/VoiceTemporalText.tsx`
- `apps/web/src/components/voice/VoicePresence.lifecycle.test.tsx`

### Modified

- `apps/web/src/routes/_chat.tsx`
- `apps/web/src/AppRoot.voice.test.tsx`
- `apps/web/src/rightPanelStore.ts`
- `apps/web/src/rightPanelStore.test.ts`
- `apps/web/src/rightPanelLayout.ts`
- `apps/web/src/components/ChatView.tsx`
- `apps/web/src/components/ChatView.logic.ts`
- `apps/web/src/components/ChatView.logic.test.ts`
- `apps/web/src/components/chat/ChatComposer.voice.tsx`
- `apps/web/src/components/chat/ChatComposer.voice.test.tsx`
- `apps/web/src/components/rightPanelTabStrip.ts`
- `apps/web/src/components/rightPanelTabStrip.test.ts`
- `apps/web/src/components/voice/VoiceSurface.tsx`
- `apps/web/src/components/voice/VoiceSurfaceLab.tsx`
- `apps/web/src/components/voice/VoicePresence.tsx`
- `apps/web/src/components/voice/voicePresenceRenderPolicy.ts`
- `apps/web/src/components/voice/voicePresenceRenderPolicy.test.ts`
- `apps/web/src/components/voice/voicePresenceTheme.ts`
- `apps/web/src/components/voice/VoiceSessionTray.tsx`
- `apps/web/src/components/voice/VoiceSessionTray.test.tsx`
- `apps/web/src/routes/dev.voice.tsx`

### Intentionally unchanged

- Backend session, Call, and Controller semantics established in Phases 1-5.
- Ordinary thread timeline rendering.
- Mobile surface.
- A new graphics dependency.

## Implementation order

1. Add persistent host tests around no-thread, route changes, and active owner.
2. Extract pure Controller/Call presentation components from production/lab composition.
3. Move Voice rendering from `ChatView` to the `_chat` host and coordinate layout.
4. Wire entry points and explicit start behavior.
5. Stabilize canvas identity/context and add resize/phase lifecycle tests.
6. Tune the procedural presence against the approved references using the dev lab.
7. Verify inline, maximized, collapsed, sheet, no-thread, Controller, and Call layouts in the browser.

## Focused verification

- Controller opens without an active thread.
- Call cannot be selected without a callable thread unless an existing Call is pinned.
- Switching the selected tab does not mutate active media owner.
- Route changes preserve media generation and Call owner.
- Canvas node and WebGL context identity remain stable across resize, maximize, phase, and responsive layout transition.
- No one-frame clear/black/bright flash appears in a resize filmstrip.
- Reduced motion, hidden page, software renderer, and slow-frame degradation behave as policy specifies.
- Dev Test controls are absent from production routes.

Commands:

- `vp test run apps/web/src/components/voice/VoiceSurfaceHost.test.tsx apps/web/src/components/voice/VoicePresence.lifecycle.test.tsx apps/web/src/components/voice/VoiceSessionTray.test.tsx`
- `vp test run apps/web/src/rightPanelStore.test.ts apps/web/src/components/ChatView.logic.test.ts apps/web/src/components/chat/ChatComposer.voice.test.tsx`
- `vp test run apps/web/src/components/voice/voicePresenceRenderPolicy.test.ts apps/web/src/AppRoot.voice.test.tsx`
- Integrated web: use the repository app-testing workflow to verify every layout/state above and capture a resize filmstrip.

## Exit criteria

- Voice is a native environment surface, not a `ChatView` attachment.
- Controller and Call communicate scope and ownership without explanatory prose.
- Active sessions survive routing/layout changes without retargeting or remount flicker.
- The production surface and lab share presentation primitives, not mock lifecycle code.
