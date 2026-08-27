/**
 * One bot's conversation on a phone (spec §7 slice 1, §4.1).
 *
 * Two things this screen deliberately does *not* do:
 *
 *  1. **It does not render a timeline.** An ADE bot chat is an ordinary
 *     shuv2code thread, so once the session is live this hands straight over to
 *     `ThreadRouteScreen` — the same feed, composer, approvals, attachments and
 *     keyboard handling every other thread gets. A second mobile timeline for
 *     bots would be a second set of bugs.
 *  2. **It does not re-decide when a conversation is safe to mount.** The
 *     connect/sync state machine is `@shuv2code/client-runtime/ade/bot-chat`,
 *     shared verbatim with the web captain surface.
 *
 * §4.1's rules hold as they do on web: opening the conversation *is* the
 * request to connect, and the app is never gated on kernels — a refusal is a
 * compact notice with a Retry, never a dead end.
 */
import { squashAtomCommandFailure } from "@shuv2code/client-runtime/state/runtime";
import {
  botChatModelNotice,
  botChatStartNotice,
  BOT_CHAT_TOOLS_MISSING_NOTICE,
  canAutoConnect,
  getBotChatBody,
  getBotChatHeaderView,
  resolveBotChatConnectState,
  resolveChatSyncOutcome,
  shouldAutoStartChat,
  shouldWarnToolsMissing,
  type BotChatConnectNotice,
} from "@shuv2code/client-runtime/ade/bot-chat";
import { BotId, EnvironmentId, type ScopedThreadRef, type ThreadId } from "@shuv2code/contracts";
import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Pressable, ScrollView, View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { LoadingScreen } from "../../components/LoadingScreen";
import { NativeStackScreenOptions } from "../../native/StackHeader";
import { useAdeBotDetail, useAdeKernelHealth, useAdeRoster, adeEnvironment } from "../../state/ade";
import { useThreadShell } from "../../state/entities";
import { useAtomCommand } from "../../state/use-atom-command";
import { ThreadRouteScreen } from "../threads/ThreadRouteScreen";
import { BotAvatar } from "./BotAvatar";
import { useBotChatRead } from "./useBotChatRead";
import { getBotAvatarView } from "@shuv2code/client-runtime/ade/contact-rail";

type BotChatRouteProps = StaticScreenProps<{
  readonly environmentId: string;
  readonly botId: string;
  /**
   * Written back by this screen once `startBotChat` names the thread.
   *
   * It is a route param rather than local state because the thread surface
   * resolves its selection from the *route* (`useThreadSelection`), and this
   * screen hosts that surface rather than pushing to it — pushing would put a
   * second entry on the stack for one conversation, so Back would land the
   * captain on a connect screen that immediately reconnects.
   */
  readonly threadId?: string;
}>;

