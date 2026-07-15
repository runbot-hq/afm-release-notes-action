// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "afm-cli",
    platforms: [
        .macOS(.v26)
    ],
    targets: [
        .executableTarget(
            name: "afm-cli",
            path: "Sources/afm-cli"
        )
    ]
)
