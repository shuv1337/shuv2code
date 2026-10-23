import SwiftUI
import T3WatchKit

extension WatchThreadActivity {
  var label: String {
    switch self {
    case .idle: "Idle"
    case .preparing: "Preparing"
    case .queued: "Queued"
    case .starting: "Starting"
    case .running: "Running"
    case .waiting: "Waiting"
    case .completed: "Completed"
    case .interrupted: "Interrupted"
    case .failed: "Failed"
    case .cancelled: "Cancelled"
    case .rolledBack: "Rolled back"
    case .unknown: "Unknown"
    }
  }

  var tint: Color {
    switch self {
    case .running, .starting, .preparing: .green
    case .waiting, .queued: .orange
    case .failed, .interrupted: .red
    case .unknown: .yellow
    default: .secondary
    }
  }
}

struct ActivityBadge: View {
  let activity: WatchThreadActivity
  /// A stale activity is last known, not live, so it loses its colour.
  var isStale = false

  var body: some View {
    Label(activity.label, systemImage: "circle.fill")
      .font(.caption)
      .foregroundStyle(isStale ? Color.secondary : activity.tint)
  }
}

struct AttentionBadge: View {
  let attention: WatchPendingAttention

  var body: some View {
    if attention.runtimeRequest != nil {
      Label("Needs input", systemImage: "hand.raised.fill").font(.caption).foregroundStyle(.orange)
    } else if attention.hasActionableProposedPlan {
      Label("Plan ready", systemImage: "list.bullet.clipboard").font(.caption)
        .foregroundStyle(.orange)
    }
  }
}

/// Coarse ticks for age labels; never per-second repaints.
let freshnessTick: TimeInterval = 15

/// Three missed refreshes: the dashboard shows the last known state rather than a live one.
func isStale(fetchedAt: Date?, now: Date) -> Bool {
  guard let fetchedAt else { return true }
  return now.timeIntervalSince(fetchedAt) > 15
}

func ageLabel(since date: Date, now: Date) -> String {
  let seconds = max(0, Int(now.timeIntervalSince(date)))
  if seconds < 60 { return "just now" }
  if seconds < 3600 { return "\(seconds / 60)m ago" }
  if seconds < 86_400 { return "\(seconds / 3600)h ago" }
  return "\(seconds / 86_400)d ago"
}
