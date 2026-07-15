import Foundation

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

switch SystemLanguageModel.default.availability {
case .available:
    break
case .unavailable(let reason):
    fputs("Error: Apple Intelligence unavailable \u{2014} \(reason)\n", stderr)
    exit(1)
@unknown default:
    fputs("Error: unknown model availability state\n", stderr)
    exit(1)
}

// MARK: - Session setup
//
// --instructions maps directly to Transcript.Instructions
// which is Apple's term for what other frameworks call a system prompt.

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
// All parameter names mirror GenerationOptions API exactly:
//   --temperature              → GenerationOptions.temperature
//   --maximum-response-tokens  → GenerationOptions.maximumResponseTokens

var temperature: Double = 0.7
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
    fputs("Error: inference failed \u{2014} \(error)\n", stderr)
    exit(1)
}

#else
fputs("Error: FoundationModels framework not available on this platform\n", stderr)
exit(1)
#endif
