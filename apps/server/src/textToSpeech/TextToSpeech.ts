import type { TextToSpeechSettings } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { HttpBody, HttpClient, HttpClientRequest } from "effect/unstable/http";

import * as ServerSettings from "../serverSettings.ts";

export const TextToSpeechErrorReason = Schema.Literals([
  "disabled",
  "endpoint_missing",
  "endpoint_invalid",
  "request_failed",
  "provider_rejected",
  "response_invalid",
]);
export type TextToSpeechErrorReason = typeof TextToSpeechErrorReason.Type;

export class TextToSpeechError extends Schema.TaggedErrorClass<TextToSpeechError>()(
  "TextToSpeechError",
  {
    reason: TextToSpeechErrorReason,
    status: Schema.optional(Schema.Number),
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export interface TextToSpeechAudio {
  readonly bytes: Uint8Array;
  readonly contentType: string;
}

export interface OpenAiSpeechRequest {
  readonly model: string;
  readonly input: string;
  readonly voice: string;
  readonly response_format: string;
  readonly speed: number;
}

export function makeOpenAiSpeechRequest(
  input: string,
  settings: TextToSpeechSettings,
): OpenAiSpeechRequest {
  return {
    model: settings.model,
    input,
    voice: settings.voice,
    response_format: settings.responseFormat,
    speed: settings.speed,
  };
}

function fallbackContentType(responseFormat: string): string {
  switch (responseFormat.toLowerCase()) {
    case "mp3":
      return "audio/mpeg";
    case "opus":
      return "audio/ogg";
    case "aac":
      return "audio/aac";
    case "flac":
      return "audio/flac";
    case "wav":
      return "audio/wav";
    default:
      return "application/octet-stream";
  }
}

function resolveContentType(
  contentType: string | undefined,
  responseFormat: string,
): string | null {
  const normalized = contentType?.split(";", 1)[0]?.trim().toLowerCase();
  if (
    normalized?.startsWith("audio/") ||
    normalized === "application/octet-stream" ||
    normalized === "binary/octet-stream"
  ) {
    return normalized === "binary/octet-stream" ? fallbackContentType(responseFormat) : normalized;
  }
  if (normalized === undefined || normalized.length === 0) {
    return fallbackContentType(responseFormat);
  }
  return null;
}

export const synthesizeTextToSpeech = Effect.fn("synthesizeTextToSpeech")(function* (
  input: string,
) {
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const settings = (yield* serverSettings.getSettings).textToSpeech;
  if (!settings.enabled) {
    return yield* new TextToSpeechError({ reason: "disabled" });
  }
  if (settings.endpoint.length === 0) {
    return yield* new TextToSpeechError({ reason: "endpoint_missing" });
  }

  const endpoint = yield* Effect.try({
    try: () => {
      const url = new URL(settings.endpoint);
      if (url.protocol !== "http:" && url.protocol !== "https:") {
        throw new TypeError("Unsupported text-to-speech endpoint protocol.");
      }
      return url;
    },
    catch: (cause) => new TextToSpeechError({ reason: "endpoint_invalid", cause }),
  });
  const httpClient = yield* HttpClient.HttpClient;
  let request = HttpClientRequest.post(endpoint, {
    body: HttpBody.jsonUnsafe(makeOpenAiSpeechRequest(input, settings)),
  }).pipe(HttpClientRequest.setHeader("accept", "audio/*"));
  if (settings.apiKey.length > 0) {
    request = request.pipe(HttpClientRequest.bearerToken(settings.apiKey));
  }

  const response = yield* httpClient.execute(request).pipe(
    Effect.mapError(
      (cause) =>
        new TextToSpeechError({
          reason: "request_failed",
          cause,
        }),
    ),
  );
  if (response.status < 200 || response.status >= 300) {
    return yield* new TextToSpeechError({
      reason: "provider_rejected",
      status: response.status,
    });
  }

  const contentType = resolveContentType(response.headers["content-type"], settings.responseFormat);
  if (contentType === null) {
    return yield* new TextToSpeechError({
      reason: "response_invalid",
      status: response.status,
    });
  }

  const body = yield* response.arrayBuffer.pipe(
    Effect.mapError(
      (cause) =>
        new TextToSpeechError({
          reason: "response_invalid",
          status: response.status,
          cause,
        }),
    ),
  );
  if (body.byteLength === 0) {
    return yield* new TextToSpeechError({
      reason: "response_invalid",
      status: response.status,
    });
  }
  return {
    bytes: new Uint8Array(body),
    contentType,
  } satisfies TextToSpeechAudio;
});
