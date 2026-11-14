import SwiftUI

@main struct ChatCompanionApp: App {
  @State private var model: CompanionModel
  init() {
    let installationID = InstallIdentity().id
    let root = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
      .appendingPathComponent("CompanionCache", isDirectory: true)
    _model = State(initialValue: CompanionModel(
      store: KeychainPairingStore(),
      persistence: ProtectedCompanionStore(root: root, installationID: installationID),
      installationID: installationID))
  }
  var body: some Scene { WindowGroup { CompanionRoot(model: model) } }
}
