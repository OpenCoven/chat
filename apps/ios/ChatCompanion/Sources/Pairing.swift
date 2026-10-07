import Foundation

struct Pairing: Codable, Equatable, Sendable {
  let endpoint: URL
  let token: String
  let fingerprint: String

  static func parse(_ link: String) throws -> Pairing {
    guard link.utf8.count <= 2048,
      let c = URLComponents(string: link.trimmingCharacters(in: .whitespacesAndNewlines)),
      c.scheme == "coven-chat", c.host == "pair", c.path.isEmpty,
      c.user == nil, c.password == nil, c.port == nil, c.fragment == nil,
      let items = c.queryItems, items.count == 3,
      Set(items.map(\.name)) == Set(["endpoint", "token", "fingerprint"]),
      let raw = items.first(where: { $0.name == "endpoint" })?.value,
      let endpoint = URL(string: raw), validEndpoint(endpoint),
      let token = items.first(where: { $0.name == "token" })?.value, hexSecret(token),
      let fingerprint = items.first(where: { $0.name == "fingerprint" })?.value,
      hexSecret(fingerprint)
    else { throw CompanionError.message("Use the pairing code shown in Chat on your Mac.") }
    return Pairing(endpoint: endpoint, token: token, fingerprint: fingerprint)
  }

  static func hexSecret(_ value: String) -> Bool {
    value.utf8.count == 64
      && value.utf8.allSatisfy { (48...57).contains($0) || (97...102).contains($0) }
  }

  static func validEndpoint(_ url: URL) -> Bool {
    guard url.scheme == "https", let host = url.host,
      url.user == nil, url.password == nil, url.query == nil, url.fragment == nil,
      url.path.isEmpty || url.path == "/", let port = url.port, (1...65535).contains(port)
    else { return false }
    let octets = host.split(separator: ".", omittingEmptySubsequences: false)
    guard octets.count == 4,
      octets.allSatisfy({
        !$0.isEmpty && ($0.count == 1 || $0.first != "0")
          && $0.utf8.allSatisfy { (48...57).contains($0) }
      })
    else { return false }
    let bytes = octets.compactMap { UInt8($0) }
    guard bytes.count == 4 else { return false }
    return bytes[0] == 10 || (bytes[0] == 192 && bytes[1] == 168)
      || (bytes[0] == 172 && (16...31).contains(bytes[1]))
  }
}

enum CompanionError: LocalizedError {
  case message(String)
  case revoked, missingRun
  var errorDescription: String? {
    switch self {
    case .message(let text): return text
    case .revoked: return "This Mac removed your access. Pair again with a new code."
    case .missingRun:
      return "The Mac has no receipt for this send. Check the conversation before sending again."
    }
  }
}
