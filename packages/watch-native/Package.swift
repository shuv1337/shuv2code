// swift-tools-version: 6.0
import PackageDescription

let package = Package(
  name: "T3WatchKit",
  platforms: [.watchOS("26.0"), .iOS("18.0"), .tvOS("26.0"), .macOS(.v15)],
  products: [
    .library(name: "T3WatchKit", targets: ["T3WatchKit"])
  ],
  targets: [
    .target(name: "T3WatchKit"),
    .testTarget(name: "T3WatchKitTests", dependencies: ["T3WatchKit"]),
  ],
  swiftLanguageModes: [.v6]
)