export function BotChatRouteScreen(props: BotChatRouteProps) {
  const navigation = useNavigation();
  const environmentId = EnvironmentId.make(props.route.params.environmentId);
  const botId = BotId.make(props.route.params.botId);
  const routeThreadId = props.route.params.threadId ?? null;

  const detail = useAdeBotDetail(environmentId, botId);
  const roster = useAdeRoster(environmentId);
  const kernelHealth = useAdeKernelHealth(environmentId);
  const startChat = useAtomCommand(adeEnvironment.startBotChat, { reportFailure: false });

  const [startedThreadId, setStartedThreadId] = useState<ThreadId | null>(null);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [syncElapsedMs, setSyncElapsedMs] = useState(0);
  const [startError, setStartError] = useState<BotChatConnectNotice | null>(null);
  const [toolsMissing, setToolsMissing] = useState(false);
  const [modelNotice, setModelNotice] = useState<BotChatConnectNotice | null>(null);

  const body = getBotChatBody({
    detail: detail.data,
    startedThreadId,
    loadError: detail.error ?? roster.error,
  });
  const header = detail.data === null ? null : getBotChatHeaderView(detail.data);
  const chatThreadId = body.kind === "chat" ? body.threadId : null;

  const threadRef = useMemo<ScopedThreadRef | null>(
    () => (chatThreadId === null ? null : { environmentId, threadId: chatThreadId }),
    [chatThreadId, environmentId],
  );
  const threadShell = useThreadShell(threadRef);

  // Tick only while waiting, so the bounded fallback can fire without making
  // the screen re-render forever once it has settled.
  useEffect(() => {
    if (startedAt === null || threadShell !== null) return;
    const timer = setInterval(() => setSyncElapsedMs(Date.now() - startedAt), 1_000);
    return () => clearInterval(timer);
  }, [startedAt, threadShell]);

  const syncOutcome =
    threadRef === null
      ? ({ kind: "waiting" } as const)
      : resolveChatSyncOutcome({
          /*
           * Mobile has no `resolveThreadRouteRenderState`; the shell snapshot
           * is what `ThreadRouteScreen` itself gates on, so the same fact is
           * fed in here. `missing` is never asserted — the phone cannot tell a
           * deleted thread from an unsynced one, and claiming the stronger of
           * the two would strand a reconnecting captain on a dead end. The
           * elapsed-time fallback is what supplies the exit instead.
           */
          renderState: threadShell === null ? "loading" : "ready",
          threadShellExists: threadShell !== null,
          elapsedMs: syncElapsedMs,
        });
  const chatReady = threadRef !== null && syncOutcome.kind === "ready";

  /*
   * Hand the resolved thread to the route so the thread surface — which
   * resolves its selection from route params — can find it.
   */
  useEffect(() => {
    if (chatThreadId === null || routeThreadId === String(chatThreadId)) return;
    navigation.setParams({ threadId: String(chatThreadId) });
  }, [chatThreadId, navigation, routeThreadId]);

  const rosterEntry = roster.data?.entries.find((entry) => entry.bot.id === botId);
  useBotChatRead({
    environmentId,
    botId,
    chatReady,
    unreadCount: rosterEntry?.unreadCount ?? 0,
    lastMessageAt: rosterEntry?.lastMessage?.at ?? null,
  });

  const connectState = resolveBotChatConnectState({
    body,
    syncOutcome,
    startError,
    chatReady,
    /*
     * `kernelHealth === null` is "no snapshot yet", not "unhealthy". Treating
     * it as blocked would flash the failure notice on every cold load in the
     * moment before the first health frame arrives.
     */
    autoConnectBlocked:
      kernelHealth !== null && !canAutoConnect(kernelHealth) && startedThreadId === null,
  });

  const handleStart = useCallback(async () => {
    setStartError(null);
    const result = await startChat({ environmentId, input: { botId } });
    if (result._tag === "Failure") {
      setStartError(botChatStartNotice(squashAtomCommandFailure(result)));
      setToolsMissing(false);
      setModelNotice(null);
      return;
    }
    setToolsMissing(shouldWarnToolsMissing(result.value));
    setModelNotice(botChatModelNotice(result.value));
    setStartedAt(Date.now());
    setSyncElapsedMs(0);
    setStartedThreadId(result.value.threadId);
  }, [botId, environmentId, startChat]);

  /** The direct connect (#217). The ref is written before the await, so a */
  /* double-invoked mount effect issues exactly one start. */
  const autoStartedFor = useRef<BotId | null>(null);
  useEffect(() => {
    if (
      !shouldAutoStartChat({
        botId,
        environmentReady: true,
        startedFor: autoStartedFor.current,
        kernelHealth,
      })
    ) {
      return;
    }
    autoStartedFor.current = botId;
    void handleStart();
  }, [botId, handleStart, kernelHealth]);

  const retryConnect = useCallback(() => {
    setStartedThreadId(null);
    setStartedAt(null);
    setSyncElapsedMs(0);
    setStartError(null);
    autoStartedFor.current = botId;
    // The notice also covers a failed `ade.getBot` / roster read, which
    // restarting a session does nothing for — so both queries are re-asked.
    detail.refresh();
    roster.refresh();
    void handleStart();
  }, [botId, detail, handleStart, roster]);

  const title = header?.name ?? "Bot";

  if (connectState.kind === "failed") {
    return (
      <>
        <NativeStackScreenOptions options={{ title }} />
        <BotChatFailure
          avatar={
            detail.data === null
              ? null
              : getBotAvatarView({
                  botId: String(botId),
                  name: detail.data.bot.name,
                  displayMeta: detail.data.bot.displayMeta,
                })
          }
          header={header}
          notice={connectState.notice}
          onRetry={retryConnect}
        />
      </>
    );
  }

  if (!chatReady || routeThreadId === null) {
    return (
      <>
        <NativeStackScreenOptions options={{ title }} />
        <LoadingScreen message={`Connecting to ${title}…`} messagePlacement="above-spinner" />
      </>
    );
  }

  return (
    <View className="flex-1 bg-screen">
      {toolsMissing ? <BotChatStrip notice={BOT_CHAT_TOOLS_MISSING_NOTICE} /> : null}
      {modelNotice === null ? null : <BotChatStrip notice={modelNotice} />}
      {/*
       * The ordinary thread surface, addressed at the bot's thread. It reads
       * its own selection from the route, which is why `threadId` was written
       * back above rather than kept in state.
       */}
      <ThreadRouteScreen
        route={{
          params: {
            environmentId: String(environmentId),
            threadId: routeThreadId,
          },
        }}
      />
    </View>
  );
}

/**
 * The compact advisory strip. Never a landing page: the conversation is right
 * underneath it and stays usable (§4.1).
 */
function BotChatStrip({ notice }: { readonly notice: BotChatConnectNotice }) {
  return (
    <View className="border-b border-border bg-card-alt px-5 py-2">
      <Text className="text-sm font-shuv2code-medium text-foreground">{notice.message}</Text>
      {notice.details === null ? null : (
        <Text className="mt-0.5 text-xs text-foreground-muted">{notice.details}</Text>
      )}
    </View>
  );
}

function BotChatFailure(props: {
  readonly avatar: ReturnType<typeof getBotAvatarView> | null;
  readonly header: ReturnType<typeof getBotChatHeaderView> | null;
  readonly notice: BotChatConnectNotice;
  readonly onRetry: () => void;
}) {
  return (
    <ScrollView
      className="bg-screen flex-1"
      contentContainerStyle={{ flexGrow: 1, justifyContent: "center", padding: 24, gap: 16 }}
      contentInsetAdjustmentBehavior="automatic"
    >
      <View className="items-center gap-3">
        {props.avatar === null ? null : <BotAvatar avatar={props.avatar} size={56} />}
        {props.header === null ? null : (
          <Text className="text-xl font-shuv2code-bold text-foreground">{props.header.name}</Text>
        )}
      </View>
      <View className="rounded-[22px] border border-border bg-card p-5">
        <Text className="text-lg font-shuv2code-bold text-foreground">{props.notice.message}</Text>
        {props.notice.details === null ? null : (
          <Text className="mt-2 text-sm leading-relaxed text-foreground-muted">
            {props.notice.details}
          </Text>
        )}
        <Pressable
          accessibilityRole="button"
          className="mt-4 self-start rounded-full bg-primary px-4 py-2.5 active:opacity-70"
          onPress={props.onRetry}
        >
          <Text className="text-sm font-shuv2code-bold text-primary-foreground">Retry</Text>
        </Pressable>
      </View>
    </ScrollView>
  );
}
