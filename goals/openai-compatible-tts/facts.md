# Facts

- Settings has a dedicated Speech page for one TTS provider with an enabled state, an OpenAI-compatible speech endpoint URL, an optional API key, a model, a voice, a response format, and playback speed.
- T3 Code sends speech requests from the server as OpenAI Audio API-shaped POST requests containing model, voice, input, response_format, and speed, so the browser never calls the configured provider directly.
- An optional TTS API key is stored as a server-side secret, is redacted from settings responses, and is sent upstream as a Bearer token only when configured.
- Every completed, non-empty agent message in chat has a read-aloud button; streaming, commentary-only, and empty messages do not expose it.
- Starting a message stops any current TTS request or playback, and activating the button for the currently playing message stops it.
- The chat control exposes clear loading, playing, and stopped states, releases temporary audio resources, and reports configuration or provider failures without disrupting the conversation.
- The first release is manual-only and adds no auto-read mode, playback queue, audio cache, or per-thread TTS override.
- Focused automated tests cover settings compatibility and redaction, upstream request and response handling, and chat playback state; integrated verification proves playback with local Kokoro on port 8880 and a remote OpenAI-compatible Microsoft Edge TTS provider.
