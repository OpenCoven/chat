import SwiftUI

@main struct ChatCompanionApp: App {
  @State private var model = CompanionModel(store: KeychainPairingStore())
  var body: some Scene { WindowGroup { CompanionRoot(model: model) } }
}
