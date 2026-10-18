import XCTest

@testable import ChatCompanion

@MainActor final class MemoryStore: PairingStore {
  var failClear = false
  var value: Pairing?
  func load() throws -> Pairing? { value }
  func save(_ value: Pairing) throws { self.value = value }
  func clear() throws {
    if failClear { throw CompanionError.message("Locked") }
    value = nil
  }
}
@MainActor final class FakeClient: CompanionClient {
  var sent: [SendRequest] = []
  var failSend = false
  var delaySend = false
  var sendGate: CheckedContinuation<Run, Error>?
  var gate: CheckedContinuation<Snapshot, Error>?
  var delaySnapshot = false
  var failSnapshot = false
  var invalidated = false
  var snapshotValue = Snapshot(
    version: 1, familiars: [Familiar(id: "astra", name: "astra", displayName: "Astra")],
    sessions: [], activeRun: nil)
  func snapshot() async throws -> Snapshot {
    if delaySnapshot {
      delaySnapshot = false
      return try await withCheckedThrowingContinuation { gate = $0 }
    }
    if failSnapshot { throw URLError(.timedOut) }
    return snapshotValue
  }
  func history(familiarId: String) async throws -> History {
    History(sessionId: nil, messages: [], hasMore: false)
  }
  func send(_ request: SendRequest) async throws -> Run {
    sent.append(request)
    if delaySend { return try await withCheckedThrowingContinuation { sendGate = $0 } }
    if failSend { throw URLError(.networkConnectionLost) }
    return Run(
      id: request.requestId, familiarId: request.familiarId, status: "running", messages: [])
  }
  func run(id: String) async throws -> Run {
    Run(
      id: id, familiarId: "astra", status: "completed",
      messages: [Message(id: "reply", role: "assistant", text: "Hello")])
  }
  func stop(id: String) async throws {}
  func invalidate() { invalidated = true }
}

@MainActor final class ModelTests: XCTestCase {
  func pairing() -> Pairing {
    Pairing(
      endpoint: URL(string: "https://192.168.1.2:8443")!, token: String(repeating: "a", count: 64),
      fingerprint: String(repeating: "b", count: 64))
  }
  func model(_ client: FakeClient, _ suppliedStore: MemoryStore? = nil) -> CompanionModel {
    let store = suppliedStore ?? MemoryStore()
    store.value = pairing()
    return CompanionModel(
      store: store, makeClient: { _ in client }, localNetworkBlocks: { _ in false })
  }
  func link() -> String {
    "coven-chat://pair?endpoint=https://192.168.1.2:8443&token=\(String(repeating: "a", count: 64))&fingerprint=\(String(repeating: "b", count: 64))"
  }
  func testConnectReadAndSendUseSelectedFamiliar() async {
    let api = FakeClient()
    let model = model(api)
    await model.refresh()
    XCTAssertTrue(model.connected)
    model.draft = "hello"
    await model.send()
    XCTAssertEqual(api.sent.count, 1)
    XCTAssertEqual(api.sent[0].familiarId, "astra")
    XCTAssertEqual(model.draft, "")
  }
  func testUncertainSendIsReconciledWithoutResubmission() async {
    let api = FakeClient()
    api.failSend = true
    let model = model(api)
    await model.refresh()
    model.draft = "hello"
    await model.send()
    XCTAssertNotNil(model.pendingRunId)
    await model.refresh()
    XCTAssertEqual(api.sent.count, 1)
    XCTAssertNil(model.pendingRunId)
  }
  func testForgottenMacCannotReappearFromDelayedResponse() async {
    let api = FakeClient()
    let store = MemoryStore()
    let model = model(api, store)
    api.delaySnapshot = true
    let task = Task { await model.refresh() }
    while api.gate == nil { await Task.yield() }
    model.forget()
    api.gate?.resume(returning: api.snapshotValue)
    await task.value
    XCTAssertNil(model.pairing)
    XCTAssertTrue(model.familiars.isEmpty)
    XCTAssertNil(store.value)
    XCTAssertTrue(api.invalidated)
  }
  func testDiscoveryCannotInvalidateAnInFlightSend() async {
    let current = FakeClient()
    let candidate = FakeClient()
    candidate.delaySnapshot = true
    let store = MemoryStore()
    store.value = pairing()
    let model = CompanionModel(
      store: store, makeClient: { p in p.endpoint.port == 8443 ? current : candidate })
    await model.refresh()
    let task = Task { await model.tryEndpoint(URL(string: "https://192.168.1.2:8444")!) }
    while candidate.gate == nil { await Task.yield() }
    model.draft = "hello"
    current.delaySend = true
    let send = Task { await model.send() }
    while current.sendGate == nil { await Task.yield() }
    candidate.gate?.resume(returning: candidate.snapshotValue)
    await task.value
    XCTAssertFalse(current.invalidated)
    XCTAssertEqual(model.pairing?.endpoint.port, 8443)
    current.sendGate?.resume(throwing: URLError(.networkConnectionLost))
    await send.value
    XCTAssertNotNil(model.pendingRunId)
  }
  func testUncertainSendReconcilesAfterAuthenticatedAddressChange() async {
    let current = FakeClient()
    current.failSend = true
    let candidate = FakeClient()
    let store = MemoryStore()
    store.value = pairing()
    let model = CompanionModel(
      store: store, makeClient: { p in p.endpoint.port == 8443 ? current : candidate })
    await model.refresh()
    model.draft = "hello"
    await model.send()
    await model.tryEndpoint(URL(string: "https://192.168.1.2:8444")!)
    XCTAssertEqual(model.pairing?.endpoint.port, 8444)
    XCTAssertNil(model.pendingRunId)
    XCTAssertTrue(candidate.sent.isEmpty)
    XCTAssertEqual(current.sent.count, 1)
  }

