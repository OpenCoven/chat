import CryptoKit
import Foundation

struct CacheNamespace: Codable, Equatable {
  var installationID: Data
  var hostFingerprint: String
  var authorizationID: String

  init(installationID: Data, pairing: Pairing) {
    self.installationID = installationID
    hostFingerprint = pairing.fingerprint
    authorizationID = Self.digest(Data(pairing.token.utf8))
  }
  static func digest(_ bytes: Data) -> String {
    SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined()
  }
}

struct DraftBinding: Codable, Equatable, Hashable {
  var familiarID: String
  var sessionID: String?
}
struct SavedDraft: Codable, Equatable {
  var binding: DraftBinding
  var text: String
  var revision: UUID
  var updatedAt: Date
  var conversationTitle: String? = nil
}
struct CachedConversation: Codable {
  var familiarID: String
  var history: History
  var savedAt: Date
}
struct PendingCompanionOperation: Codable, Equatable {
  enum Kind: String, Codable { case send, allow }
  var requestID: String
  var kind: Kind
  var familiarID: String
  var sessionID: String?
  var payloadDigest: String
  var submittedDraftRevision: UUID?
  var createdAt: Date
}
struct CompanionSavedState: Codable {
  var version = 1
  var namespace: CacheNamespace
  var snapshot: Snapshot?
  var snapshotSavedAt: Date?
  var selectedFamiliarID: String?
  var drafts: [SavedDraft] = []
  var conversations: [CachedConversation] = []
  var pending: PendingCompanionOperation?
  var cacheConversationText = true

  /// Draft destinations outlive cached history; transcript, titles and live requests do not.
  func draftNavigation(from snapshot: Snapshot) -> Snapshot? {
    var needed = Set(drafts.map { $0.binding.familiarID })
    if let pending { needed.insert(pending.familiarID) }
    let familiars = snapshot.familiars.filter { needed.contains($0.id) }.map {
      Familiar(id: $0.id, name: $0.name, displayName: $0.displayName, emoji: $0.emoji)
    }
    guard !familiars.isEmpty else { return nil }
    return Snapshot(version: snapshot.version, familiars: familiars,
      sessions: snapshot.sessions.filter { needed.contains($0.familiarId) }.map {
        ChatSession(id: $0.id, familiarId: $0.familiarId, title: "", archived: $0.archived)
      }, activeRun: nil)
  }
}

@MainActor protocol CompanionPersistence {
  func load(for namespace: CacheNamespace) throws -> CompanionSavedState?
  func save(_ state: CompanionSavedState) throws
  func erase(for namespace: CacheNamespace) throws
  func eraseUnpairedData() throws
}
