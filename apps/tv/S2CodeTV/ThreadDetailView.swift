import SwiftUI
import T3WatchKit

/// Reads the dashboard's polled snapshot; a thread that drops out of the page keeps its last state.
struct ThreadDetailView: View {
  let model: TVModel
  let ref: ThreadRef
  @State private var lastKnown: WatchThreadSummary?

  var body: some View {
    TimelineView(.periodic(from: .now, by: freshnessTick)) { context in
      if let thread = model.thread(ref) ?? lastKnown {
        content(thread, now: context.date)
      } else {
        Text("This thread is no longer available.").foregroundStyle(.secondary)
      }
    }
    .onChange(of: model.thread(ref), initial: true) { _, thread in
      if let thread { lastKnown = thread }
    }
  }

  private func content(_ thread: WatchThreadSummary, now: Date) -> some View {
    let missing = model.thread(ref) == nil
    return ScrollView {
      VStack(alignment: .leading, spacing: 36) {
        VStack(alignment: .leading, spacing: 12) {
          Text(thread.labels.thread).font(.largeTitle.bold())
          Text("\(thread.labels.project ?? "No project") · \(thread.labels.environment)")
            .foregroundStyle(.secondary)
        }
        HStack(spacing: 40) {
          ActivityBadge(
            activity: thread.activity,
            isStale: missing || isStale(fetchedAt: model.feeds[ref.serverId]?.fetchedAt, now: now))
          AttentionBadge(attention: thread.pendingAttention)
          if thread.queuedCount > 0 {
            Label("\(thread.queuedCount) queued", systemImage: "tray.full").font(.caption)
          }
          Text(thread.provider).font(.caption).foregroundStyle(.secondary)
          Text("Updated \(ageLabel(since: thread.updatedAt, now: now))")
            .font(.caption).foregroundStyle(.secondary)
        }
        if missing {
          Text("No longer in the thread list · last known state").foregroundStyle(.yellow)
        }
        // Focusable so the remote can scroll long excerpts.
        Button {
        } label: {
          VStack(alignment: .leading, spacing: 16) {
            Text("Latest reply").font(.caption).foregroundStyle(.secondary)
            Text(thread.latestAssistantExcerpt ?? "No reply yet.")
              .font(.title3)
              .frame(maxWidth: .infinity, alignment: .leading)
          }
          .padding(40)
        }
        .buttonStyle(.card)
      }
      .padding(80)
    }
  }
}
