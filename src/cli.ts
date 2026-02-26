#!/usr/bin/env node

import { Command } from 'commander';
import * as fs from 'fs';
import * as path from 'path';
import { Pipeline } from './core/pipeline';
import { PipelineConfig } from './core/types';
import { createLogger } from './utils/logger';
import { formatTime } from './utils/timing';

const logger = createLogger('CLI');

const program = new Command();

program
  .name('auto-broll')
  .description('Generate B-roll screen recordings from voiceover transcripts')
  .version('0.1.0');

program
  .command('run')
  .description('Run the full B-roll generation pipeline')
  .requiredOption('-c, --config <path>', 'Path to pipeline config JSON file')
  .action(async (opts) => {
    try {
      const configPath = path.resolve(opts.config);
      if (!fs.existsSync(configPath)) {
        logger.error(`Config file not found: ${configPath}`);
        process.exit(1);
      }

      const rawConfig = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      const config = resolveConfig(rawConfig, path.dirname(configPath));

      logger.info('Starting B-roll generation pipeline...');
      const pipeline = new Pipeline(config);

      // Listen for pipeline events
      pipeline.on('event', (event) => {
        switch (event.type) {
          case 'analysis-start':
            logger.info('Analyzing transcript...');
            break;
          case 'analysis-complete':
            logger.info(`Found ${event.topics.length} topics.`);
            for (const t of event.topics) {
              logger.info(`  - ${t.topic}: ${t.suggestedActions.join(', ')}`);
            }
            break;
          case 'recording-start':
            logger.info(`Recording [${event.action}]: "${event.topic.topic}"`);
            break;
          case 'recording-complete':
            logger.info(
              `  Done (${event.segment.durationSeconds.toFixed(1)}s) -> ${event.segment.filePath}`
            );
            break;
          case 'assembly-start':
            logger.info('Assembling final video...');
            break;
          case 'assembly-complete':
            logger.info(`Output: ${event.outputPath}`);
            break;
          case 'error':
            logger.error(event.message);
            break;
        }
      });

      const result = await pipeline.run();
      logger.info(
        `Pipeline complete. ${result.segments.length} segments, ` +
        `total duration: ${formatTime(result.durationSeconds)}`
      );
      logger.info(`Final video: ${result.outputPath}`);
    } catch (err) {
      logger.error(`Pipeline failed: ${err}`);
      process.exit(1);
    }
  });

program
  .command('analyze')
  .description('Analyze a transcript and show extracted topics (no recording)')
  .requiredOption('-c, --config <path>', 'Path to pipeline config JSON file')
  .action(async (opts) => {
    try {
      const configPath = path.resolve(opts.config);
      const rawConfig = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      const config = resolveConfig(rawConfig, path.dirname(configPath));

      const { TranscriptAnalyzer } = await import('./modules/transcript-analyzer');
      const { parseTranscript } = await import('./utils/transcript-parser');

      const segments = parseTranscript(config.transcriptPath);
      logger.info(`Parsed ${segments.length} transcript segments.`);

      const analyzer = new TranscriptAnalyzer(config, createLogger('Analyzer'));
      const topics = await analyzer.analyze(segments);

      console.log('\n=== Extracted Topics ===\n');
      for (const topic of topics) {
        console.log(`Topic: ${topic.topic}`);
        console.log(`  Description: ${topic.description}`);
        console.log(`  Suggested actions: ${topic.suggestedActions.join(', ')}`);
        console.log(`  Transcript coverage: ${formatTime(topic.segments[0]?.startTime ?? 0)} - ${formatTime(topic.segments[topic.segments.length - 1]?.endTime ?? 0)}`);
        console.log();
      }
    } catch (err) {
      logger.error(`Analysis failed: ${err}`);
      process.exit(1);
    }
  });

program
  .command('init')
  .description('Generate a starter config file')
  .option('-o, --output <path>', 'Output path for config', './broll-config.json')
  .action((opts) => {
    const template: PipelineConfig = {
      transcriptPath: './transcript.srt',
      audioPath: './voiceover.mp3',
      outputDir: './output',
      viewport: { width: 1920, height: 1080 },
      searchEngine: 'google',
      llm: {
        provider: 'deepseek',
        apiKey: 'YOUR_API_KEY_HERE',
        model: 'deepseek-chat',
      },
      modules: {
        'web-search': { enabled: true },
        'news-search': { enabled: true },
        'definition-search': { enabled: true },
        'image-search': { enabled: true },
      },
      mouseStyle: 'realistic',
      video: {
        fps: 30,
        resolution: { width: 1920, height: 1080 },
        format: 'mp4',
      },
      sfx: {
        enabled: false,
        libraryPath: './sfx-library',
        volume: 0.4,
        mouseClick: {
          enabled: true,
          samplesDir: 'clicks',
        },
        keyboardTyping: {
          enabled: true,
          samplesDir: 'typing',
        },
      },
      camera: {
        enabled: true,
        maxZoom: 1.4,
        transitionMs: 800,
        easing: 'ease-in-out',
      },
      typing: {
        baseDelayMs: 80,
        inconsistency: 0.35,
        mistakeProbability: 0.08,
        maxMistakeLength: 2,
        thinkPause: { minMs: 100, maxMs: 300 },
      },
    };

    const outPath = path.resolve(opts.output);
    fs.writeFileSync(outPath, JSON.stringify(template, null, 2));
    logger.info(`Config template written to: ${outPath}`);
    logger.info('Edit the config with your API keys and file paths, then run:');
    logger.info('  auto-broll run --config ./broll-config.json');
  });

program
  .command('record-typing')
  .description('Record typing audio with keystroke logging for the SFX library')
  .requiredOption('-o, --output <dir>', 'Output directory for audio clips + metadata')
  .option('-b, --backend <backend>', 'Audio capture backend: ffmpeg, arecord, or sox', 'ffmpeg')
  .option('-r, --sample-rate <rate>', 'Audio sample rate', '44100')
  .option('-f, --format <format>', 'Audio format: wav or flac', 'wav')
  .action(async (opts) => {
    try {
      const { KeystrokeRecorder } = await import('./keystroke-recorder/recorder');

      const recorder = new KeystrokeRecorder({
        outputDir: path.resolve(opts.output),
        sampleRate: parseInt(opts.sampleRate, 10),
        audioFormat: opts.format,
        audioBackend: opts.backend,
        logger: createLogger('Recorder'),
      });

      const clips = await recorder.runInteractiveSession();

      console.log(`\n=== Session Summary ===`);
      console.log(`Recorded ${clips.length} typing clips.`);
      for (const clip of clips) {
        console.log(
          `  ${clip.audioFile}: ${clip.wordCount} words, ` +
          `${clip.keystrokes.length} keystrokes, ` +
          `${clip.backspaceSequences} corrections, ` +
          `${(clip.durationMs / 1000).toFixed(1)}s`
        );
      }
      console.log(`\nClips saved to: ${path.resolve(opts.output)}`);
      console.log('Use these as the typing SFX library in your pipeline config.');
    } catch (err) {
      logger.error(`Recording session failed: ${err}`);
      process.exit(1);
    }
  });

/** Resolve relative paths in config relative to the config file's directory. */
function resolveConfig(raw: PipelineConfig, baseDir: string): PipelineConfig {
  return {
    ...raw,
    transcriptPath: path.resolve(baseDir, raw.transcriptPath),
    audioPath: path.resolve(baseDir, raw.audioPath),
    outputDir: path.resolve(baseDir, raw.outputDir),
  };
}

program.parse();
