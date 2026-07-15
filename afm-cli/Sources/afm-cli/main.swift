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
    fputs("Usage: afm-cli --prompt <text>\n", stderr)
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
    fputs("Error: Apple Intelligence unavailable — \(reason)\n", stderr)
    exit(1)
@unknown default:
    fputs("Error: unknown model availability state\n", stderr)
    exit(1)
}

// MARK: - Optional system prompt via --system-prompt flag

var systemPrompt: String? = nil
if let sysIdx = CommandLine.arguments.firstIndex(of: "--system-prompt"),
   CommandLine.arguments.indices.contains(sysIdx + 1) {
    systemPrompt = CommandLine.arguments[sysIdx + 1]
}

// MARK: - Session setup

let session: LanguageModelSession

if let sys = systemPrompt {
    let instructions = Transcript.Instructions(
        segments: [.text(.init(content: sys))],
        toolDefinitions: []
    )
    session = LanguageModelSession(
        transcript: Transcript(entries: [.instructions(instructions)])
    )
} else {
    session = LanguageModelSession()
}

// MARK: - Generation options

var temperature: Double = 0.7
var maxTokens: Int = 2048

if let tIdx = CommandLine.arguments.firstIndex(of: "--temperature"),
   CommandLine.arguments.indices.contains(tIdx + 1),
   let t = Double(CommandLine.arguments[tIdx + 1]) {
    temperature = t
}

if let mIdx = CommandLine.arguments.firstIndex(of: "--max-tokens"),
   CommandLine.arguments.indices.contains(mIdx + 1),
   let m = Int(CommandLine.arguments[mIdx + 1]) {
    maxTokens = m
}

let options = GenerationOptions(
    temperature: temperature,
    maximumResponseTokens: maxTokens
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
