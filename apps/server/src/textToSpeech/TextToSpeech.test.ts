import { DEFAULT_SERVER_SETTINGS, type ServerSettingsError } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";

import * as ServerSettings from "../serverSettings.ts";
import {
  makeOpenAiSpeechRequest,
  synthesizeTextToSpeech,
  type TextToSpeechError,
} from "./TextToSpeech.ts";

function makeLayer(
  textToSpeech: Partial<typeof DEFAULT_SERVER_SETTINGS.textToSpeech>,
  execute: Parameters<typeof HttpClient.make>[0],
) {
  return Layer.mergeAll(
    ServerSettings.layerTest({
      textToSpeech: {
        ...DEFAULT_SERVER_SETTINGS.textToSpeech,
        ...textToSpeech,
      },
    }),
    Layer.succeed(HttpClient.HttpClient, HttpClient.make(execute)),
  );
}

function assertTextToSpeechError(
  error: TextToSpeechError | ServerSettingsError,
): asserts error is TextToSpeechError {
  assert.equal(error._tag, "TextToSpeechError");
}

it.effect("builds an OpenAI Audio API-shaped request", () =>
  Effect.sync(() => {
    assert.deepEqual(
      makeOpenAiSpeechRequest("Read this back.", {
        ...DEFAULT_SERVER_SETTINGS.textToSpeech,
        model: "kokoro",
        voice: "af_heart",
        responseFormat: "wav",
        speed: 1.25,
      }),
      {
        model: "kokoro",
        input: "Read this back.",
        voice: "af_heart",
        response_format: "wav",
        speed: 1.25,
      },
    );
  }),
);

it.effect("sends optional bearer auth and returns provider audio", () => {
  let observedRequest: Request | null = null;
  const layer = makeLayer(
    {
      enabled: true,
      endpoint: "https://speech.example.test/v1/audio/speech",
      apiKey: "server-only-key",
      apiKeyRedacted: true,
      model: "tts-1",
      voice: "alloy",
      responseFormat: "mp3",
      speed: 1,
    },
    (request) =>
      Effect.gen(function* () {
        observedRequest = yield* HttpClientRequest.toWeb(request).pipe(Effect.orDie);
        return HttpClientResponse.fromWeb(
          request,
          new Response(new Uint8Array([1, 2, 3]), {
            status: 200,
            headers: { "content-type": "audio/mpeg" },
          }),
        );
      }),
  );

  return Effect.gen(function* () {
    const audio = yield* synthesizeTextToSpeech("Hello from T3 Code.");
    assert.deepEqual(Array.from(audio.bytes), [1, 2, 3]);
    assert.equal(audio.contentType, "audio/mpeg");
    assert.isNotNull(observedRequest);
    assert.equal(observedRequest!.url, "https://speech.example.test/v1/audio/speech");
    assert.equal(observedRequest!.headers.get("authorization"), "Bearer server-only-key");
    const requestBody = yield* Effect.promise(() => observedRequest!.clone().json());
    assert.deepEqual(requestBody, {
      model: "tts-1",
      input: "Hello from T3 Code.",
      voice: "alloy",
      response_format: "mp3",
      speed: 1,
    });
  }).pipe(Effect.provide(layer));
});

it.effect("omits authorization and falls back to the configured audio MIME type", () => {
  let authorization: string | null = "not-observed";
  const layer = makeLayer(
    {
      enabled: true,
      endpoint: "http://127.0.0.1:8880/v1/audio/speech",
      responseFormat: "wav",
    },
    (request) => {
      authorization = request.headers.authorization ?? null;
      return Effect.succeed(
        HttpClientResponse.fromWeb(request, new Response(new Uint8Array([82, 73, 70, 70]))),
      );
    },
  );

  return Effect.gen(function* () {
    const audio = yield* synthesizeTextToSpeech("Local Kokoro.");
    assert.equal(authorization, null);
    assert.equal(audio.contentType, "audio/wav");
  }).pipe(Effect.provide(layer));
});

it.effect("rejects disabled, missing, malformed, failed, and non-audio providers", () => {
  const neverExecute = () => Effect.die("HTTP should not execute.");

  return Effect.gen(function* () {
    const disabled = yield* Effect.flip(
      synthesizeTextToSpeech("Hello").pipe(
        Effect.provide(makeLayer({ enabled: false }, neverExecute)),
      ),
    );
    assertTextToSpeechError(disabled);
    assert.equal(disabled.reason, "disabled");

    const missing = yield* Effect.flip(
      synthesizeTextToSpeech("Hello").pipe(
        Effect.provide(makeLayer({ enabled: true, endpoint: "" }, neverExecute)),
      ),
    );
    assertTextToSpeechError(missing);
    assert.equal(missing.reason, "endpoint_missing");

    const invalid = yield* Effect.flip(
      synthesizeTextToSpeech("Hello").pipe(
        Effect.provide(makeLayer({ enabled: true, endpoint: "file:///tmp/speech" }, neverExecute)),
      ),
    );
    assertTextToSpeechError(invalid);
    assert.equal(invalid.reason, "endpoint_invalid");

    const rejected = yield* Effect.flip(
      synthesizeTextToSpeech("Hello").pipe(
        Effect.provide(
          makeLayer(
            { enabled: true, endpoint: "https://speech.example.test/v1/audio/speech" },
            (request) =>
              Effect.succeed(
                HttpClientResponse.fromWeb(
                  request,
                  Response.json({ error: "bad request" }, { status: 400 }),
                ),
              ),
          ),
        ),
      ),
    );
    assertTextToSpeechError(rejected);
    assert.equal(rejected.reason, "provider_rejected");
    assert.equal(rejected.status, 400);

    const invalidResponse = yield* Effect.flip(
      synthesizeTextToSpeech("Hello").pipe(
        Effect.provide(
          makeLayer(
            { enabled: true, endpoint: "https://speech.example.test/v1/audio/speech" },
            (request) =>
              Effect.succeed(
                HttpClientResponse.fromWeb(request, Response.json({ unexpected: true })),
              ),
          ),
        ),
      ),
    );
    assertTextToSpeechError(invalidResponse);
    assert.equal(invalidResponse.reason, "response_invalid");
  });
});
