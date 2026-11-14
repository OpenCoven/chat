import XCTest

@testable import ChatCompanion

@MainActor final class TestCompanionPersistence: CompanionPersistence {
  var value: CompanionSavedState?
  func load(for namespace: CacheNamespace) throws -> CompanionSavedState? {
    value?.namespace == namespace ? value : nil
  }
  func save(_ state: CompanionSavedState) throws { value = state }
  func erase(for namespace: CacheNamespace) throws { value = nil }
  func eraseUnpairedData() throws { value = nil }
}

@MainActor final class FaultingPersistence: CompanionPersistence {
  let backing: ProtectedCompanionStore
  var failSave = false
  var failErase = false
  init(_ backing: ProtectedCompanionStore) { self.backing = backing }
  func load(for namespace: CacheNamespace) throws -> CompanionSavedState? {
    try backing.load(for: namespace)
  }
  func save(_ state: CompanionSavedState) throws {
    if failSave { throw CocoaError(.fileWriteOutOfSpace) }
    try backing.save(state)
  }
  func erase(for namespace: CacheNamespace) throws {
    if failErase { throw CocoaError(.fileWriteNoPermission) }
    try backing.erase(for: namespace)
  }
  func eraseUnpairedData() throws {
    if failErase { throw CocoaError(.fileWriteNoPermission) }
    try backing.eraseUnpairedData()
  }
}

