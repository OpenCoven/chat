import Foundation
import Security

@MainActor protocol PairingStore {
  func load() throws -> Pairing?
  func save(_ pairing: Pairing) throws
  func clear() throws
}

/// Tells a pairing saved by this install from one a deleted install left behind.
/// iOS removes an app's UserDefaults and data container with the app, but keeps its
/// Keychain items, so a reinstalled app would otherwise open already paired (#465).
struct InstallIdentity {
  private let defaults: UserDefaults
  private let containerCreated: () -> Date?
  private static let key = "companion.install-id"

  init(
    defaults: UserDefaults = .standard,
    containerCreated: @escaping () -> Date? = {
      try? FileManager.default.attributesOfItem(atPath: NSHomeDirectory())[.creationDate] as? Date
    }
  ) {
    self.defaults = defaults
    self.containerCreated = containerCreated
  }

  /// This install's identifier, created on first use and removed with the app.
  var id: Data {
    if let saved = defaults.data(forKey: Self.key), saved.count == 16 { return saved }
    let created = withUnsafeBytes(of: UUID().uuid) { Data($0) }
    defaults.set(created, forKey: Self.key)
    return created
  }

  /// A stamped item belongs to this install only when the stamps match. Builds up to
  /// 0.2.0 (1454) saved no stamp: keep such an item only if it was saved after this
  /// install's data container was created, so an update keeps its pairing and a
  /// reinstall does not.
  func owns(stamp: Data?, modified: Date?) -> Bool {
    if let stamp { return stamp == id }
    guard let modified, let created = containerCreated() else { return false }
    return modified >= created
  }
}

@MainActor final class KeychainPairingStore: PairingStore {
  private let service: String
  private let install: InstallIdentity
  init(
    service: String = "ai.opencoven.chat.companion.pairing", install: InstallIdentity = .init()
  ) {
    self.service = service
    self.install = install
  }
  private var query: [String: Any] {
    [
      kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service,
      kSecAttrAccount as String: "paired-mac", kSecAttrSynchronizable as String: false,
    ]
  }
  func load() throws -> Pairing? {
    var q = query
    q[kSecReturnData as String] = true
    q[kSecReturnAttributes as String] = true
    q[kSecMatchLimit as String] = kSecMatchLimitOne
    var result: CFTypeRef?
    let status = SecItemCopyMatching(q as CFDictionary, &result)
    if status == errSecItemNotFound { return nil }
    guard status == errSecSuccess, let item = result as? [String: Any],
      let data = item[kSecValueData as String] as? Data
    else { throw failure() }
    let stamp = item[kSecAttrGeneric as String] as? Data
    guard install.owns(stamp: stamp, modified: item[kSecAttrModificationDate as String] as? Date)
    else {
      // Left by a deleted install: it must not connect this one.
      try clear()
      return nil
    }
    let pairing = try JSONDecoder().decode(Pairing.self, from: data)
    guard Pairing.validEndpoint(pairing.endpoint), Pairing.hexSecret(pairing.token),
      Pairing.hexSecret(pairing.fingerprint)
    else { throw failure() }
    if stamp == nil {
      let update = [kSecAttrGeneric as String: install.id] as CFDictionary
      guard SecItemUpdate(query as CFDictionary, update) == errSecSuccess else { throw failure() }
    }
    return pairing
  }
  func save(_ pairing: Pairing) throws {
    let data = try JSONEncoder().encode(pairing)
    let attributes: [String: Any] = [
      kSecValueData as String: data,
      kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
      kSecAttrGeneric as String: install.id,
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