  func testForgetClearsMemoryEvenWhenKeychainDeletionFails() async {
    let api = FakeClient()
    let store = MemoryStore()
    let model = model(api, store)
    await model.refresh()
    model.draft = "private"
    store.failClear = true
    model.forget()
    XCTAssertNil(model.pairing)
    XCTAssertTrue(api.invalidated)
    XCTAssertTrue(model.familiars.isEmpty)
    XCTAssertEqual(model.draft, "")
    XCTAssertFalse(model.error.isEmpty)
  }
  func testDeniedLocalNetworkNamesTheSettingUntilAccessReturns() async {
    let api = FakeClient()
    let model = model(api)
    await model.refresh()
    api.failSnapshot = true
    await model.refresh()
    XCTAssertFalse(model.connected)
    XCTAssertNotEqual(model.error, CompanionModel.localNetworkOff)
    model.localNetworkAccess(allowed: false)
    XCTAssertTrue(model.localNetworkDenied)
    XCTAssertEqual(model.status, CompanionModel.localNetworkOffStatus)
    XCTAssertEqual(model.error, CompanionModel.localNetworkOff)
    await model.refresh()
    XCTAssertEqual(model.error, CompanionModel.localNetworkOff, "a retry keeps naming the setting")
    model.localNetworkAccess(allowed: true)
    XCTAssertFalse(model.localNetworkDenied)
    XCTAssertEqual(model.error, "")
    api.failSnapshot = false
    await model.refresh()
    XCTAssertTrue(model.connected)
  }
  func testPairingBlockedByLocalNetworkNamesTheSetting() async {
    let api = FakeClient()
    api.failSnapshot = true
    var probed: [URL] = []
    let model = CompanionModel(
      store: MemoryStore(), makeClient: { _ in api },
      localNetworkBlocks: { url in
        probed.append(url)
        return true
      })
    await model.pair(link: link())
    XCTAssertNil(model.pairing)
    XCTAssertEqual(probed.map(\.port), [8443])
    XCTAssertTrue(model.localNetworkDenied)
    XCTAssertEqual(model.error, CompanionModel.localNetworkOff)
  }
  func testPairingFailureWithLocalNetworkAllowedKeepsTheGeneralMessage() async {
    let api = FakeClient()
    api.failSnapshot = true
    let model = CompanionModel(
      store: MemoryStore(), makeClient: { _ in api }, localNetworkBlocks: { _ in false })
    await model.pair(link: link())
    XCTAssertFalse(model.localNetworkDenied)
    XCTAssertFalse(model.error.isEmpty)
    XCTAssertNotEqual(model.error, CompanionModel.localNetworkOff)
  }
  func testPairingRefusedByTheMacDoesNotProbeLocalNetwork() async {
    let api = FakeClient()
    api.snapshotValue = Snapshot(version: 2, familiars: [], sessions: [], activeRun: nil)
    var probed = false
    let model = CompanionModel(
      store: MemoryStore(), makeClient: { _ in api },
      localNetworkBlocks: { _ in
        probed = true
        return true
      })
    await model.pair(link: link())
    XCTAssertFalse(probed)
    XCTAssertEqual(model.error, "Update both Chat apps before pairing.")
  }
  func testArchiveAndByteLimitDisableSend() async {
    let api = FakeClient()
    api.snapshotValue = Snapshot(
      version: 1, familiars: api.snapshotValue.familiars,
      sessions: [ChatSession(id: "one", familiarId: "astra", title: "Chat", archived: true)],
      activeRun: nil)
    let model = model(api)
    await model.refresh()
    model.draft = "hello"
    XCTAssertFalse(model.canSend)
    await model.send()
    XCTAssertTrue(api.sent.isEmpty)
  }
}
