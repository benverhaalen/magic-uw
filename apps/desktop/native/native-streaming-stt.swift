import AVFAudio
import Foundation
import Speech

// Private helper. One JSON command per line on stdin; one JSON event per line on stdout.
// It never opens a microphone, requests permission, downloads an asset, or uses SFSpeechRecognizer.
private struct Command: Decodable {
    let type: String
    let session: String?
    let locale: String?
    let seq: Int?
    let pcm: String?
}

private final class Wire: @unchecked Sendable {
    private let lock = NSLock()
    func send(_ fields: [String: Any]) {
        guard JSONSerialization.isValidJSONObject(fields),
              let data = try? JSONSerialization.data(withJSONObject: fields),
              var line = String(data: data, encoding: .utf8) else { return }
        line += "\n"
        lock.lock(); defer { lock.unlock() }
        FileHandle.standardOutput.write(Data(line.utf8))
    }
}

private actor Recognizer {
    private let wire: Wire
    private var session: String?
    private var input: AsyncStream<AnalyzerInput>.Continuation?
    private var analyzer: SpeechAnalyzer?
    private var audioFormat: AVAudioFormat?
    private var resultTask: Task<Void, Never>?
    private var analysisTask: Task<Void, Never>?
    private var confirmed = ""
    private var tentative = ""
    private var frames = 0
    private var generation = 0

    init(wire: Wire) { self.wire = wire }

    private func emitText(_ result: SpeechTranscriber.Result, generation expected: Int) {
        guard expected == generation, let session else { return }
        let text = String(result.text.characters)
        if result.isFinal {
            confirmed += text
            tentative = ""
        } else {
            tentative = text
        }
        let combined = confirmed + tentative
        wire.send(["type": result.isFinal ? "final" : "partial", "session": session,
                   "text": text, "display": String(combined.suffix(100)),
                   "finalText": confirmed, "isFinal": result.isFinal])
    }

    private func failed(_ reason: String, generation expected: Int) async {
        guard expected == generation, let session else { return }
        wire.send(["type": "fallback", "session": session, "reason": reason, "backend": "local-whisper"])
        await stop(session: session)
    }

    func start(session id: String, locale identifier: String) async {
        guard session == nil, id.count > 0, id.count <= 128 else {
            wire.send(["type": "fallback", "session": id, "reason": "invalid-session", "backend": "local-whisper"])
            return
        }
        guard SpeechTranscriber.isAvailable else {
            wire.send(["type": "fallback", "session": id, "reason": "device-unavailable", "backend": "local-whisper"])
            return
        }
        let requested = Locale(identifier: identifier)
        guard let supported = await SpeechTranscriber.supportedLocale(equivalentTo: requested) else {
            wire.send(["type": "fallback", "session": id, "reason": "locale-unsupported", "backend": "local-whisper"])
            return
        }
        let installed = await SpeechTranscriber.installedLocales
        guard installed.contains(where: { $0.identifier == supported.identifier }) else {
            wire.send(["type": "fallback", "session": id, "reason": "model-missing", "backend": "local-whisper"])
            return
        }
        let transcriber = SpeechTranscriber(locale: supported, transcriptionOptions: [],
                                            reportingOptions: [.volatileResults, .fastResults], attributeOptions: [])
        guard let format = await SpeechAnalyzer.bestAvailableAudioFormat(compatibleWith: [transcriber]),
              format.sampleRate == 16_000, format.channelCount == 1,
              format.commonFormat == .pcmFormatInt16 else {
            wire.send(["type": "fallback", "session": id, "reason": "format-unavailable", "backend": "local-whisper"])
            return
        }
        let newAnalyzer = SpeechAnalyzer(modules: [transcriber])
        do { try await newAnalyzer.prepareToAnalyze(in: format) }
        catch {
            wire.send(["type": "fallback", "session": id, "reason": "prepare-failed", "backend": "local-whisper"])
            return
        }
        generation += 1
        let current = generation
        let (stream, continuation) = AsyncStream.makeStream(of: AnalyzerInput.self, bufferingPolicy: .bufferingOldest(4))
        session = id; input = continuation; analyzer = newAnalyzer; audioFormat = format
        confirmed = ""; tentative = ""; frames = 0
        resultTask = Task {
            do {
                for try await result in transcriber.results { self.emitText(result, generation: current) }
            } catch { await self.failed("results-failed", generation: current) }
        }
        analysisTask = Task {
            do {
                let last = try await newAnalyzer.analyzeSequence(stream)
                if let last { try await newAnalyzer.finalizeAndFinish(through: last) }
                else { await newAnalyzer.cancelAndFinishNow() }
            } catch { await self.failed("analysis-failed", generation: current) }
        }
        wire.send(["type": "ready", "session": id, "backend": "speech-transcriber", "locale": supported.identifier,
                   "sampleRate": 16_000, "channels": 1, "sampleFormat": "s16le", "maxFrameSamples": 3200])
    }

    func audio(session id: String, seq: Int, encoded: String) async {
        guard id == session, let input else { return }
        guard seq == frames, let data = Data(base64Encoded: encoded), data.count > 0,
              data.count <= 6400, data.count.isMultiple(of: 2),
              let format = audioFormat,
              let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(data.count / 2)),
              let destination = buffer.int16ChannelData?[0] else {
            await failed("invalid-pcm", generation: generation); return
        }
        data.withUnsafeBytes { bytes in
            if let source = bytes.baseAddress { memcpy(destination, source, data.count) }
        }
        buffer.frameLength = AVAudioFrameCount(data.count / 2)
        guard case .enqueued = input.yield(AnalyzerInput(buffer: buffer)) else {
            await failed("frame-overrun", generation: generation); return
        }
        frames += 1
        wire.send(["type": "ack", "session": id, "seq": seq])
    }

    func end(session id: String) async {
        guard id == session else { return }
        input?.finish(); input = nil
        // Analysis task finalizes once queued input is consumed. Result stream then terminates.
        let current = generation
        Task {
            await analysisTask?.value
            await resultTask?.value
            self.ended(session: id, generation: current)
        }
    }

    private func ended(session id: String, generation expected: Int) {
        guard expected == generation, id == session else { return }
        wire.send(["type": "ended", "session": id, "text": confirmed])
        session = nil; analyzer = nil; audioFormat = nil; resultTask = nil; analysisTask = nil
    }

    func stop(session id: String?) async {
        guard let current = session, id == nil || id == current else { return }
        generation += 1 // fence all queued partials and finalizers first
        session = nil; confirmed = ""; tentative = ""
        input?.finish(); input = nil
        resultTask?.cancel(); analysisTask?.cancel()
        let old = analyzer
        analyzer = nil; audioFormat = nil; resultTask = nil; analysisTask = nil
        wire.send(["type": "stopped", "session": current])
        Task { await old?.cancelAndFinishNow() }
    }
}

@main struct NativeStreamingSTT {
    static func main() async {
        let wire = Wire()
        let recognizer = Recognizer(wire: wire)
        while let line = readLine(strippingNewline: true) {
            guard line.utf8.count <= 12_000, let command = try? JSONDecoder().decode(Command.self, from: Data(line.utf8)) else {
                wire.send(["type": "protocol-error"]); continue
            }
            switch command.type {
            case "start":
                await recognizer.start(session: command.session ?? "", locale: command.locale ?? "en_US")
            case "audio":
                if let session = command.session, let seq = command.seq, let pcm = command.pcm {
                    await recognizer.audio(session: session, seq: seq, encoded: pcm)
                }
            case "end":
                if let session = command.session { await recognizer.end(session: session) }
            case "stop":
                await recognizer.stop(session: command.session)
            default: wire.send(["type": "protocol-error"])
            }
        }
        await recognizer.stop(session: nil)
    }
}
