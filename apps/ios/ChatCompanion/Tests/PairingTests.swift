import XCTest

@testable import ChatCompanion

final class PairingTests: XCTestCase {
  let token = String(repeating: "a", count: 64)
  let pin = String(repeating: "b", count: 64)
  func link(_ endpoint: String = "https://192.168.1.2:8443") -> String {
    var c = URLComponents()
    c.scheme = "coven-chat"
    c.host = "pair"
    c.queryItems = [
      URLQueryItem(name: "endpoint", value: endpoint), URLQueryItem(name: "token", value: token),
      URLQueryItem(name: "fingerprint", value: pin),
    ]
    return c.string!
  }
  func testValidPrivatePairing() throws {
    let p = try Pairing.parse(link())
    XCTAssertEqual(p.endpoint.host, "192.168.1.2")
    XCTAssertEqual(p.token, token)
  }
  func testRejectsPublicMalformedAndCredentialEndpoints() {
    for endpoint in [
      "http://192.168.1.2", "https://192.168.1.2.evil.test", "https://8.8.8.8",
      "https://user:pass@192.168.1.2", "https://192.168.1.2/path", "https://192.168.1.2?x=1",
      "https://192.168.1.2#frag", "https://192.168.1.2:0", "https://127.0.0.1", "https://[::1]",
    ] {
      XCTAssertThrowsError(try Pairing.parse(link(endpoint)), endpoint)
    }
  }
  func testRejectsAmbiguousParametersAndBadSecrets() {
    XCTAssertThrowsError(try Pairing.parse(link() + "&token=" + token))
    XCTAssertThrowsError(try Pairing.parse(link() + "&extra=1"))
    XCTAssertThrowsError(try Pairing.parse(link().replacingOccurrences(of: token, with: "short")))
  }
  func testPinMatchesOnlyExactCertificate() {
    let der = Data([1, 2, 3])
    XCTAssertTrue(
      PinnedAPI.matches(
        certificate: der,
        fingerprint: "039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81"))
    XCTAssertFalse(PinnedAPI.matches(certificate: der, fingerprint: pin))
  }
}
