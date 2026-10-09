import Foundation
import Observation

@MainActor @Observable final class CompanionModel {
  private(set) var pairing: Pairing?
  private(set) var familiars: [Familiar] = []
  private(set) var sessions: [ChatSession] = []
  private(set) var messages: [Message] = []
  private(set) var selectedId: String?
  private(set) var connected = false
  private(set) var busy = false
  private(set) var hasMore = false
  private(set) var activeRun: Run?
  private(set) var pendingRunId: String?
  private(set) var error = ""
  private(set) var needsPairingCleanup = false
  private(set) var historyRunId: String?
  private var retainedRun: Run?
  private var terminalError = ""
  private(set) var status = "Connect to your Mac"
  private var drafts: [String: String] = [:]
  private var sessionId: String?
  private var historyReady = false
  private var generation = 0
  private var selection = 0
  private var refreshing = false
  private var submittedDraft: (familiar: String, text: String)?
  @ObservationIgnored private let store: PairingStore
  @ObservationIgnored private let makeClient: @MainActor (Pairing) -> CompanionClient
  @ObservationIgnored private var client: CompanionClient?

  init(
    store: PairingStore,
    makeClient: @escaping @MainActor (Pairing) -> CompanionClient = { PinnedAPI(pairing: $0) }
  ) {
    self.store = store
    self.makeClient = makeClient
    do {
      pairing = try store.load()
      if let pairing {
        client = makeClient(pairing)
        status = "Reconnecting to your Mac…"
      }
    } catch { self.error = Self.explain(error) }
  }
  var draft: String {
    get { selectedId.flatMap { drafts[$0] } ?? "" }
    set { if let selectedId { drafts[selectedId] = newValue } }
  }
  var archived: Bool { sessions.first(where: { $0.familiarId == selectedId })?.archived == true }
  var canSend: Bool {
    connected && historyReady && selectedId != nil && !archived && !busy
      && activeRun?.running != true && pendingRunId == nil
      && !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && draft.utf8.count <= 32768
  }
  var shownRun: Run? {
    retainedRun?.familiarId == selectedId && retainedRun?.id == historyRunId ? retainedRun : nil
  }

