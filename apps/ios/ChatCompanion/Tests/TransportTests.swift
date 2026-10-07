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
}
