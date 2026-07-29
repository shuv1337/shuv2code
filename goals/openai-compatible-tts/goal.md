# OpenAI-compatible text-to-speech

Implement a first-class, lightweight TTS provider option in shuv2code for any OpenAI Audio API-shaped speech endpoint, and let users manually read aloud any completed agent message in chat. Verify the provider-neutral path with local Kokoro on port 8880 and a remote Microsoft Edge TTS-backed OpenAI-compatible provider.

The shared, testable product understanding is in [facts.md](facts.md). The approved execution path is in [plan.md](plan.md).

The goal is done when all accepted facts have focused automated coverage, the affected packages pass scoped formatting/lint/type checks, both providers complete the integrated web playback flow, and all temporary verification processes are stopped.
