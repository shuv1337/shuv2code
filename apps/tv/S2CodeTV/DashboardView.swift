import SwiftUI
import T3WatchKit

struct DashboardView: View {
  let model: TVModel
  @State private var showingServers = false
  @Environment(\.scenePhase) private var scenePhase

  var body: some View {
    NavigationStack {
      TimelineView(.periodic(from: .now, by: freshnessTick)) { context in
        ScrollView {
          VStack(alignment: .leading, spacing: 40) {
            HStack(alignment: .firstTextBaseline) {
              VStack(alignment: .leading, spacing: 8) {
                Text("S2Code").font(.largeTitle.bold())
                Text(summary).font(.callout).foregroundStyle(.secondary)
              }
              Spacer()
              Button("Servers") { showingServers = true }
            }
            ForEach(model.servers) { server in
              if let feed = model.feeds[server.id] {
                section(server, feed: feed, now: context.date)
              }
            }
          }
          .padding(.horizontal, 80)
          .padding(.vertical, 40)
        }
      }
      .navigationDestination(for: ThreadRef.self) { ref in
        ThreadDetailView(model: model, ref: ref)
      }
    }
    // Polls only while the app is frontmost; a backgrounded TV should not keep hitting servers.
    .task(id: scenePhase == .active ? model.servers.map(\.id) : []) {
      guard scenePhase == .active else { return }
      await model.refreshLoop()
    }
    .sheet(isPresented: $showingServers) { ServersView(model: model) }
  }

  private var summary: String {
    let threads = model.feeds.values.flatMap(\.threads)
    let running = threads.filter { $0.activity == .running }.count
    let attention = threads.filter { $0.pendingAttention.needsAttention }.count
    var parts = ["Read only", "\(running) running"]
    if attention > 0 { parts.append("\(attention) need attention") }
    if model.servers.count > 1 { parts.append("\(model.servers.count) servers") }
    return parts.joined(separator: " · ")
  }

  private func section(_ server: WatchEnvironmentAccount, feed: ServerFeed, now: Date) -> some View {
    VStack(alignment: .leading, spacing: 0) {
      VStack(alignment: .leading, spacing: 6) {
        Text(title(server)).font(.title2.bold())
        Text(status(feed, now: now)).font(.callout).foregroundStyle(.secondary)
      }
      if feed.threads.isEmpty {
        Group {
          if feed.authRejected {
            Text("This server rejected the TV's session. Forget it in Servers and pair again.")
          } else if feed.fetchedAt == nil {
            ProgressView(feed.refreshError ?? "Loading threads…")
          } else {
            Text("No threads yet.")
          }
        }
        .foregroundStyle(.secondary)
      } else {
        // One shelf per server keeps every server on screen however many threads each has.
        ScrollView(.horizontal) {
          LazyHStack(spacing: 40) {
            ForEach(feed.threads) { thread in
              NavigationLink(value: ThreadRef(serverId: server.id, threadId: thread.threadId)) {
                ThreadCard(
                  thread: thread, now: now, isStale: isStale(fetchedAt: feed.fetchedAt, now: now))
              }
              .buttonStyle(.card)
              .frame(width: 520)
            }
          }
          .padding(.vertical, 40)
        }
        .scrollClipDisabled()
      }
    }
  }

  /// Servers often share a host label, so a clashing one also shows where it lives.
  private func title(_ server: WatchEnvironmentAccount) -> String {
    let clashes = model.servers.contains { $0.id != server.id && $0.label == server.label }
    guard clashes, let host = server.credentials.origin.host() else { return server.label }
    let port = server.credentials.origin.port.map { ":\($0)" } ?? ""
    return "\(server.label) · \(host)\(port)"
  }

  private func status(_ feed: ServerFeed, now: Date) -> String {
    if feed.authRejected { return "Session rejected · pair again" }
    if let error = feed.refreshError {
      return feed.fetchedAt == nil ? error : "Offline · last known state"
    }
    guard let fetchedAt = feed.fetchedAt else { return "Loading" }
    let running = feed.threads.filter { $0.activity == .running }.count
    var parts = ["\(running) running"]
    if isStale(fetchedAt: fetchedAt, now: now) {
      parts.append("updated \(ageLabel(since: fetchedAt, now: now))")
    }
    return parts.joined(separator: " · ")
  }
}

private struct ServersView: View {
  let model: TVModel
  @State private var forgetting: WatchEnvironmentAccount?
  @Environment(\.dismiss) private var dismiss

  var body: some View {
    NavigationStack {
      List {
        Section("Servers on this TV") {
          ForEach(model.servers) { server in
            Button {
              forgetting = server
            } label: {
              VStack(alignment: .leading, spacing: 6) {
                Text(server.label).font(.headline)
                Text(server.credentials.origin.absoluteString)
                  .font(.caption).foregroundStyle(.secondary)
              }
            }
          }
        }
        Button("Add server") {
          dismiss()
          model.addingServer = true
        }
      }
      .navigationTitle("Servers")
    }
    .confirmationDialog(
      "Forget \(forgetting?.label ?? "this server")?",
      isPresented: Binding(get: { forgetting != nil }, set: { if !$0 { forgetting = nil } }),
      presenting: forgetting
    ) { server in
      Button("Forget", role: .destructive) {
        model.forget(server.id)
        if model.servers.isEmpty { dismiss() }
      }
    } message: { _ in
      Text("This TV stops showing its threads. Revoke the session on the server to end it there.")
    }
  }
}

private struct ThreadCard: View {
  let thread: WatchThreadSummary
  let now: Date
  let isStale: Bool

  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      HStack {
        ActivityBadge(activity: thread.activity, isStale: isStale)
        Spacer()
        AttentionBadge(attention: thread.pendingAttention)
      }
      Text(thread.labels.thread).font(.headline).lineLimit(2)
        .fixedSize(horizontal: false, vertical: true)
      Text(thread.labels.project ?? "No project")
        .font(.caption).foregroundStyle(.secondary).lineLimit(1)
      Text(thread.latestAssistantExcerpt ?? " ")
        .font(.callout).foregroundStyle(.secondary).lineLimit(2)
        .fixedSize(horizontal: false, vertical: true)
        .frame(maxWidth: .infinity, alignment: .leading)
      Spacer(minLength: 0)
      HStack {
        Text(thread.provider).font(.caption2).foregroundStyle(.tertiary)
        Spacer()
        Text(ageLabel(since: thread.updatedAt, now: now)).font(.caption2).foregroundStyle(.tertiary)
      }
    }
    .padding(28)
    .frame(height: 340)
  }
}
