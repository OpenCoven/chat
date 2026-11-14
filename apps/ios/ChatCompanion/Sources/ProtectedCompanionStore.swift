import Darwin
import Foundation

/// Native-only, protected, bounded storage. Corruption refuses writes until explicit Forget.
@MainActor final class ProtectedCompanionStore: CompanionPersistence {
  private let root: URL
  private let installationID: Data
  private let now: () -> Date
  private let manager = FileManager.default
  private let limit = 20 * 1024 * 1024
  private let lifetime: TimeInterval = 7 * 86400

  init(root: URL, installationID: Data, now: @escaping () -> Date = Date.init) {
    self.root = root
    self.installationID = installationID
    self.now = now
  }
  private var installDirectory: URL {
    root.appendingPathComponent(CacheNamespace.digest(installationID), isDirectory: true)
  }
  private var failure: CompanionError {
    .message("Chat could not safely save or read protected phone storage. Unlock your iPhone, check its free space, then try again.")
  }
  private func directory(_ url: URL) throws {
    if let attributes = try attributes(url) {
      guard attributes[.type] as? FileAttributeType == .typeDirectory else { throw failure }
    } else {
      try manager.createDirectory(
        at: url, withIntermediateDirectories: true,
        attributes: [.posixPermissions: 0o700, .protectionKey: FileProtectionType.complete])
    }
    var mutable = url
    var values = URLResourceValues()
    values.isExcludedFromBackup = true
    try mutable.setResourceValues(values)
  }
  private func attributes(_ url: URL) throws -> [FileAttributeKey: Any]? {
    do { return try manager.attributesOfItem(atPath: url.path) }
    catch let error as CocoaError where error.code == .fileReadNoSuchFile { return nil }
  }
  private func prepare() throws {
    try directory(root)
    // Reinstall/restore must not revive a previous installation's text or pending operations.
    for item in try manager.contentsOfDirectory(at: root, includingPropertiesForKeys: nil) {
      guard Pairing.hexSecret(item.lastPathComponent), item != installDirectory else { continue }
      guard try attributes(item)?[.type] as? FileAttributeType == .typeDirectory else { throw failure }
      try manager.removeItem(at: item)
    }
    try directory(installDirectory)
  }
  private func file(for namespace: CacheNamespace) throws -> URL {
    guard namespace.installationID == installationID, installationID.count == 16,
      Pairing.hexSecret(namespace.hostFingerprint), Pairing.hexSecret(namespace.authorizationID)
    else { throw failure }
    let encoder = JSONEncoder()
    encoder.outputFormatting = .sortedKeys
    return installDirectory.appendingPathComponent(
      CacheNamespace.digest(try encoder.encode(namespace)) + ".json")
  }
  private func read(_ url: URL, namespace: CacheNamespace) throws -> CompanionSavedState? {
    guard let attributes = try attributes(url) else { return nil }
    guard attributes[.type] as? FileAttributeType == .typeRegular,
      let size = attributes[.size] as? NSNumber, size.intValue <= limit
    else { throw failure }
    let descriptor = Darwin.open(url.path, O_RDONLY | O_NOFOLLOW | O_CLOEXEC)
    guard descriptor >= 0 else { throw failure }
    let handle = FileHandle(fileDescriptor: descriptor, closeOnDealloc: true)
    defer { try? handle.close() }
    let bytes = try handle.read(upToCount: limit + 1) ?? Data()
    guard bytes.count <= limit else { throw failure }
    let state = try JSONDecoder().decode(CompanionSavedState.self, from: bytes)
    guard state.version == 1, state.namespace == namespace else { throw failure }
    return state
  }
  private func pruned(_ original: CompanionSavedState) -> CompanionSavedState {
    var state = original
    if !state.cacheConversationText {
      state.snapshot = nil
      state.snapshotSavedAt = nil
      state.drafts = []
      state.conversations = []
    } else {
      let date = now()
      state.conversations.removeAll {
        date.timeIntervalSince($0.savedAt) >= lifetime || $0.savedAt.timeIntervalSince(date) > 300
      }
      let snapshotIsRecent = state.snapshotSavedAt.map {
        date.timeIntervalSince($0) < lifetime && $0.timeIntervalSince(date) <= 300
      } ?? false
      if !snapshotIsRecent, let snapshot = state.snapshot {
        state.snapshot = state.draftNavigation(from: snapshot)
        state.snapshotSavedAt = nil
      }
    }
    return state
  }
  func load(for namespace: CacheNamespace) throws -> CompanionSavedState? {
    do {
      let target = try file(for: namespace)
      try prepare()
      return try read(target, namespace: namespace).map(pruned)
    } catch { throw failure }
  }
  func save(_ original: CompanionSavedState) throws {
    do {
      guard original.version == 1 else { throw failure }
      let target = try file(for: original.namespace)
      try prepare()
      // Never overwrite unreadable state: it may contain the only unresolved-send identity.
      _ = try read(target, namespace: original.namespace)
      var state = pruned(original)
      let encoder = JSONEncoder()
      encoder.outputFormatting = .sortedKeys
      var bytes = try encoder.encode(state)
      while bytes.count > limit, !state.conversations.isEmpty {
        let oldest = state.conversations.indices.min {
          state.conversations[$0].savedAt < state.conversations[$1].savedAt
        }!
        state.conversations.remove(at: oldest)
        bytes = try encoder.encode(state)
      }
      guard bytes.count <= limit else { throw failure }
      try bytes.write(to: target, options: [.atomic, .completeFileProtection])
      try manager.setAttributes([.posixPermissions: 0o600], ofItemAtPath: target.path)
      var mutable = target
      var values = URLResourceValues()
      values.isExcludedFromBackup = true
      try mutable.setResourceValues(values)
    } catch { throw failure }
  }
  func erase(for namespace: CacheNamespace) throws {
    do {
      let target = try file(for: namespace)
      try prepare()
      guard let value = try attributes(target) else { return }
      guard value[.type] as? FileAttributeType == .typeRegular else { throw failure }
      try manager.removeItem(at: target)
    } catch { throw failure }
  }
  func eraseUnpairedData() throws {
    do {
      try prepare()
      for item in try manager.contentsOfDirectory(at: installDirectory, includingPropertiesForKeys: nil) {
        guard try attributes(item)?[.type] as? FileAttributeType == .typeRegular else { throw failure }
        try manager.removeItem(at: item)
      }
    } catch { throw failure }
  }
}
