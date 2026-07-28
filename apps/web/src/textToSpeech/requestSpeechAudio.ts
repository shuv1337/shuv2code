import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { HttpBody, HttpClient, HttpClientRequest } from "effect/unstable/http";

import { resolvePrimaryEnvironmentHttpUrl } from "../environments/primary/target";
import { runPrimaryRawHttp } from "../lib/runtime";

class SpeechRequestError extends Schema.TaggedErrorClass<SpeechRequestError>()(
  "SpeechRequestError",
  {
    message: Schema.String,
  },
) {}

const requestSpeechAudioEffect = (input: string) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const request = HttpClientRequest.post(
      resolvePrimaryEnvironmentHttpUrl("/api/text-to-speech"),
      {
        body: HttpBody.jsonUnsafe({ input }),
      },
    );
    const response = yield* client.execute(request).pipe(
      Effect.mapError(
        () =>
          new SpeechRequestError({
            message: "Could not reach the T3 Code speech service.",
          }),
      ),
    );
    if (response.status < 200 || response.status >= 300) {
      const detail = yield* response.text.pipe(Effect.orElseSucceed(() => ""));
      return yield* new SpeechRequestError({
        message: detail.trim() || `Text-to-speech failed with HTTP ${response.status}.`,
      });
    }
    const bytes = yield* response.arrayBuffer.pipe(
      Effect.mapError(
        () =>
          new SpeechRequestError({
            message: "The speech response could not be read.",
          }),
      ),
    );
    if (bytes.byteLength === 0) {
      return yield* new SpeechRequestError({
        message: "The speech provider returned empty audio.",
      });
    }
    return new Blob([bytes], {
      type: response.headers["content-type"] ?? "application/octet-stream",
    });
  });

export function requestSpeechAudio(input: string, signal: AbortSignal): Promise<Blob> {
  return runPrimaryRawHttp(requestSpeechAudioEffect(input), { signal });
}
