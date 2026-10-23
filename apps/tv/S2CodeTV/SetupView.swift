import SwiftUI
import T3WatchKit

struct SetupView: View {
  let model: TVModel
  @State private var origin = ""
  @State private var error: String?

  var body: some View {
    VStack(spacing: 48) {
      Text("S2Code").font(.largeTitle.bold())
      switch model.pairing {
      case .waitingForApproval(let pending, _):
        approval(pending)
      case .starting, .approved, .exchanging:
        ProgressView("Connecting…")
        Button("Cancel") { model.cancelPairing() }
      default:
        entry
      }
    }
    .frame(maxWidth: 1100)
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    #if DEBUG
      // Simulators cannot drive the tvOS keyboard: `-S2CodeTVPairOrigin http://host:port`.
      .task {
        if let origin = UserDefaults.standard.string(forKey: "S2CodeTVPairOrigin") {
          try? model.startPairing(origin: origin)
        }
      }
    #endif
  }

  private var entry: some View {
    VStack(spacing: 32) {
      Text(
        model.servers.isEmpty
          ? "Watch your agents from the couch. Enter your server's URL to pair this Apple TV."
          : "Enter another server's URL to add it to this Apple TV."
      )
        .multilineTextAlignment(.center)
        .foregroundStyle(.secondary)
      TextField("http://host:13773", text: $origin)
        .textContentType(.URL)
        .keyboardType(.URL)
        .textInputAutocapitalization(.never)
        .autocorrectionDisabled()
      Button("Pair") {
        do {
          error = nil
          try model.startPairing(origin: origin)
        } catch {
          self.error = error.localizedDescription
        }
      }
      .disabled(origin.trimmingCharacters(in: .whitespaces).isEmpty)
      if !model.servers.isEmpty {
        Button("Cancel") {
          model.cancelPairing()
          model.addingServer = false
        }
      }
      if let message = error ?? outcome ?? model.startupError {
        Text(message).foregroundStyle(.secondary).multilineTextAlignment(.center)
      }
    }
  }

  private func approval(_ pending: PairingSession.Pending) -> some View {
    VStack(spacing: 32) {
      Text("Approve this TV on \(pending.environment.label)")
        .font(.title2)
      Text(pending.userCode)
        .font(.system(size: 120, weight: .bold, design: .monospaced))
      Text("shuv2code pair --watch --approve \(pending.userCode)")
        .font(.body.monospaced())
        .foregroundStyle(.secondary)
      Button("Cancel") { model.cancelPairing() }
    }
  }

  private var outcome: String? {
    switch model.pairing {
    case .denied: "The server denied pairing."
    case .expired: "The pairing code expired. Pair again."
    case .failed(let message): message
    default: nil
    }
  }
}
