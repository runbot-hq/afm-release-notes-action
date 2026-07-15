// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "afm-cli",
    platforms: [
        // .v26 is not available in PackageDescription 6.0 (requires 6.2).
        // Runtime availability is enforced via #available(macOS 26.0, *) and
        // #if canImport(FoundationModels) in main.swift — no compile-time gate needed.
        .macOS(.v15)
    ],
    targets: [
        .executableTarget(
            name: "afm-cli",
            path: "Sources/afm-cli"
        )
    ]
)
