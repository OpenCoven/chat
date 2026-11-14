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

struct DraftBinding: Codable, Equatable {
  var familiarID: String
  var sessionID: String?
}
struct SavedDraft: Codable, Equatable {
  var binding: DraftBinding
  var text: String
  var revision: UUID
  var updatedAt: Date
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
}

@MainActor protocol CompanionPersistence {
  func load(for namespace: CacheNamespace) throws -> CompanionSavedState?
  func save(_ state: CompanionSavedState) throws
  func erase(for namespace: CacheNamespace) throws
  func eraseUnpairedData() throws
}

