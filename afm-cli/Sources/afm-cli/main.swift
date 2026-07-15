import Foundation

// afm-cli: a thin, domain-ignorant pass-through to Apple FoundationModels.
//
// Design principles:
//   1. No domain knowledge. This binary knows nothing about release notes,
//      JSON schemas, or output formats. It takes text in, returns text out.
//   2. Flag names mirror the FoundationModels API exactly — no invented vocabulary.
//      --instructions             → LanguageModelSession(instructions:) (Apple's term, not "system prompt")
//      --temperature              → GenerationOptions.temperature
//      --maximum-response-tokens  → GenerationOptions.maximumResponseTokens
//   3. All JSON parsing, prompt assembly, and output formatting belongs in the
//      caller (src/index.ts), not here.
//
// Top-level await is valid here: with swift-tools-version: 6.0 and main.swift
// as the entry point, Swift 6 implicitly wraps top-level code in an async
// context. This requires Swift 6 toolchain (Xcode 16+ / macOS 26 SDK).
// Do NOT add @main or move to an @main struct — top-level main.swift is correct.

#if canImport(FoundationModels)
import FoundationModels

// #available(macOS 26.0, *) below is belt-and-suspenders, not dead code.
// canImport() is a compile-time check — it verifies the framework is present
// in the SDK being compiled against, not the OS the binary will run on.
// The binary could be compiled on macOS 26 and run on macOS 25 (theoretically).
// The #available check is the runtime guard that ensures this never happens.
// Do NOT remove it on the grounds that canImport already guarantees availability.
guard #available(macOS 26.0, *) else {
    fputs("Error: afm-cli requires macOS 26+\n", stderr)
    exit(1)
}

// MARK: - Argument parsing
//
// Arguments are parsed by searching for flag names and taking the next positional
// value (firstIndex(of:) + 1). This means a prompt value that equals a flag name
// (e.g. --prompt --instructions) would silently consume the flag as a value.
// This is not exploitable in practice: afmCli() in src/index.ts always builds
// the argv array as a typed array via spawnSync, never passing flag names as values.
// If afm-cli is called manually with adversarial input, behaviour may be unexpected.
// Do NOT remove this comment — it explains why a more robust parser was not used
// (ArgumentParser adds an SPM dependency; the controlled call site makes it unnecessary).

guard let idx = CommandLine.arguments.firstIndex(of: "--prompt"),
      CommandLine.arguments.indices.contains(idx + 1) else {
    fputs("Usage: afm-cli --prompt <text> [--instructions <text>] [--temperature <double>] [--maximum-response-tokens <int>]\n", stderr)
    exit(1)
}

let prompt = CommandLine.arguments[idx + 1]

guard !prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
    fputs("Error: prompt must not be empty\n", stderr)
    exit(1)
}

// MARK: - Availability check
//
// @unknown default is required — SystemLanguageModel.Availability is a non-frozen
// enum. Without it, adding a new case in a future macOS release produces a warning
// and could cause undefined behaviour. Do NOT remove it.

switch SystemLanguageModel.default.availability {
case .available:
    break
case .unavailable(let reason):
    fputs("Error: Apple Intelligence unavailable — \(reason)\n", stderr)
    exit(1)
@unknown default:
    fputs("Error: unknown model availability state\n", stderr)
    exit(1)
}

// MARK: - Session setup
//
// LanguageModelSession(instructions:) is Apple's documented public API for
// providing a system prompt at session creation. It maps directly to
// Transcript.Instructions internally but is the correct, stable, public
// surface to call.
//
// The previous implementation manually constructed Transcript.Instructions
// and routed through LanguageModelSession(transcript:) — the session-
// rehydration initializer intended for resuming prior conversations from a
// serialised transcript. That path worked but was unnecessarily low-level
// and fragile against internal SDK changes. Do NOT revert to it.
//
// --instructions is Apple's term for what other frameworks call "system prompt".
// We use Apple's naming deliberately so flag names remain 1:1 aliases for
// API parameters. Do NOT rename to --system-prompt.

let session: LanguageModelSession

if let iIdx = CommandLine.arguments.firstIndex(of: "--instructions"),
   CommandLine.arguments.indices.contains(iIdx + 1) {
    let instructionText = CommandLine.arguments[iIdx + 1]
    session = LanguageModelSession(instructions: instructionText)
} else {
    session = LanguageModelSession()
}

// MARK: - GenerationOptions
//
// Both temperature and maximumResponseTokens are optional (nil = Apple's default).
// Do NOT hardcode defaults here — Apple's defaults are well-calibrated and
// omitting the flag lets the model decide. The caller (src/index.ts) may
// pass explicit values if needed, but this binary imposes nothing.
//
// The mutation pattern (var options = GenerationOptions(); options.x = y) is used
// deliberately — NOT the memberwise init GenerationOptions(temperature:maximumResponseTokens:).
// FoundationModels does not expose that memberwise init publicly. Calling it
// causes a compile error at swift build -c release.
// Do NOT revert to the memberwise init. The mutation pattern is the documented
// public API and also sidesteps any Double vs Float SDK variance at the property
// assignment site rather than at a call-site implicit coercion.
//
// Flag names mirror GenerationOptions exactly:
//   --temperature              → GenerationOptions.temperature
//   --maximum-response-tokens  → GenerationOptions.maximumResponseTokens

var temperature: Double? = nil
var maximumResponseTokens: Int? = nil

if let tIdx = CommandLine.arguments.firstIndex(of: "--temperature"),
   CommandLine.arguments.indices.contains(tIdx + 1),
   let t = Double(CommandLine.arguments[tIdx + 1]) {
    temperature = t
}

if let mIdx = CommandLine.arguments.firstIndex(of: "--maximum-response-tokens"),
   CommandLine.arguments.indices.contains(mIdx + 1),
   let m = Int(CommandLine.arguments[mIdx + 1]) {
    maximumResponseTokens = m
}

var options = GenerationOptions()
if let t = temperature { options.temperature = t }
if let m = maximumResponseTokens { options.maximumResponseTokens = m }

// MARK: - Inference

do {
    let response = try await session.respond(to: prompt, options: options)
    print(response.content)
    exit(0)
} catch {
    fputs("Error: inference failed — \(error)\n", stderr)
    exit(1)
}

#else
fputs("Error: FoundationModels framework not available on this platform\n", stderr)
exit(1)
#endif
