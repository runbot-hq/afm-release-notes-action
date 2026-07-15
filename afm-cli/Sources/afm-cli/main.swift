import Foundation

// afm-cli: a thin, domain-ignorant pass-through to Apple FoundationModels.
//
// Design principles:
//   1. No domain knowledge. This binary knows nothing about release notes,
//      JSON schemas, or output formats. It takes text in, returns text out.
//   2. Flag names mirror the FoundationModels API exactly — no invented vocabulary.
//      --instructions             → Transcript.Instructions (Apple's term, not "system prompt")
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

guard #available(macOS 26.0, *) else {
    fputs("Error: afm-cli requires macOS 26+\n", stderr)
    exit(1)
}

// MARK: - Argument parsing

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
// --instructions maps to Transcript.Instructions, which is Apple's API term
// for what other frameworks call a "system prompt". We use Apple's naming
// deliberately so flag names remain 1:1 aliases for API parameters.
//
// Transcript.Instructions is passed at session construction, not appended to
// the user prompt string. Apple treats these differently internally — using
// Transcript.Instructions gives better model behaviour than prepending text
// to --prompt. Do NOT collapse these into a single --prompt argument.

let session: LanguageModelSession

if let iIdx = CommandLine.arguments.firstIndex(of: "--instructions"),
   CommandLine.arguments.indices.contains(iIdx + 1) {
    let instructionText = CommandLine.arguments[iIdx + 1]
    let instructions = Transcript.Instructions(
        segments: [.text(.init(content: instructionText))],
        toolDefinitions: []
    )
    session = LanguageModelSession(
        transcript: Transcript(entries: [.instructions(instructions)])
    )
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

let options = GenerationOptions(
    temperature: temperature,
    maximumResponseTokens: maximumResponseTokens
)

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