  func pair(link: String) async {
    guard !busy else { return }
    busy = true
    error = ""
    let expected = generation
    var candidate: CompanionClient?
    do {
      let next = try Pairing.parse(link)
      let api = makeClient(next)
      candidate = api
      let snapshot = try await api.snapshot()
      guard generation == expected else {
        api.invalidate()
        return
      }
      guard snapshot.version == 1 else {
        throw CompanionError.message("Update both Chat apps before pairing.")
      }
      try store.save(next)
      needsPairingCleanup = false
      client?.invalidate()
      client = api
      pairing = next
      generation += 1
      selection += 1
      clearConversation()
      apply(snapshot)
      connected = true
      status = "Connected to your Mac"
    } catch {
      candidate?.invalidate()
      if generation == expected { self.error = Self.explain(error) }
    }
    busy = false
    if connected { await readSelection() }
  }
  func refresh() async {
    guard let api = client, !refreshing, !busy else { return }
    refreshing = true
    let expected = generation
    defer { if generation == expected { refreshing = false } }
    do {
      let snapshot = try await api.snapshot()
      guard generation == expected else { return }
      guard snapshot.version == 1 else {
        throw CompanionError.message("Update both Chat apps before connecting.")
      }
      apply(snapshot)
      connected = true
      status = "Connected to your Mac"
      error = terminalError
      if let id = pendingRunId {
        do {
          let run = try await api.run(id: id)
          guard generation == expected else { return }
          accept(run)
        } catch CompanionError.missingRun {
          guard generation == expected else { return }
          // Keep the uncertain send blocked until the user has inspected history.
          self.error = CompanionError.missingRun.localizedDescription
        }
      }
      await readSelection()
    } catch {
      guard generation == expected else { return }
      handle(error)
    }
  }
  func select(_ id: String) async {
    guard familiars.contains(where: { $0.id == id }) else { return }
    selection += 1
    selectedId = id
    messages = []
    sessionId = nil
    historyReady = false
    hasMore = false
    await readSelection()
  }
  private func readSelection() async {
    guard let api = client, let id = selectedId, connected else { return }
    let expected = generation
    let chosen = selection
    do {
      let history = try await api.history(familiarId: id)
      guard generation == expected, selection == chosen, selectedId == id else { return }
      messages = history.messages
      sessionId = history.sessionId
      hasMore = history.hasMore
      historyReady = true
      historyRunId = history.activeRunId
      if history.activeRunId == nil { retainedRun = nil }
    } catch {
      guard generation == expected, selection == chosen else { return }
      historyReady = false
      handle(error)
    }
  }
  func send() async {
    guard canSend, let api = client, let id = selectedId else { return }
    let request = SendRequest(
      requestId: UUID().uuidString.lowercased(), familiarId: id, sessionId: sessionId, prompt: draft
    )
    let expected = generation
    submittedDraft = (id, draft)
    pendingRunId = request.requestId
    historyRunId = request.requestId
    terminalError = ""
    busy = true
    error = ""
    do {
      let run = try await api.send(request)
      guard generation == expected else { return }
      accept(run)
      if drafts[id] == request.prompt { drafts[id] = "" }
    } catch {
      guard generation == expected else { return }
      handle(error)
      if pairing != nil {
        self.error =
          "Delivery is uncertain. Reconnecting will check this send without sending it again."
      }
    }
    if generation == expected { busy = false }
  }
  func stop() async {
    guard let api = client, let run = activeRun, run.running, !busy else { return }
    busy = true
    let expected = generation
    do { try await api.stop(id: run.id) } catch { if generation == expected { handle(error) } }
    if generation == expected { busy = false }
    await refresh()
  }
  /// Explicitly dismisses only an unresolved receipt after the user inspects the chat.
  func dismissUncertainSend() {
    pendingRunId = nil
    submittedDraft = nil
    error = ""
    terminalError = ""
  }
  func forget() {
    var cleanupError = ""
    do {
      try store.clear()
      needsPairingCleanup = false
    } catch {
      needsPairingCleanup = true
      cleanupError =
        "Connection closed, but the saved pairing could not be removed. Retry forgetting this Mac before closing Chat."
    }
    generation += 1
    selection += 1
    client?.invalidate()
    client = nil
    pairing = nil
    busy = false
    refreshing = false
    connected = false
    clearConversation()
    status = "Connect to your Mac"
    error = cleanupError
  }
  /// Discovery supplies a candidate only; authenticate it before changing the saved address.
  func tryEndpoint(_ endpoint: URL) async {
    guard !refreshing, !busy, let saved = pairing, endpoint != saved.endpoint,
      Pairing.validEndpoint(endpoint)
    else { return }
    let expected = generation
    let next = Pairing(endpoint: endpoint, token: saved.token, fingerprint: saved.fingerprint)
    let api = makeClient(next)
    do {
      let snapshot = try await api.snapshot()
      guard generation == expected, pairing == saved, !busy, !refreshing, snapshot.version == 1
      else {
        api.invalidate()
        return
      }
      try store.save(next)
      needsPairingCleanup = false
      client?.invalidate()
      client = api
      pairing = next
      generation += 1
      refreshing = false
      connected = true
      apply(snapshot)
      await refresh()
    } catch { api.invalidate() }  // Keep the last verified address on discovery failures.
  }
  private func apply(_ snapshot: Snapshot) {
    familiars = snapshot.familiars
    sessions = snapshot.sessions
    if !familiars.contains(where: { $0.id == selectedId }) {
      selectedId = familiars.first?.id
      selection += 1
      historyReady = false
      messages = []
      sessionId = nil
    }
    if let run = snapshot.activeRun {
      activeRun = run
      retainedRun = run
    } else {
      activeRun = nil
    }
  }
  private func accept(_ run: Run) {
    activeRun = run
    retainedRun = run
    if let submitted = submittedDraft, drafts[submitted.familiar] == submitted.text {
      drafts[submitted.familiar] = ""
    }
    if !run.running {
      pendingRunId = nil
      submittedDraft = nil
      terminalError = run.error ?? ""
      error = terminalError
    }
  }
  private func handle(_ failure: Error) {
    if case CompanionError.revoked = failure {
      forget()
      error = CompanionError.revoked.localizedDescription
    } else {
      connected = false
      status = "Mac unreachable — reconnecting…"
      error = Self.explain(failure)
    }
  }
  private func clearConversation() {
    familiars = []
    sessions = []
    messages = []
    selectedId = nil
    drafts = [:]
    activeRun = nil
    pendingRunId = nil
    submittedDraft = nil
    historyReady = false
    sessionId = nil
    hasMore = false
    historyRunId = nil
    retainedRun = nil
    terminalError = ""
  }
  private static func explain(_ error: Error) -> String {
    if let known = error as? CompanionError { return known.localizedDescription }
    return
      "Could not reach your Mac securely. Keep Chat running on the same network, then try again."
  }
}