@MainActor final class ModelPersistenceTests: XCTestCase {
  private var root: URL!
  private let install = Data(repeating: 7, count: 16)
  private let date = Date(timeIntervalSince1970: 1_800_000_000)
  override func setUp() async throws {
    root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
  }
  override func tearDown() async throws { try? FileManager.default.removeItem(at: root) }
  private func pairing(_ token: String = String(repeating: "a", count: 64)) -> Pairing {
    Pairing(endpoint: URL(string: "https://192.168.1.2:8443")!, token: token,
            fingerprint: String(repeating: "b", count: 64))
  }
  private func storage() -> ProtectedCompanionStore {
    ProtectedCompanionStore(root: root, installationID: install, now: { self.date })
  }
  private func api() -> FakeClient {
    let api = FakeClient()
    api.historyValue = History(
      sessionId: "head-1", messages: [Message(id: "reply", role: "assistant", text: "cached reply")],
      hasMore: false)
    api.snapshotValue = Snapshot(
      version: 1, familiars: api.snapshotValue.familiars,
      sessions: [ChatSession(id: "head-1", familiarId: "astra", title: "Chat", archived: false)],
      activeRun: nil)
    return api
  }
  private func model(_ api: FakeClient, persistence: CompanionPersistence? = nil,
                     paired: Pairing? = nil) -> CompanionModel {
    let keychain = MemoryStore()
    keychain.value = paired ?? pairing()
    return CompanionModel(
      store: keychain, persistence: persistence ?? storage(), installationID: install,
      makeClient: { _ in api }, localNetworkBlocks: { _ in false }, now: { self.date })
  }
  func testDraftAndCachedHistoryRestoreBeforeNetwork() async throws {
    let first = model(api())
    await first.refresh()
    first.draft = "unsent text"
    first.flushPersistence()
    let restored = model(api())
    XCTAssertEqual(restored.draft, "unsent text")
    XCTAssertEqual(restored.messages.first?.text, "cached reply")
    XCTAssertEqual(restored.cachedAt, date)
    XCTAssertFalse(restored.connected)
    XCTAssertFalse(restored.canSend)
  }
  func testRelaunchAfterUncertainSendQueriesSameUUIDWithoutSending() async throws {
    let sender = api()
    sender.failSend = true
    let first = model(sender)
    await first.refresh()
    first.draft = "send once"
    await first.send()
    let id = try XCTUnwrap(first.pendingRunId)
    let reader = api()
    let restored = model(reader)
    XCTAssertEqual(restored.pendingRunId, id)
    await restored.refresh()
    XCTAssertEqual(reader.receiptRequests, [id])
    XCTAssertTrue(reader.sent.isEmpty)
    XCTAssertNil(restored.pendingRunId)
  }
  func testPersistenceFailurePreventsNetworkDispatch() async {
    let client = api()
    let disk = FaultingPersistence(storage())
    let current = model(client, persistence: disk)
    await current.refresh()
    current.draft = "do not lose"
    disk.failSave = true
    await current.send()
    XCTAssertTrue(client.sent.isEmpty)
    XCTAssertFalse(current.canSend)
    XCTAssertNotNil(current.persistenceError)
    XCTAssertEqual(current.draft, "do not lose")
  }
  func testUncertainAllowAlsoSurvivesRelaunch() async throws {
    let client = api()
    let approval = Approval(id: "approval", familiarId: "astra", summary: "Legacy request",
                            requestedAt: 1, expiresAt: 2)
    client.snapshotValue.pendingApprovals = [approval]
    client.answerFailure = URLError(.networkConnectionLost)
    let current = model(client)
    await current.refresh()
    await current.allow(approval)
    let id = try XCTUnwrap(current.pendingRunId)
    let reader = api()
    let restored = model(reader)
    XCTAssertEqual(restored.pendingRunId, id)
    await restored.refresh()
    XCTAssertEqual(reader.receiptRequests, [id])
    XCTAssertTrue(reader.answers.isEmpty)
  }
  func testNewDraftRevisionSurvivesOldSendCompletion() async throws {
    let client = api()
    client.delaySend = true
    let current = model(client)
    await current.refresh()
    current.draft = "same words"
    let task = Task { await current.send() }
    while client.sendGate == nil { await Task.yield() }
    current.draft = "same words"
    client.sendGate?.resume(returning: Run(id: client.sent[0].requestId, familiarId: "astra",
                                          status: "completed", messages: []))
    await task.value
    XCTAssertEqual(current.draft, "same words", "A new edit is not the submitted revision")
    current.flushPersistence()
    XCTAssertEqual(model(api()).draft, "same words")
  }
  func testDifferentCanonicalHeadOffersRecoveredDraftWithoutMovingIt() async {
    let client = api()
    let current = model(client)
    await current.refresh()
    current.draft = "old destination"
    current.flushPersistence()
    client.historyValue = History(sessionId: "head-2", messages: [], hasMore: false)
    client.snapshotValue = Snapshot(version: 1, familiars: client.snapshotValue.familiars,
      sessions: [ChatSession(id: "head-2", familiarId: "astra", title: "New", archived: false)], activeRun: nil)
    await current.refresh()
    XCTAssertEqual(current.draft, "")
    XCTAssertEqual(current.recoveredDrafts.first?.text, "old destination")
    if let revision = current.recoveredDrafts.first?.revision { current.restoreDraft(revision: revision) }
    XCTAssertEqual(current.draft, "old destination")
    XCTAssertTrue(client.sent.isEmpty)
  }
  func testLateHistoryCannotOverwriteNewSelectionOrPairing() async {
    let client = api()
    client.snapshotValue = Snapshot(version: 1,
      familiars: client.snapshotValue.familiars + [Familiar(id: "sage", name: "sage", displayName: "Sage")],
      sessions: client.snapshotValue.sessions, activeRun: nil)
    client.historyValues["sage"] = History(sessionId: "sage-head", messages: [Message(id: "s", role: "assistant", text: "Sage")], hasMore: false)
    let current = model(client)
    await current.refresh()
    client.delayHistory = true
    let refreshing = Task { await current.refresh() }
    while client.historyGate == nil { await Task.yield() }
    await current.select("sage")
    client.historyGate?.resume(returning: client.historyValue)
    await refreshing.value
    XCTAssertEqual(current.selectedId, "sage")
    XCTAssertEqual(current.messages.first?.text, "Sage")
    XCTAssertEqual(model(api()).selectedId, "sage")
  }
  func testOldDebounceCannotRecreateForgottenCache() async throws {
    let current = model(api())
    await current.refresh()
    current.draft = "private"
    current.forget()
    current.flushPersistence()
    await Task.yield()
    XCTAssertNil(try storage().load(for: CacheNamespace(installationID: install, pairing: pairing())))
  }
  func testChangedLegacyBearerCannotReuseCachedState() async {
    let current = model(api())
    await current.refresh()
    current.draft = "private"
    current.flushPersistence()
    let changed = model(api(), paired: pairing(String(repeating: "c", count: 64)))
    XCTAssertTrue(changed.messages.isEmpty)
    XCTAssertEqual(changed.draft, "")
  }
  func testCurrentSnapshotRemovesNoLongerVisibleCachedHistory() async throws {
    let client = api()
    let current = model(client)
    await current.refresh()
    client.snapshotValue = Snapshot(version: 1, familiars: client.snapshotValue.familiars,
      sessions: [], activeRun: nil)
    client.historyValue = History(sessionId: nil, messages: [], hasMore: false)
    await current.refresh()
    let loaded = try storage().load(for: CacheNamespace(installationID: install, pairing: pairing()))
    XCTAssertFalse(loaded?.conversations.contains { $0.history.sessionId == "head-1" } ?? false)
  }
  func testNoTextCacheStripsDiskBodiesButRetainsPendingIdentity() async throws {
    let client = api()
    client.failSend = true
    let current = model(client)
    await current.refresh()
    current.draft = "sensitive words"
    await current.send()
    let id = current.pendingRunId
    current.setCacheConversationText(false)
    let loaded = try XCTUnwrap(storage().load(for: CacheNamespace(installationID: install, pairing: pairing())))
    XCTAssertFalse(loaded.cacheConversationText)
    XCTAssertTrue(loaded.drafts.isEmpty)
    XCTAssertTrue(loaded.conversations.isEmpty)
    XCTAssertNil(loaded.snapshot)
    XCTAssertEqual(loaded.pending?.requestID, id)
    XCTAssertEqual(current.draft, "sensitive words", "Text can remain in this open process")
  }
  func testClearDownloadedHistoryPreservesDraftAndUncertainOperation() async throws {
    let client = api()
    client.failSend = true
    let current = model(client)
    await current.refresh()
    current.draft = "keep draft"
    await current.send()
    current.clearDownloadedHistory()
    let loaded = try XCTUnwrap(storage().load(for: CacheNamespace(installationID: install, pairing: pairing())))
    XCTAssertTrue(loaded.conversations.isEmpty)
    XCTAssertEqual(loaded.drafts.first?.text, "keep draft")
    XCTAssertEqual(loaded.pending?.requestID, current.pendingRunId)
  }
  func testForgetAndRevocationPurgeCachedContent() async throws {
    let client = api()
    let current = model(client)
    await current.refresh()
    current.draft = "private"
    current.flushPersistence()
    client.receiptFailure = CompanionError.revoked
    client.failSend = true
    await current.send()
    await current.refresh()
    XCTAssertNil(current.pairing)
    XCTAssertEqual(current.draft, "")
    XCTAssertNil(try storage().load(for: CacheNamespace(installationID: install, pairing: pairing())))
  }
  func testCleanupFailureRemainsVisibleAndRetryable() async {
    let disk = FaultingPersistence(storage())
    let current = model(api(), persistence: disk)
    await current.refresh()
    current.draft = "private"
    current.flushPersistence()
    disk.failErase = true
    current.forget()
    XCTAssertNil(current.pairing)
    XCTAssertTrue(current.needsPairingCleanup)
    XCTAssertNotEqual(current.error, "")
    disk.failErase = false
    current.forget()
    XCTAssertFalse(current.needsPairingCleanup)
  }
  func testOfflineSelectionLoadsCachedFamiliarDraftAndHistory() async {
    let client = api()
    client.snapshotValue = Snapshot(version: 1,
      familiars: client.snapshotValue.familiars + [Familiar(id: "sage", name: "sage", displayName: "Sage")],
      sessions: client.snapshotValue.sessions + [ChatSession(id: "sage-head", familiarId: "sage", title: "Sage", archived: false)], activeRun: nil)
    client.historyValues["sage"] = History(sessionId: "sage-head", messages: [Message(id: "s", role: "assistant", text: "Sage reply")], hasMore: false)
    let current = model(client)
    await current.refresh()
    current.draft = "Astra draft"
    await current.select("sage")
    current.draft = "Sage draft"
    current.flushPersistence()
    client.failSnapshot = true
    await current.refresh()
    await current.select("astra")
    XCTAssertEqual(current.messages.first?.text, "cached reply")
    XCTAssertEqual(current.draft, "Astra draft")
    XCTAssertFalse(current.canSend)
  }
  func testClearHistoryStillRestoresDraftOffline() async {
    let current = model(api())
    await current.refresh()
    current.draft = "retain only this draft"
    current.clearDownloadedHistory()
    let restored = model(api())
    XCTAssertTrue(restored.messages.isEmpty)
    XCTAssertEqual(restored.draft, "retain only this draft")
    XCTAssertFalse(restored.canSend)
  }
  func testForeignReceiptDoesNotSettlePendingOperation() async throws {
    let sender = api()
    sender.failSend = true
    let current = model(sender)
    await current.refresh()
    current.draft = "keep until correct receipt"
    await current.send()
    let id = try XCTUnwrap(current.pendingRunId)
    let reader = api()
    reader.receiptOverride = Run(id: "different-request", familiarId: "astra", status: "completed", messages: [])
    let restored = model(reader)
    await restored.refresh()
    XCTAssertEqual(restored.pendingRunId, id)
    XCTAssertEqual(restored.draft, "keep until correct receipt")
    XCTAssertFalse(restored.canSend)
  }
  func testEditedRecoveredDraftAppendsWithoutReplacingCurrentDraft() async throws {
    let client = api()
    let current = model(client)
    await current.refresh()
    current.draft = "Original text"
    client.historyValue = History(sessionId: "head-2", messages: [], hasMore: false)
    client.snapshotValue = Snapshot(version: 1, familiars: client.snapshotValue.familiars,
      sessions: [ChatSession(id: "head-2", familiarId: "astra", title: "New", archived: false)], activeRun: nil)
    await current.refresh()
    current.draft = "Already typing"
    let revision = try XCTUnwrap(current.recoveredDrafts.first?.revision)
    current.restoreDraft(revision: revision, text: "Edited recovery")
    XCTAssertEqual(current.draft, "Already typing\n\nEdited recovery")
    XCTAssertTrue(current.recoveredDrafts.isEmpty)
    XCTAssertTrue(client.sent.isEmpty)
  }
  func testCompletedOutputRemainsVisibleIfHistoryRefreshFails() async throws {
    let sender = api()
    sender.failSend = true
    let first = model(sender)
    await first.refresh()
    first.draft = "finish this"
    await first.send()
    let id = try XCTUnwrap(first.pendingRunId)
    let reader = api()
    reader.receiptOverride = Run(id: id, familiarId: "astra", status: "completed",
      messages: [Message(id: "answer", role: "assistant", text: "Completed output")])
    reader.historyFailure = URLError(.networkConnectionLost)
    let restored = model(reader)
    await restored.refresh()
    XCTAssertEqual(restored.shownRun?.messages.first?.text, "Completed output")
    XCTAssertNil(restored.pendingRunId)
  }
}
