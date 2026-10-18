import XCTest

@testable import ChatCompanion

@MainActor final class TransportTests: XCTestCase {
  func fixture() throws -> Pairing {
    guard let url = Bundle(for: Self.self).url(forResource: "LocalPairing", withExtension: "json")
    else { throw XCTSkip("Run Scripts/test-e2e.sh for real HTTPS acceptance.") }
    let value = try JSONSerialization.jsonObject(with: Data(contentsOf: url)) as! [String: String]
    return try Pairing.parse(value["pairingLink"]!)
  }
  func testPinnedHTTPSReadsAndRejectsWrongCertificateAndToken() async throws {
    let p = try fixture()
    let client = PinnedAPI(pairing: p)
    defer { client.invalidate() }
    let snapshot = try await client.snapshot()
    XCTAssertEqual(snapshot.familiars.first?.displayName, "Fixture Familiar")
    let wrong = PinnedAPI(
      pairing: Pairing(
        endpoint: p.endpoint, token: p.token, fingerprint: String(repeating: "0", count: 64)))
    defer { wrong.invalidate() }
    do {
      _ = try await wrong.snapshot()
      XCTFail("Wrong pinned certificate was accepted")
    } catch {}
    let revoked = PinnedAPI(
      pairing: Pairing(
        endpoint: p.endpoint, token: String(repeating: "0", count: 64), fingerprint: p.fingerprint))
    defer { revoked.invalidate() }
    do {
      _ = try await revoked.snapshot()
      XCTFail("Wrong token was accepted")
    } catch CompanionError.revoked {} catch { XCTFail("Expected explicit revocation") }
  }
  func testKeychainSaveReplaceLoadClear() throws {
    let store = KeychainPairingStore(service: "ai.opencoven.chat.test.\(UUID().uuidString)")
    defer { try? store.clear() }
    let p = Pairing(
      endpoint: URL(string: "https://192.168.1.2:8443")!, token: String(repeating: "a", count: 64),
      fingerprint: String(repeating: "b", count: 64))
    XCTAssertNil(try store.load())
    try store.save(p)
    XCTAssertEqual(try store.load(), p)
    let next = Pairing(
      endpoint: p.endpoint, token: String(repeating: "c", count: 64), fingerprint: p.fingerprint)
    try store.save(next)
    XCTAssertEqual(try store.load(), next)
    try store.clear()
    XCTAssertNil(try store.load())
  }

  // MARK: Pairings left by a deleted install (#465)

  func identity(created: Date? = .distantPast) -> InstallIdentity {
    InstallIdentity(
      defaults: UserDefaults(suiteName: "ai.opencoven.chat.test.\(UUID().uuidString)")!,
      containerCreated: { created })
  }
  func samplePairing() -> Pairing {
    Pairing(
      endpoint: URL(string: "https://192.168.1.2:8443")!, token: String(repeating: "a", count: 64),
      fingerprint: String(repeating: "b", count: 64))
  }
  /// Saves the item the way builds up to 0.2.0 (1454) did: no install stamp.
  func saveUnstamped(_ pairing: Pairing, service: String) throws {
    let add: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service,
      kSecAttrAccount as String: "paired-mac", kSecAttrSynchronizable as String: false,
      kSecValueData as String: try JSONEncoder().encode(pairing),
      kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
    ]
    XCTAssertEqual(SecItemAdd(add as CFDictionary, nil), errSecSuccess)
  }
  func testReinstallDoesNotInheritThePairing() throws {
    let service = "ai.opencoven.chat.test.\(UUID().uuidString)"
    let before = KeychainPairingStore(service: service, install: identity())
    defer { try? before.clear() }
    try before.save(samplePairing())
    XCTAssertEqual(try before.load(), samplePairing())
    // A reinstall starts with empty UserDefaults, so it has a new install identity.
    let after = KeychainPairingStore(service: service, install: identity())
    XCTAssertNil(try after.load())
    XCTAssertNil(try before.load(), "the stale item is deleted, not just ignored")
  }
  func testUpdateFromAnUnstampedBuildKeepsThePairing() throws {
    let service = "ai.opencoven.chat.test.\(UUID().uuidString)"
    try saveUnstamped(samplePairing(), service: service)
    let install = identity(created: Date().addingTimeInterval(-3600))
    let store = KeychainPairingStore(service: service, install: install)
    defer { try? store.clear() }
    XCTAssertEqual(try store.load(), samplePairing())
    // The kept item is stamped, so a later reinstall is recognised by its stamp alone.
    let reinstalled = KeychainPairingStore(
      service: service, install: identity(created: Date().addingTimeInterval(-7200)))
    XCTAssertNil(try reinstalled.load())
  }
  func testUnstampedPairingFromBeforeThisInstallIsDeleted() throws {
    let service = "ai.opencoven.chat.test.\(UUID().uuidString)"
    try saveUnstamped(samplePairing(), service: service)
    let store = KeychainPairingStore(
      service: service, install: identity(created: Date().addingTimeInterval(3600)))
    defer { try? store.clear() }
    XCTAssertNil(try store.load())
    let next = KeychainPairingStore(service: service, install: identity())
    XCTAssertNil(try next.load(), "the stale item is deleted, not just ignored")
  }
}
