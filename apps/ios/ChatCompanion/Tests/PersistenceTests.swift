import XCTest

@testable import ChatCompanion

@MainActor final class PersistenceTests: XCTestCase {
  private var root: URL!
  private let install = Data(repeating: 7, count: 16)
  private let now = Date(timeIntervalSince1970: 1_800_000_000)

  override func setUp() async throws {
    root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
  }
  override func tearDown() async throws {
    try? FileManager.default.removeItem(at: root)
  }
  private func namespace(token: String = String(repeating: "a", count: 64)) -> CacheNamespace {
    CacheNamespace(
      installationID: install,
      pairing: Pairing(
        endpoint: URL(string: "https://192.168.1.2:8443")!, token: token,
        fingerprint: String(repeating: "b", count: 64)))
  }
  private func store() -> ProtectedCompanionStore {
    ProtectedCompanionStore(root: root, installationID: install, now: { self.now })
  }
  private func state() -> CompanionSavedState {
    var value = CompanionSavedState(namespace: namespace())
    value.selectedFamiliarID = "astra"
    value.drafts = [SavedDraft(
      binding: DraftBinding(familiarID: "astra", sessionID: "head-1"), text: "keep this draft",
      revision: UUID(), updatedAt: now)]
    value.conversations = [conversation("head-1", text: "saved answer", age: 0)]
    return value
  }
  private func conversation(_ id: String, text: String, age: TimeInterval) -> CachedConversation {
    CachedConversation(
      familiarID: id,
      history: History(
        sessionId: id, messages: [Message(id: "m", role: "assistant", text: text)],
        hasMore: false), savedAt: now.addingTimeInterval(-age))
  }
  private func files() throws -> [URL] {
    let enumerator = FileManager.default.enumerator(at: root, includingPropertiesForKeys: nil)!
    return enumerator.compactMap { $0 as? URL }.filter { $0.pathExtension == "json" }
  }
  func testStateRoundTripsAcrossStoreInstances() throws {
    try store().save(state())
    let restored = try XCTUnwrap(store().load(for: namespace()))
    XCTAssertEqual(restored.selectedFamiliarID, "astra")
    XCTAssertEqual(restored.drafts.first?.text, "keep this draft")
    XCTAssertEqual(restored.drafts.first?.binding.sessionID, "head-1")
    XCTAssertEqual(restored.conversations.first?.history.messages.first?.text, "saved answer")
  }
  func testDifferentInstallHostOrAuthorizationCannotLoadState() throws {
    try store().save(state())
    var wrongHost = namespace()
    wrongHost.hostFingerprint = String(repeating: "c", count: 64)
    XCTAssertNil(try store().load(for: wrongHost))
    XCTAssertNil(try store().load(for: namespace(token: String(repeating: "d", count: 64))))
    let otherInstall = Data(repeating: 8, count: 16)
    let other = ProtectedCompanionStore(root: root, installationID: otherInstall, now: { self.now })
    var wrongInstall = namespace()
    wrongInstall.installationID = otherInstall
    XCTAssertNil(try other.load(for: wrongInstall))
    XCTAssertFalse(try files().contains { try Data(contentsOf: $0).contains(Data("keep this draft".utf8)) })
  }
  func testCacheContainsNoBearerOrEndpoint() throws {
    try store().save(state())
    let bytes = try Data(contentsOf: XCTUnwrap(files().first))
    let json = String(decoding: bytes, as: UTF8.self)
    XCTAssertFalse(json.contains(String(repeating: "a", count: 64)))
    XCTAssertFalse(json.contains("192.168.1.2"))
  }
  func testSevenDayHistoryExpiry() throws {
    var value = state()
    value.conversations = [
      conversation("fresh", text: "recent", age: 7 * 86400 - 1),
      conversation("expired", text: "old", age: 7 * 86400),
      conversation("future", text: "clock error", age: -86400),
    ]
    try store().save(value)
    XCTAssertEqual(try store().load(for: namespace())?.conversations.map(\.familiarID), ["fresh"])
  }
  func testOldestHistoryEvictionAtTwentyMiB() throws {
    var value = state()
    value.conversations = [
      conversation("oldest", text: String(repeating: "x", count: 8 * 1024 * 1024), age: 3),
      conversation("middle", text: String(repeating: "y", count: 8 * 1024 * 1024), age: 2),
      conversation("newest", text: String(repeating: "z", count: 8 * 1024 * 1024), age: 1),
    ]
    try store().save(value)
    let loaded = try XCTUnwrap(store().load(for: namespace()))
    XCTAssertEqual(loaded.conversations.map(\.familiarID), ["middle", "newest"])
    XCTAssertLessThanOrEqual(try Data(contentsOf: XCTUnwrap(files().first)).count, 20 * 1024 * 1024)
  }
  func testPendingOperationIsNeverEvicted() throws {
    var value = state()
    value.pending = PendingCompanionOperation(
      requestID: "receipt-1", kind: .send, familiarID: "astra", sessionID: "head-1",
      payloadDigest: String(repeating: "e", count: 64), submittedDraftRevision: nil,
      createdAt: now.addingTimeInterval(-30 * 86400))
    try store().save(value)
    let before = try Data(contentsOf: XCTUnwrap(files().first))
    value.drafts[0].text = String(repeating: "x", count: 21 * 1024 * 1024)
    XCTAssertThrowsError(try store().save(value))
    XCTAssertEqual(try Data(contentsOf: XCTUnwrap(files().first)), before)
    XCTAssertEqual(try store().load(for: namespace())?.pending?.requestID, "receipt-1")
  }
  func testFilesHaveCompleteProtectionAndBackupExclusion() throws {
    try store().save(state())
    let file = try XCTUnwrap(files().first)
    let attributes = try FileManager.default.attributesOfItem(atPath: file.path)
    XCTAssertEqual(try file.resourceValues(forKeys: [.isExcludedFromBackupKey]).isExcludedFromBackup, true)
    XCTAssertEqual((attributes[.posixPermissions] as? NSNumber)?.intValue, 0o600)
    #if targetEnvironment(simulator)
      if attributes[.protectionKey] == nil {
        throw XCTSkip("This simulator does not expose protection classes; qualify complete protection and lock access on a physical phone.")
      }
    #endif
    XCTAssertEqual(attributes[.protectionKey] as? FileProtectionType, .complete)
  }
  func testCorruptOversizedAndUnsupportedStateRefuseWithoutReplacingBytes() throws {
    let storage = store()
    try storage.save(state())
    let file = try XCTUnwrap(files().first)
    let valid = try Data(contentsOf: file)
    var unsupported = try JSONSerialization.jsonObject(with: valid) as! [String: Any]
    unsupported["version"] = 99
    let cases = [Data("invalid".utf8), Data(repeating: 0, count: 20 * 1024 * 1024 + 1),
                 try JSONSerialization.data(withJSONObject: unsupported)]
    for damaged in cases {
      try damaged.write(to: file)
      XCTAssertThrowsError(try storage.load(for: namespace()))
      XCTAssertThrowsError(try storage.save(state()))
      XCTAssertEqual(try Data(contentsOf: file), damaged)
    }
  }
  func testSymlinkTargetsRefuseWithoutTouchingDestination() throws {
    let storage = store()
    try storage.save(state())
    let file = try XCTUnwrap(files().first)
    let destination = root.appendingPathComponent("outside")
    try Data("untouched".utf8).write(to: destination)
    try FileManager.default.removeItem(at: file)
    try FileManager.default.createSymbolicLink(at: file, withDestinationURL: destination)
    XCTAssertThrowsError(try storage.load(for: namespace()))
    XCTAssertThrowsError(try storage.save(state()))
    XCTAssertThrowsError(try storage.erase(for: namespace()))
    XCTAssertEqual(try String(contentsOf: destination, encoding: .utf8), "untouched")
  }
  func testEraseIsIdempotent() throws {
    let storage = store()
    try storage.save(state())
    try storage.erase(for: namespace())
    try storage.erase(for: namespace())
    XCTAssertNil(try storage.load(for: namespace()))
  }
}
