import type { RealtimeVoiceTranscriptItem } from "@shuv2code/client-runtime/state/realtime-voice";

export function VoiceTranscript(props: {
  readonly items: ReadonlyArray<RealtimeVoiceTranscriptItem>;
}) {
  const finalItems = props.items.filter((item) => item.final);
  return (
    <div className="max-h-36 space-y-1 overflow-y-auto px-3 py-2 text-xs">
      {props.items.length === 0 ? (
        <p className="text-muted-foreground">Your voice transcript will appear here.</p>
      ) : (
        props.items.map((item) => (
          <p
            key={item.id}
            className={item.final ? "text-foreground" : "text-muted-foreground"}
            aria-hidden={!item.final}
          >
            <span className="font-medium">{item.speaker === "user" ? "You" : "Controller"}:</span>{" "}
            {item.text}
          </p>
        ))
      )}
      <div className="sr-only" aria-live="polite" aria-atomic="true">
        {finalItems.at(-1)?.text ?? ""}
      </div>
    </div>
  );
}
