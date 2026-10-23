import SwiftUI

@main
struct S2CodeTVApp: App {
  @State private var model = TVModel()

  var body: some Scene {
    WindowGroup {
      if model.servers.isEmpty || model.addingServer {
        SetupView(model: model)
      } else {
        DashboardView(model: model)
      }
    }
  }
}
