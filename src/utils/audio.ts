import * as fs from 'fs';
import * as path from 'path';

/**
 * Create a silent WAV file of the given duration.
 * Uses no FFmpeg lavfi — works on builds without libavfilter virtual inputs.
 *
 * @param outputDir Directory to write the file (e.g. tmp)
 * @param durationSeconds Duration in seconds
 * @param sampleRate Sample rate (default 44100)
 * @returns Path to the created WAV file
 */
export function createSilentWav(
  outputDir: string,
  durationSeconds: number,
  sampleRate: number = 44100
): string {
  const numChannels = 2; // stereo
  const bitsPerSample = 16;
  const bytesPerSample = bitsPerSample / 8;
  const blockAlign = numChannels * bytesPerSample;
  const byteRate = sampleRate * blockAlign;
  const numSamples = Math.ceil(sampleRate * numChannels * durationSeconds);
  const dataSize = numSamples * bytesPerSample;
  const riffSize = 36 + dataSize; // Size of file from "WAVE" onward (RIFF size field)

  fs.mkdirSync(outputDir, { recursive: true });
  const wavPath = path.join(outputDir, `silence_${durationSeconds.toFixed(1).replace('.', '_')}s.wav`);

  const buf = Buffer.alloc(44 + dataSize);
  let offset = 0;

  // RIFF header
  buf.write('RIFF', offset); offset += 4;
  buf.writeUInt32LE(riffSize, offset); offset += 4;
  buf.write('WAVE', offset); offset += 4;

  // fmt subchunk
  buf.write('fmt ', offset); offset += 4;
  buf.writeUInt32LE(16, offset); offset += 4; // fmt chunk size (PCM)
  buf.writeUInt16LE(1, offset); offset += 2;   // audio format (PCM)
  buf.writeUInt16LE(numChannels, offset); offset += 2;
  buf.writeUInt32LE(sampleRate, offset); offset += 4;
  buf.writeUInt32LE(byteRate, offset); offset += 4;
  buf.writeUInt16LE(blockAlign, offset); offset += 2;
  buf.writeUInt16LE(bitsPerSample, offset); offset += 2;

  // data subchunk
  buf.write('data', offset); offset += 4;
  buf.writeUInt32LE(dataSize, offset); offset += 4;
  // rest is zeros (Buffer.alloc initializes to 0)

  fs.writeFileSync(wavPath, buf);
  return wavPath;
}
