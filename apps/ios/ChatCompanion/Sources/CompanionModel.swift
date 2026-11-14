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
  /// Set while iOS denies Local Network access, so the error can name the setting.
  private(set) var localNetworkDenied = false
  private(set) var historyRunId: String?
  private(set) var approvals: [Approval] = []
  private(set) var answering = false
  private(set) var permissionLog: [PermissionLogEntry]?
  private(set) var permissionLogError: String?
  private var retainedRun: Run?
  private var terminalError = ""
  private(set) var status = "Connect to your Mac"
  private(set) var cachedAt: Date?
  private(set) var persistenceError: String?
  private(set) var cacheConversationText = true
  private var saved: CompanionSavedState?
  private var deletedDisplayFamiliars: Set<String> = []
  private var cleanupNamespace: CacheNamespace?
  @ObservationIgnored private let persistence: CompanionPersistence
  @ObservationIgnored private let installationID: Data
  @ObservationIgnored private let now: () -> Date
  @ObservationIgnored private var saveTask: Task<Void, Never>?
  private var drafts: [String: String] = [:]
  private var sessionId: String?
  private(set) var historyReady = false
  private var generation = 0
  private var selection = 0
  private var refreshing = false
  @ObservationIgnored private let store: PairingStore
  @ObservationIgnored private let makeClient: @MainActor (Pairing) -> CompanionClient
  @ObservationIgnored private let localNetworkBlocks: @MainActor (URL) async -> Bool
  @ObservationIgnored private var client: CompanionClient?

  init(
    store: PairingStore,
    persistence: CompanionPersistence,
    installationID: Data,
    makeClient: @escaping @MainActor (Pairing) -> CompanionClient = { PinnedAPI(pairing: $0) },
    localNetworkBlocks: @escaping @MainActor (URL) async -> Bool = { await LocalNetwork.blocks($0) },
    now: @escaping () -> Date = Date.init
  ) {
    self.store = store
    self.persistence = persistence
    self.installationID = installationID
    self.now = now
    self.makeClient = makeClient
    self.localNetworkBlocks = localNetworkBlocks
    do {
      pairing = try store.load()
      if let pairing {
        client = makeClient(pairing)
        status = "Reconnecting to your Mac…"
        try restoreSavedState(for: pairing)
      } else {
        try persistence.eraseUnpairedData()
      }
    } catch { storageFailed(error) }
  }
  var draft: String {
    get { selectedId.flatMap { drafts[$0] } ?? "" }
    set {
      guard let selectedId else { return }
      drafts[selectedId] = newValue
      let binding = DraftBinding(familiarID: selectedId, sessionID: sessionId)
      saved?.drafts.removeAll { $0.binding == binding }
      if !newValue.isEmpty {
        saved?.drafts.append(SavedDraft(
          binding: binding, text: newValue, revision: UUID(), updatedAt: now(),
          conversationTitle: conversationLabel(for: binding)))
      }
      scheduleSave()
    }
  }
  var archived: Bool { sessions.first(where: { $0.familiarId == selectedId })?.archived == true }
  var canSend: Bool {
    connected && historyReady && persistenceError == nil && selectedId != nil && !archived && !busy
      && activeRun?.running != true && pendingRunId == nil
      && !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && draft.utf8.count <= 32768
  }
  /// The request the selected familiar is waiting on.
  var approval: Approval? { approvals.first { $0.familiarId == selectedId } }
  /// A request from a familiar other than the one on screen.
  var otherApproval: Approval? { approvals.first { $0.familiarId != selectedId } }
  /// Allow starts a run, so it waits for the same things a message would.
  var canAllow: Bool {
    connected && historyReady && persistenceError == nil && !archived && !busy && !answering
      && activeRun?.running != true && pendingRunId == nil
  }
  func name(ofFamiliar id: String) -> String {
    familiars.first { $0.id == id }?.displayName ?? id
  }
  var shownRun: Run? {
    retainedRun?.familiarId == selectedId && retainedRun?.id == historyRunId ? retainedRun : nil
  }

  func pair(link: String) async {
    guard !busy else { return }
    guard pairing == nil, !needsPairingCleanup else {
      error = "Forget the current Mac and finish its phone-data cleanup before pairing again."
      return
    }
    busy = true
    error = ""
    localNetworkDenied = false
    let expected = generation
    var candidate: CompanionClient?
    var attempted: URL?
    do {
      let next = try Pairing.parse(link)
      attempted = next.endpoint
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
      let namespace = CacheNamespace(installationID: installationID, pairing: next)
      let staged: CompanionSavedState
      do {
        staged = try persistence.load(for: namespace) ?? CompanionSavedState(namespace: namespace)
      } catch {
        throw CompanionError.message("Chat could not open protected phone storage. Unlock your iPhone and check its free space before pairing.")
      }
      try store.save(next)
      needsPairingCleanup = false
      client?.invalidate()
      client = api
      candidate = nil
      pairing = next
      generation += 1
      selection += 1
      clearConversation()
      installSavedState(staged)
      apply(snapshot)
      connected = true
      status = "Connected to your Mac"
    } catch {
      candidate?.invalidate()
      if generation == expected { self.error = Self.explain(error) }
      if !(error is CompanionError), let attempted, await localNetworkBlocks(attempted),
        generation == expected
      {
        localNetworkDenied = true
        self.error = Self.localNetworkOff
      }
    }
    busy = false
    if connected { await readSelection() }
  }
  func refresh() async {
    guard let api = client, !refreshing, !busy else { return }
    if saved == nil, let pairing {
      do { try restoreSavedState(for: pairing) } catch { storageFailed(error); return }
    }
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
    hydrateSelection()
    saved?.selectedFamiliarID = id
    flushPersistence()
    await readSelection()
  }
  private func readSelection() async {
    guard let api = client, let id = selectedId, connected else { return }
    let expected = generation
    let chosen = selection
    do {
      let history = try await api.history(familiarId: id)
      guard generation == expected, selection == chosen, selectedId == id else { return }
      if sessionId != history.sessionId {
        drafts[id] = saved?.drafts.first {
          $0.binding == DraftBinding(familiarID: id, sessionID: history.sessionId)
        }?.text ?? ""
      }
      messages = history.messages
      sessionId = history.sessionId
      hasMore = history.hasMore
      historyReady = true
      historyRunId = history.activeRunId
      if history.activeRunId == nil { retainedRun = nil }
      cachedAt = now()
      saved?.conversations.removeAll { $0.familiarID == id }
      saved?.conversations.append(CachedConversation(familiarID: id, history: history, savedAt: now()))
      saved?.selectedFamiliarID = id
      flushPersistence()
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
    guard reserve(requestID: request.requestId, kind: .send, familiar: id,
                  body: request, draftRevision: currentDraftRecord?.revision) else { return }
    pendingRunId = request.requestId
    historyRunId = request.requestId
    terminalError = ""
    busy = true
    error = ""
    do {
      let run = try await api.send(request)
      guard generation == expected else { return }
      accept(run)
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
  /// The person's Allow, already confirmed. It runs like a send: the run outlives
  /// this request, and an uncertain delivery is checked by its ID, never repeated.
  func allow(_ approval: Approval) async {
    guard canAllow, let api = client, approval.familiarId == selectedId else { return }
    let answer = ApprovalAnswer(
      requestId: UUID().uuidString.lowercased(), approvalId: approval.id, decision: "allow")
    guard reserve(requestID: answer.requestId, kind: .allow, familiar: approval.familiarId,
                  body: answer, draftRevision: nil) else { return }
    let expected = generation
    pendingRunId = answer.requestId
    historyRunId = answer.requestId
    terminalError = ""
    busy = true
    error = ""
    do {
      let result = try await api.answer(answer)
      guard generation == expected else { return }
      approvals.removeAll { $0.id == approval.id }
      if let run = result.run {
        accept(run)
      } else {
        settlePending(clearHistory: true)
      }
    } catch CompanionError.message(let refusal) {
      // The Mac answered, so this is certain: no run started.
      guard generation == expected else { return }
      settlePending(clearHistory: true)
      error = refusal
    } catch {
      guard generation == expected else { return }
      handle(error)
      if pairing != nil {
        self.error =
          "Delivery is uncertain. Reconnecting will check this answer without sending it again."
      }
    }
    if generation == expected { busy = false }
  }
  func decline(_ approval: Approval) async {
    guard let api = client, connected, !answering else { return }
    let answer = ApprovalAnswer(
      requestId: UUID().uuidString.lowercased(), approvalId: approval.id, decision: "decline")
    let expected = generation
    answering = true
    error = ""
    do {
      _ = try await api.answer(answer)
      guard generation == expected else { return }
      approvals.removeAll { $0.id == approval.id }
    } catch CompanionError.message(let refusal) {
      guard generation == expected else { return }
      error = refusal
    } catch {
      guard generation == expected else { return }
      handle(error)
    }
    if generation == expected { answering = false }
    await refresh()
  }
  func loadPermissionLog() async {
    guard let api = client else { return }
    let expected = generation
    do {
      let log = try await api.permissionLog()
      guard generation == expected else { return }
      permissionLog = log.entries
      permissionLogError = nil
    } catch {
      guard generation == expected else { return }
      permissionLogError = Self.explain(error)
    }
  }
  /// Explicitly dismisses only an unresolved receipt after the user inspects the chat.
  func dismissUncertainSend() {
    guard settlePending(clearHistory: true) else { return }
    error = ""
    terminalError = ""
  }
  func forget() {
    saveTask?.cancel()
    cleanupNamespace = saved?.namespace ?? cleanupNamespace
    var cleanupError = ""
    var removed = true
    do {
      try store.clear()
    } catch {
      removed = false
    }
    do {
      if let cleanupNamespace { try persistence.erase(for: cleanupNamespace) }
      else { try persistence.eraseUnpairedData() }
      cleanupNamespace = nil
    } catch { removed = false }
    needsPairingCleanup = !removed
    if !removed {
      cleanupError =
        "Connection closed, but saved pairing or phone data could not be removed. Retry forgetting this Mac before closing Chat."
    }
    generation += 1
    selection += 1
    client?.invalidate()
    client = nil
    pairing = nil
    localNetworkDenied = false
    busy = false
    refreshing = false
    connected = false
    clearConversation()
    saved = nil
    persistenceError = nil
    cachedAt = nil
    status = "Connect to your Mac"
    error = cleanupError
  }
  /// Discovery reports whether iOS allows Local Network access while the phone is paired.
  func localNetworkAccess(allowed: Bool) {
    guard pairing != nil, localNetworkDenied == allowed else { return }
    localNetworkDenied = !allowed
    guard !connected else { return }
    if allowed {
      status = "Reconnecting to your Mac…"
      if error == Self.localNetworkOff { error = "" }
    } else {
      status = Self.localNetworkOffStatus
      error = Self.localNetworkOff
    }
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
    let visible = Set(snapshot.sessions.map(\.id))
    let knownFamiliars = Set(snapshot.familiars.map(\.id))
    let oldHistoryCount = saved?.conversations.count ?? 0
    let oldDraftCount = saved?.drafts.count ?? 0
    let loadedInvalid = sessionId.map { !visible.contains($0) } ?? false
    let previousSelection = selectedId
    if let id = selectedId, sessionId != nil,
      !snapshot.sessions.contains(where: { $0.familiarId == id }),
      snapshot.activeRun?.familiarId != id
    { deletedDisplayFamiliars.insert(id) }
    if let pending = saved?.pending, pending.sessionID != nil,
      !snapshot.sessions.contains(where: { $0.familiarId == pending.familiarID }),
      snapshot.activeRun?.id != pending.requestID
    { deletedDisplayFamiliars.insert(pending.familiarID) }
    for session in snapshot.sessions { deletedDisplayFamiliars.remove(session.familiarId) }
    if let active = snapshot.activeRun { deletedDisplayFamiliars.remove(active.familiarId) }
    familiars = snapshot.familiars
    sessions = snapshot.sessions
    approvals = snapshot.pendingApprovals ?? []
    saved?.conversations.removeAll {
      !knownFamiliars.contains($0.familiarID)
        || ($0.history.sessionId.map { !visible.contains($0) } ?? false)
    }
    saved?.drafts.removeAll { !knownFamiliars.contains($0.binding.familiarID) }
    saved?.snapshot = snapshot
    saved?.snapshotSavedAt = now()
    if !familiars.contains(where: { $0.id == selectedId }) {
      selectedId = familiars.first?.id
      selection += 1
    }
    saved?.selectedFamiliarID = selectedId
    if loadedInvalid || selectedId != previousSelection
      || selectedId.map({ deletedDisplayFamiliars.contains($0) }) == true {
      hydrateSelection()
      historyReady = false
      historyRunId = nil
      retainedRun = nil
    }
    if let run = snapshot.activeRun {
      activeRun = run
      retainedRun = run
    } else {
      activeRun = nil
    }
    if loadedInvalid || selectedId != previousSelection
      || oldHistoryCount != saved?.conversations.count
      || oldDraftCount != saved?.drafts.count {
      // A successful snapshot is already authoritative about deletion. Do not
      // wait for another network request before removing its cached content.
      flushPersistence()
    }
  }
  private func accept(_ run: Run) {
    if let pending = saved?.pending,
      run.id != pending.requestID || run.familiarId != pending.familiarID
    {
      error = "The Mac returned a different run. Check this send before sending again."
      return
    }
    let mayDisplay = !deletedDisplayFamiliars.contains(run.familiarId)
    activeRun = mayDisplay ? run : Run(id: run.id, familiarId: run.familiarId,
      status: run.status, messages: [], error: nil)
    retainedRun = mayDisplay ? run : nil
    if !mayDisplay { historyRunId = nil }
    if let revision = saved?.pending?.submittedDraftRevision,
      let record = saved?.drafts.first(where: { $0.revision == revision })
    {
      var candidate = saved!
      candidate.drafts.removeAll { $0.revision == revision }
      if commit(candidate), record.binding == currentBinding {
        drafts[record.binding.familiarID] = ""
      }
    }
    if !run.running {
      settlePending()
      terminalError = mayDisplay ? run.error ?? "" : ""
      error = terminalError
    }
  }
  private func handle(_ failure: Error) {
    if case CompanionError.revoked = failure {
      forget()
      error = CompanionError.revoked.localizedDescription
    } else if localNetworkDenied {
      connected = false
      status = Self.localNetworkOffStatus
      error = Self.localNetworkOff
    } else {
      connected = false
      status = "Mac unreachable — reconnecting…"
      error = Self.explain(failure)
    }
  }
  private func clearConversation() {
    saveTask?.cancel()
    saved = nil
    deletedDisplayFamiliars = []
    familiars = []
    sessions = []
    messages = []
    selectedId = nil
    drafts = [:]
    activeRun = nil
    pendingRunId = nil
    historyReady = false
    sessionId = nil
    hasMore = false
    historyRunId = nil
    retainedRun = nil
    terminalError = ""
    approvals = []
    answering = false
    permissionLog = nil
    permissionLogError = nil
  }

  private var currentBinding: DraftBinding? {
    selectedId.map { DraftBinding(familiarID: $0, sessionID: sessionId) }
  }
  private var currentDraftRecord: SavedDraft? {
    saved?.drafts.first { $0.binding == currentBinding }
  }
  var cacheNamespace: CacheNamespace? { saved?.namespace }
  var draftDestination: DraftBinding? { currentBinding }
  func conversationLabel(for binding: DraftBinding?) -> String {
    guard let binding else { return "No conversation selected" }
    guard let id = binding.sessionID else { return "New conversation" }
    if let title = sessions.first(where: { $0.id == id && $0.familiarId == binding.familiarID })?.title,
      !title.isEmpty { return title }
    return "Conversation \(id.prefix(8))"
  }
  var recoveredDrafts: [SavedDraft] {
    saved?.drafts.filter {
      $0.binding.familiarID == selectedId && $0.binding != currentBinding
    } ?? []
  }
  private func restoreSavedState(for pairing: Pairing) throws {
    let namespace = CacheNamespace(installationID: installationID, pairing: pairing)
    let value = try persistence.load(for: namespace) ?? CompanionSavedState(namespace: namespace)
    installSavedState(value)
  }
  private func installSavedState(_ value: CompanionSavedState) {
    saved = value
    cacheConversationText = value.cacheConversationText
    if let snapshot = value.snapshot {
      familiars = snapshot.familiars
      sessions = snapshot.sessions
      selectedId = value.selectedFamiliarID ?? familiars.first?.id
    }
    hydrateSelection()
    pendingRunId = value.pending?.requestID
    historyRunId = pendingRunId
    persistenceError = nil
  }
  private func hydrateSelection() {
    messages = []
    hasMore = false
    cachedAt = nil
    sessionId = sessions.first { $0.familiarId == selectedId }?.id
    if let conversation = saved?.conversations.first(where: {
      $0.familiarID == selectedId && now().timeIntervalSince($0.savedAt) < 7 * 86400
    }) {
      messages = conversation.history.messages
      sessionId = conversation.history.sessionId
      hasMore = conversation.history.hasMore
      cachedAt = conversation.savedAt
    }
    if let id = selectedId { drafts[id] = currentDraftRecord?.text ?? "" }
  }
  private func storageFailed(_ error: Error) {
    let message = (error as? CompanionError)?.localizedDescription
      ?? "Chat could not save protected phone data. Unlock your iPhone and check its free space before sending."
    persistenceError = message
    self.error = message
  }
  @discardableResult private func commit(_ value: CompanionSavedState) -> Bool {
    do {
      try persistence.save(value)
      let previousError = persistenceError
      saved = value
      persistenceError = nil
      if error == previousError { error = "" }
      return true
    } catch { storageFailed(error); return false }
  }
  func flushPersistence() {
    saveTask?.cancel()
    guard pairing != nil, let saved else { return }
    commit(saved)
  }
  private func scheduleSave() {
    saveTask?.cancel()
    let expected = generation
    let namespace = saved?.namespace
    saveTask = Task { [weak self] in
      do { try await Task.sleep(for: .milliseconds(250)) } catch { return }
      guard let self, !Task.isCancelled, self.generation == expected,
        self.saved?.namespace == namespace else { return }
      self.flushPersistence()
    }
  }
  private func reserve<T: Encodable>(requestID: String, kind: PendingCompanionOperation.Kind,
                                    familiar: String, body: T, draftRevision: UUID?) -> Bool {
    guard var value = saved else { return false }
    do {
      value.pending = PendingCompanionOperation(
        requestID: requestID, kind: kind, familiarID: familiar, sessionID: sessionId,
        payloadDigest: CacheNamespace.digest(try CompanionRequestEncoding.encode(body)),
        submittedDraftRevision: draftRevision, createdAt: now())
      let accepted = commit(value)
      if accepted && kind == .send { deletedDisplayFamiliars.remove(familiar) }
      return accepted
    } catch { storageFailed(error); return false }
  }
  @discardableResult private func settlePending(clearHistory: Bool = false) -> Bool {
    guard var value = saved else { return false }
    value.pending = nil
    guard commit(value) else { return false }
    pendingRunId = nil
    if clearHistory { historyRunId = nil }
    return true
  }
  func setCacheConversationText(_ enabled: Bool) {
    guard var value = saved else { return }
    value.cacheConversationText = enabled
    if commit(value) { cacheConversationText = enabled }
  }
  func clearDownloadedHistory() {
    guard var value = saved else { return }
    value.conversations = []
    if let snapshot = value.snapshot {
      value.snapshot = value.draftNavigation(from: snapshot)
      value.snapshotSavedAt = nil
    }
    if commit(value) {
      cachedAt = nil
      if !connected { messages = [] }
    }
  }
  func editRecoveredDraft(binding: DraftBinding, namespace: CacheNamespace, text: String) {
    guard saved?.namespace == namespace, binding != currentBinding,
      binding.familiarID == selectedId,
      let index = saved?.drafts.firstIndex(where: { $0.binding == binding }),
      saved?.drafts[index].text != text else { return }
    saved?.drafts[index].text = text
    saved?.drafts[index].revision = UUID()
    saved?.drafts[index].updatedAt = now()
    scheduleSave()
  }
  func restoreDraft(revision: UUID, text: String? = nil,
                    expectedDestination: DraftBinding, namespace: CacheNamespace) {
    guard connected, historyReady, let binding = currentBinding,
      binding == expectedDestination, saved?.namespace == namespace,
      let record = recoveredDrafts.first(where: { $0.revision == revision }),
      record.binding.familiarID == binding.familiarID else { return }
    let recovered = text ?? record.text
    let combined = draft.isEmpty ? recovered : recovered.isEmpty ? draft : draft + "\n\n" + recovered
    saved?.drafts.removeAll { $0.revision == revision }
    draft = combined
    flushPersistence()
  }
  static let localNetworkOffStatus = "Local Network access is off"
  static let localNetworkOff =
    "Coven Chat needs Local Network access to reach your Mac. Turn on Coven Chat in Settings › Privacy & Security › Local Network."
  private static func explain(_ error: Error) -> String {
    if let known = error as? CompanionError { return known.localizedDescription }
    return
      "Could not reach your Mac securely. Keep Chat running on the same network, then try again."
  }
}
