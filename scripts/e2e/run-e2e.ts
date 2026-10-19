/**
 * End-to-end run against the local mock search engine.
 *
 * Records real clips in a real (headed) Chrome with the settings from
 * config-car-wash.json, assembles the final video over the first N seconds of
 * the car-wash voiceover, and writes a contact sheet of the result — so a
 * change can be checked by looking at the output, without an LLM key or a
 * search engine that may answer with a bot check.
 *
 *   npx ts-node scripts/e2e/run-e2e.ts [--seconds 90] [--out ./output-e2e] [--fresh]
 *
 * Needs Chrome/Chromium (CHROME_PATH) and FFmpeg. On a machine without a
 * display, wrap it in: xvfb-run -a -s "-screen 0 1920x1080x24"
 */
import * as child_process from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { Pipeline } from '../../src/core/pipeline';
import { ExtractedTopic, PipelineConfig } from '../../src/core/types';
import { parseTranscript } from '../../src/utils/transcript-parser';
import { startMockSearchServer } from './mock-search-server';

const ROOT = path.resolve(__dirname, '..', '..');

/** Topics for the car-wash transcript: [name, segment indices, actions]. */
const TOPICS: Array<[string, number[], ExtractedTopic['suggestedActions']]> = [
  ['carwash conundrum', [0, 1], ['web-search']],
  ['ai hallucination', [3, 4, 5], ['definition-search', 'image-search']],
  ['world modeling in ai', [6, 7, 8], ['news-search']],
  ['llm internal state', [9, 10], ['web-search']],
  ['ai sycophancy', [14, 15, 16], ['image-search']],
];

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

function run(cmd: string, args: string[]): void {
  const result = child_process.spawnSync(cmd, args, { encoding: 'utf-8' });
  if (result.status !== 0) throw new Error(`${cmd} failed: ${result.stderr?.slice(-500)}`);
}

/** Tile frames from evenly spaced points of a video into one image. */
function contactSheet(videoPath: string, outPath: string, durationSec: number, frames = 12): void {
  const step = durationSec / frames;
  const tmp = fs.mkdtempSync(path.join(path.dirname(outPath), 'sheet-'));
  for (let i = 0; i < frames; i++) {
    const t = (i + 0.5) * step;
    run('ffmpeg', [
      '-loglevel', 'error', '-y', '-ss', t.toFixed(2), '-i', videoPath, '-frames:v', '1',
      '-vf', 'scale=480:270:force_original_aspect_ratio=decrease,pad=480:270:(ow-iw)/2:(oh-ih)/2,' +
        `drawtext=text='${t.toFixed(1)}s':x=8:y=8:fontsize=20:fontcolor=white:box=1:boxcolor=black@0.6`,
      path.join(tmp, `f${String(i).padStart(2, '0')}.png`),
    ]);
  }
  run('ffmpeg', [
    '-loglevel', 'error', '-y', '-pattern_type', 'glob', '-i', path.join(tmp, 'f*.png'),
    '-vf', 'tile=4x3', '-frames:v', '1', outPath,
  ]);
  fs.rmSync(tmp, { recursive: true, force: true });
}

async function main(): Promise<void> {
  const seconds = Number(arg('seconds', '90'));
  const outputDir = path.resolve(arg('out', path.join(ROOT, 'output-e2e')));
  fs.mkdirSync(outputDir, { recursive: true });
  if (process.argv.includes('--fresh')) {
    fs.rmSync(path.join(outputDir, 'clips'), { recursive: true, force: true });
  }

  // Voiceover: the first N seconds of the car-wash narration
  const audioPath = path.join(outputDir, 'voiceover.wav');
  run('ffmpeg', ['-loglevel', 'error', '-y', '-t', String(seconds),
    '-i', path.join(ROOT, 'drive or walk to car wash.mp3'), audioPath]);

  const transcriptPath = path.join(ROOT, 'drive-or-walk-transcript.srt');
  const segments = parseTranscript(transcriptPath);
  const topics: ExtractedTopic[] = TOPICS
    .map(([topic, indices, suggestedActions]) => ({
      topic,
      description: topic,
      segments: indices.map((i) => segments[i]),
      suggestedActions,
    }))
    .filter((t) => t.segments[0].startTime < seconds);

  // Seed the topics cache so the pipeline skips the LLM
  fs.writeFileSync(path.join(outputDir, 'topics-cache.json'), JSON.stringify({
    transcriptPath,
    transcriptMtime: fs.statSync(transcriptPath).mtimeMs,
    topics,
  }, null, 2));

  const mock = await startMockSearchServer();
  process.env.BROLL_SEARCH_URL_OVERRIDE = mock.url;
  if (process.getuid?.() === 0) process.env.BROLL_NO_SANDBOX = '1';
  // Real sites behind result links are reached through the environment's proxy, if any
  if (process.env.HTTPS_PROXY && !process.env.BROLL_PROXY) {
    process.env.BROLL_PROXY = `https=${process.env.HTTPS_PROXY.replace(/^https?:\/\//, '')}`;
  }

  const baseConfig = JSON.parse(fs.readFileSync(path.join(ROOT, 'config-car-wash.json'), 'utf-8'));
  const config: PipelineConfig = {
    ...baseConfig,
    transcriptPath,
    audioPath,
    outputDir,
    browserExecutablePath: process.env.CHROME_PATH ?? '/opt/pw-browsers/chromium',
    llm: { ...baseConfig.llm, apiKey: 'unused-topics-are-cached' },
    sfx: baseConfig.sfx && { ...baseConfig.sfx, libraryPath: path.join(ROOT, baseConfig.sfx.libraryPath) },
  };

  const pipeline = new Pipeline(config);
  pipeline.on('event', (event) => {
    if (event.type === 'recording-start') console.log(`▶ ${event.action}: "${event.topic.topic}"`);
    if (event.type === 'recording-skip') console.log(`↺ reused ${path.basename(event.segment.filePath)}`);
  });

  try {
    const result = await pipeline.run();
    const sheetPath = path.join(outputDir, 'contact-sheet.png');
    contactSheet(result.outputPath, sheetPath, seconds);
    console.log(`\nFinal video:   ${result.outputPath}`);
    console.log(`Contact sheet: ${sheetPath}`);
  } finally {
    await mock.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
