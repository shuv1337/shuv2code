import Foundation
import Observation
import T3WatchKit

/// One paired server's last fetched page. Each server refreshes independently, so an offline one
/// shows its last known state without holding up the others.
struct ServerFeed {
  var client: WatchClient
  var threads: [WatchThreadSummary] = []
  var fetchedAt: Date?
  var refreshError: String?
  var authRejected = false
}

/// Thread IDs are environment-local, so a thread is addressed by its server too.
struct ThreadRef: Hashable {
  var serverId: String
  var threadId: String
}

/// Read-only viewer for paired environments. It reuses the Watch HTTP API and pairing, and never
/// submits commands.
@MainActor @Observable
final class TVModel {
  private(set) var accounts = WatchEnvironmentAccounts()
  private(set) var feeds: [String: ServerFeed] = [:]
  private(set) var startupError: String?
  private(set) var pairing: PairingSession.State = .idle
  /// Shows setup over the dashboard while another server is paired.
  var addingServer = false
  /// Captured while waiting: the runner has moved to `.exchanging` by the time the exchange runs.
  private var pairingLabel: String?

  /// The Watch API is request/response only, so the dashboard polls while it is on screen.
  static let refreshInterval: Duration = .seconds(5)

  private let accountStore: any EnvironmentAccountStore
  private var pairingTask: Task<Void, Never>?

  init(accountStore: any EnvironmentAccountStore = KeychainEnvironmentAccountStore()) {
    self.accountStore = accountStore
    do {
      accounts = try accountStore.load() ?? WatchEnvironmentAccounts()
    } catch {
      startupError = "Could not load paired servers: \(error.localizedDescription)"
    }
    for account in accounts.accounts { feeds[account.id] = Self.feed(for: account) }
    #if DEBUG
      // See SetupView: `-S2CodeTVPairOrigin` pairs that origin when it is not paired yet.
      if let origin = UserDefaults.standard.string(forKey: "S2CodeTVPairOrigin"),
        let url = try? Self.parseOrigin(origin),
        !accounts.accounts.contains(where: { $0.credentials.origin == url })
      {
        addingServer = true
      }
    #endif
  }

  var servers: [WatchEnvironmentAccount] { accounts.accounts }

  func thread(_ ref: ThreadRef) -> WatchThreadSummary? {
    feeds[ref.serverId]?.threads.first { $0.threadId == ref.threadId }
  }

  // MARK: Pairing

  /// Shows a code on the TV to approve on the server with `pair --watch --approve CODE`.
  func startPairing(origin: String) throws {
    let url = try Self.parseOrigin(origin)
    pairingTask?.cancel()
    let previous = pairingTask
    let session = PairingSession().applying(.start(origin: url), now: Date())
    pairing = session.state
    let runner = PairingRunner(store: nil, clientLabel: "S2Code Apple TV")
    pairingTask = Task { [weak self] in
      await previous?.value
      _ = await runner.run(
        session,
        exchange: { [weak self] origin, credential in
          guard let self else { throw CancellationError() }
          try await self.completePairing(origin: origin, credential: credential)
        },
        update: { [weak self] state in await self?.setPairing(state) })
    }
  }

  func cancelPairing() {
    pairingTask?.cancel()
    pairingTask = nil
    pairing = .idle
    pairingLabel = nil
  }

  private func setPairing(_ state: PairingSession.State) {
    pairing = state
    if case .waitingForApproval(let pending, _) = state { pairingLabel = pending.environment.label }
  }

  /// The bootstrap credential is single-use: a failure after the exchange means pairing again.
  private func completePairing(origin: URL, credential: String) async throws {
    var credentials = try await WatchClient.exchange(
      origin: origin, credential: credential, clientLabel: "S2Code Apple TV", deviceType: "unknown")
    let probe = WatchClient(baseURL: origin, credentials: InMemoryCredentialStore(credentials))
    let capabilities = try await probe.capabilities()
    try Task.checkCancellation()
    credentials.environmentId = capabilities.environmentId
    let label = pairingLabel ?? origin.host() ?? "Server"
    let account = WatchEnvironmentAccount(credentials: credentials, label: label, mode: .direct)
    var next = accounts
    let replaced = next.accounts.filter {
      $0.id == account.id || $0.credentials.origin == account.credentials.origin
    }
    next.upsert(account)
    try accountStore.save(next)
    accounts = next
    for old in replaced { feeds[old.id] = nil }
    feeds[account.id] = Self.feed(for: account)
    addingServer = false
    await refresh(account.id)
  }

  /// Forgets a server on this TV. Its session stays valid on the server until revoked there.
  func forget(_ id: String) {
    var next = accounts
    next.remove(id)
    do {
      try accountStore.save(next)
    } catch {
      startupError = "Could not forget the server: \(error.localizedDescription)"
      return
    }
    accounts = next
    feeds[id] = nil
    if accounts.accounts.isEmpty { cancelPairing() }
  }

  // MARK: Refresh

  func refreshLoop() async {
    while !Task.isCancelled {
      await withTaskGroup(of: Void.self) { group in
        for id in feeds.keys { group.addTask { await self.refresh(id) } }
      }
      try? await Task.sleep(for: Self.refreshInterval)
    }
  }

  func refresh(_ id: String) async {
    guard let feed = feeds[id], !feed.authRejected else { return }
    let client = feed.client
    do throws(WatchClientError) {
      let page = try await client.threads(limit: WatchLimits.maxThreadPageSize)
      // Forgotten or re-paired while the request was in flight.
      guard feeds[id]?.client.baseURL == client.baseURL else { return }
      feeds[id]?.threads = page.items
      feeds[id]?.fetchedAt = Date()
      feeds[id]?.refreshError = nil
    } catch {
      guard feeds[id]?.client.baseURL == client.baseURL else { return }
      if error.isUnauthorized { feeds[id]?.authRejected = true }
      feeds[id]?.refreshError = error.localizedDescription
    }
  }

  private static func feed(for account: WatchEnvironmentAccount) -> ServerFeed {
    ServerFeed(
      client: WatchClient(
        baseURL: account.credentials.origin,
        credentials: InMemoryCredentialStore(account.credentials)))
  }

  static func parseOrigin(_ origin: String) throws -> URL {
    let trimmed = origin.trimmingCharacters(in: .whitespacesAndNewlines)
    guard let url = URL(string: trimmed.contains("://") ? trimmed : "http://\(trimmed)"),
      url.host() != nil
    else { throw OriginError() }
    return url
  }
}

struct OriginError: LocalizedError {
  var errorDescription: String? { "Enter the server URL, for example http://host:13773." }
}
