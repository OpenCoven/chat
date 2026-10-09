import Foundation
import Security

@MainActor protocol PairingStore {
  func load() throws -> Pairing?
  func save(_ pairing: Pairing) throws
  func clear() throws
}

@MainActor final class KeychainPairingStore: PairingStore {
  private let service: String
  init(service: String = "ai.opencoven.chat.companion.pairing") { self.service = service }
  private var query: [String: Any] {
    [
      kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service,
      kSecAttrAccount as String: "paired-mac", kSecAttrSynchronizable as String: false,
    ]
  }
  func load() throws -> Pairing? {
    var q = query
    q[kSecReturnData as String] = true
    q[kSecMatchLimit as String] = kSecMatchLimitOne
    var result: CFTypeRef?
    let status = SecItemCopyMatching(q as CFDictionary, &result)
    if status == errSecItemNotFound { return nil }
    guard status == errSecSuccess, let data = result as? Data else { throw failure() }
    let pairing = try JSONDecoder().decode(Pairing.self, from: data)
    guard Pairing.validEndpoint(pairing.endpoint), Pairing.hexSecret(pairing.token),
      Pairing.hexSecret(pairing.fingerprint)
    else { throw failure() }
    return pairing
  }
  func save(_ pairing: Pairing) throws {
    let data = try JSONEncoder().encode(pairing)
    let attributes: [String: Any] = [
      kSecValueData as String: data,
      kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
    ]
    let update = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
    if update == errSecSuccess { return }
    guard update == errSecItemNotFound else { throw failure() }
    let add = query.merging(attributes) { _, new in new }
    guard SecItemAdd(add as CFDictionary, nil) == errSecSuccess else { throw failure() }
  }
  func clear() throws {
    let result = SecItemDelete(query as CFDictionary)
    guard result == errSecSuccess || result == errSecItemNotFound else { throw failure() }
  }
  private func failure() -> CompanionError {
    .message(
      "Chat could not access this device's secure pairing storage. Unlock your iPhone and try again."
    )
  }
}
