#!/usr/bin/env node

import 'dotenv/config';

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
  .option('--debug', 'Enable debug logging')
  .option('--no-cache-topics', 'Force re-analyze transcript (ignore cached topics)')
  .action(async (opts) => {
    try {
      if (opts.debug) process.env.DEBUG = '1';

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
          case 'recording-skip':
            logger.info(`  Skipped (existing clip) -> ${event.segment.filePath}`);
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

      const result = await pipeline.run({
        noCacheTopics: opts.noCacheTopics === true || opts.cacheTopics === false,
      });
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
  .command('run-one')
  .description(
    'Run a single module for a single concept (no assembly). Debug enabled by default. Use --list-topics to see indices.'
  )
  .requiredOption('-c, --config <path>', 'Path to pipeline config JSON file')
  .option(
    '--topic-index <n>',
    'Topic index (0-based). Use --list-topics to see indices.',
    (v) => parseInt(v, 10)
  )
  .option(
    '--topic <string>',
    'Topic name (partial match). Ignored if --topic-index is set.'
  )
  .option(
    '--action <type>',
    'Module to run: web-search | news-search | definition-search | image-search (required unless --list-topics)'
  )
  .option('--list-topics', 'List topics with indices and exit')
  .option('--debug', 'Enable debug logging (default: on for run-one)')
  .option('--no-cache-topics', 'Force re-analyze transcript')
  .action(async (opts) => {
    try {
      process.env.DEBUG = '1';
      if (opts.debug === false) delete process.env.DEBUG;
      else if (opts.debug) process.env.DEBUG = '1';

      const configPath = path.resolve(opts.config);
      if (!fs.existsSync(configPath)) {
        logger.error(`Config file not found: ${configPath}`);
        process.exit(1);
      }

      const rawConfig = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      const config = resolveConfig(rawConfig, path.dirname(configPath));
      const pipeline = new Pipeline(config);

      const topics = await pipeline.getTopics({
        noCacheTopics: opts.noCacheTopics === true || opts.cacheTopics === false,
      });

      if (opts.listTopics) {
        logger.info(`Topics (use --topic-index N with run-one):`);
        topics.forEach((t, i) => {
          console.log(`  ${i}: ${t.topic}`);
          console.log(`     ${t.suggestedActions.join(', ')}`);
        });
        return;
      }

      const validActions = ['web-search', 'news-search', 'definition-search', 'image-search'];
      const actionType = opts.action as string | undefined;
      if (!actionType || !validActions.includes(actionType)) {
        logger.error(`--action required (unless --list-topics). Use one of: ${validActions.join(', ')}`);
        process.exit(1);
      }

      let topicIndex: number;
      if (opts.topicIndex !== undefined && !Number.isNaN(opts.topicIndex)) {
        topicIndex = opts.topicIndex;
      } else if (opts.topic && typeof opts.topic === 'string') {
        const needle = (opts.topic as string).toLowerCase();
        const i = topics.findIndex((t) => t.topic.toLowerCase().includes(needle));
        if (i === -1) {
          logger.error(`No topic matching "${opts.topic}". Use --list-topics to see topics.`);
          process.exit(1);
        }
        topicIndex = i;
        logger.info(`Matched topic index ${topicIndex}: "${topics[i].topic}"`);
      } else {
        logger.error('Provide --topic-index <n> or --topic <name>. Use --list-topics to see options.');
        process.exit(1);
      }

      pipeline.on('event', (event) => {
        switch (event.type) {
          case 'recording-start':
            logger.info(`Recording [${event.action}]: "${event.topic.topic}"`);
            break;
          case 'recording-complete':
            logger.info(`Done (${event.segment.durationSeconds.toFixed(1)}s) -> ${event.segment.filePath}`);
            break;
          case 'recording-skip':
            logger.info(`Skipped (existing) -> ${event.segment.filePath}`);
            break;
          default:
            break;
        }
      });

      const segment = await pipeline.runOne({
        topicIndex,
        action: actionType as 'web-search' | 'news-search' | 'definition-search' | 'image-search',
        noCacheTopics: opts.noCacheTopics === true || opts.cacheTopics === false,
      });
      logger.info(`Clip: ${segment.filePath}`);
    } catch (err) {
      logger.error(`run-one failed: ${err}`);
      process.exit(1);
    }
  });

program
  .command('transcribe')
  .description('Transcribe an audio file to SRT using OpenAI Whisper (requires OPENAI_API_KEY)')
  .requiredOption('-i, --input <path>', 'Path to audio file (MP3, WAV, M4A, etc.)')
  .option('-o, --output <path>', 'Output SRT path (default: same name as input with .srt)')
  .option('--force', 'Overwrite existing transcript (default: skip if output exists and is newer than input)')
  .action(async (opts) => {
    try {
      const OpenAI = (await import('openai')).default;
      const apiKey = process.env.OPENAI_API_KEY;
      if (!apiKey) {
        logger.error('OPENAI_API_KEY environment variable is required for transcribe.');
        process.exit(1);
      }
      const inputPath = path.resolve(opts.input);
      if (!fs.existsSync(inputPath)) {
        logger.error(`Input file not found: ${inputPath}`);
        process.exit(1);
      }
      const outputPath = opts.output
        ? path.resolve(opts.output)
        : inputPath.replace(/\.[^.]+$/i, '.srt');
      if (!opts.force && fs.existsSync(outputPath)) {
        const outStat = fs.statSync(outputPath);
        const inStat = fs.statSync(inputPath);
        if (outStat.mtime >= inStat.mtime) {
          logger.info(
            `Transcript already exists and is newer than audio; skipping. Use --force to overwrite.`
          );
          logger.info(`  ${outputPath}`);
          return;
        }
      }
      logger.info(`Transcribing: ${inputPath}`);
      const openai = new OpenAI({ apiKey });
      const transcription = await openai.audio.transcriptions.create({
        file: fs.createReadStream(inputPath) as unknown as File,
        model: 'whisper-1',
        response_format: 'srt',
      });
      const srtContent = typeof transcription === 'string' ? transcription : String((transcription as { text?: string }).text ?? '');
      fs.writeFileSync(outputPath, srtContent, 'utf-8');
      logger.info(`Wrote transcript: ${outputPath}`);
    } catch (err) {
      logger.error(`Transcription failed: ${err}`);
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
  .option('-o, --output <dir>', 'Output directory for audio clips + metadata', './sfx-library/typing')
  .option('-b, --backend <backend>', 'Audio capture backend: ffmpeg, arecord, or sox', 'ffmpeg')
  .option('-r, --sample-rate <rate>', 'Audio sample rate', '44100')
  .option('-f, --format <format>', 'Audio format: wav or flac', 'wav')
  .option('--fill-gaps', 'Guided mode: prompt for specific missing patterns (old flow)')
  .option('--interactive', 'Legacy: Ctrl+R/Ctrl+S per clip instead of one free-form session')
  .option('--script <path>', 'Path to a script/transcript to check pattern coverage against')
  .option('--target-lufs <dB>', 'Loudness target for extracted clips (default -14; use -12 for louder)', '-14')
  .option('-c, --config <path>', 'Pipeline config path (default: config.json or broll-config.json in cwd)')
  .action(async (opts) => {
    try {
      const { KeystrokeRecorder } = await import('./keystroke-recorder/recorder');
      let outDir = path.resolve(opts.output);
      let targetLUFSFromConfig: number | undefined = undefined;
      const configPath = opts.config ? path.resolve(opts.config) : getDefaultConfigPath();
      if (configPath && fs.existsSync(configPath)) {
        const raw = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
        const cfg = resolveConfig(raw, path.dirname(configPath));
        if (cfg.sfx?.keyboardTyping?.targetLUFS != null) {
          targetLUFSFromConfig = cfg.sfx.keyboardTyping.targetLUFS;
        }
        if (cfg.sfx?.libraryPath && cfg.sfx?.keyboardTyping?.samplesDir) {
          outDir = path.resolve(path.dirname(configPath), cfg.sfx.libraryPath, cfg.sfx.keyboardTyping.samplesDir);
        }
      }
      const logger = createLogger('Recorder');

      const recorder = new KeystrokeRecorder({
        outputDir: outDir,
        sampleRate: parseInt(opts.sampleRate, 10),
        audioFormat: opts.format,
        audioBackend: opts.backend,
        logger,
      });

      if (opts.fillGaps) {
        // Guided recording mode — analyze gaps and prompt for each
        const { CoverageAnalyzer } = await import('./keystroke-recorder/coverage');
        const scriptText = opts.script
          ? fs.readFileSync(path.resolve(opts.script), 'utf-8')
          : undefined;

        const analyzer = new CoverageAnalyzer(outDir, createLogger('Coverage'));
        const report = analyzer.analyze(scriptText);

        const gaps = opts.script ? report.scriptGaps : report.uncovered;
        const prompts = analyzer.generatePrompts(gaps);

        console.log(`\n=== Library Coverage: ${report.coveragePercent.toFixed(1)}% ===`);
        console.log(`${report.coveredPatterns}/${report.totalPatterns} patterns covered (${report.totalClips} clips)`);
        console.log(`${gaps.length} gap${gaps.length === 1 ? '' : 's'} to fill.\n`);

        if (gaps.length === 0) {
          console.log('Library has full coverage! Nothing to record.');
          return;
        }

        if (report.coveragePercent >= 90) {
          console.log('Already at 90%+ coverage. Remaining gaps are optional.\n');
        }

        const clips = await recorder.runGuidedSession(prompts);

        const updatedAnalyzer = new CoverageAnalyzer(outDir, createLogger('Coverage'));
        const updatedReport = updatedAnalyzer.analyze(scriptText);
        console.log(`\n=== Updated Coverage: ${updatedReport.coveragePercent.toFixed(1)}% ===`);
        console.log(`${updatedReport.coveredPatterns}/${updatedReport.totalPatterns} patterns covered (${updatedReport.totalClips} clips)`);

        if (updatedReport.coveragePercent >= 90) {
          console.log('Target coverage (90%) reached!');
        } else {
          console.log(`${(90 - updatedReport.coveragePercent).toFixed(1)}% more needed to reach 90% target.`);
          console.log('Run again with --fill-gaps to continue filling gaps.');
        }
      } else if (opts.interactive) {
        // Legacy: multiple clips with Ctrl+R / Ctrl+S
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

        const { CoverageAnalyzer } = await import('./keystroke-recorder/coverage');
        const analyzer = new CoverageAnalyzer(outDir, createLogger('Coverage'));
        const report = analyzer.analyze();
        console.log(`\nLibrary coverage: ${report.coveragePercent.toFixed(1)}% (${report.coveredPatterns}/${report.totalPatterns} patterns)`);
      } else {
        // Default: free-form — type naturally, then we extract coverage clips
        const result = await recorder.runFreeFormSession();
        if (!result) {
          console.log('No session recorded.');
          return;
        }

        console.log(`\nSession saved. Extracting clips for coverage gaps...`);
        const { extractClipsFromSession } = await import('./keystroke-recorder/extract-clips');
        const scriptText = opts.script
          ? fs.readFileSync(path.resolve(opts.script), 'utf-8')
          : undefined;
        const targetLUFS = targetLUFSFromConfig ?? parseFloat(opts.targetLufs ?? process.env.TYPING_TARGET_LUFS ?? '-14');
        const extracted = extractClipsFromSession(
          result.sessionJsonPath,
          outDir,
          createLogger('Extract'),
          { scriptText, targetLUFS: Number.isFinite(targetLUFS) ? targetLUFS : -14 }
        );
        console.log(`Extracted ${extracted} clip(s) from session.`);

        const { CoverageAnalyzer } = await import('./keystroke-recorder/coverage');
        const analyzer = new CoverageAnalyzer(outDir, createLogger('Coverage'));
        const report = analyzer.analyze(scriptText);
        console.log(`\nLibrary coverage: ${report.coveragePercent.toFixed(1)}% (${report.coveredPatterns}/${report.totalPatterns} patterns, ${report.totalClips} clips)`);
        if (report.coveragePercent < 90) {
          console.log('Record more natural typing and run again to fill gaps.');
        }
      }

      console.log(`\nClips saved to: ${outDir}`);
    } catch (err) {
      logger.error(`Recording session failed: ${err}`);
      process.exit(1);
    }
  });

program
  .command('extract-typing [sessionNumber]')
  .description('Re-slice a session into clips (e.g. after adding volume normalization). Use session number like 1 for session_001.')
  .option('-o, --output <dir>', 'Typing clips library directory', './sfx-library/typing')
  .option('--all', 'Extract every segment (for re-slice with new settings); default only extracts for uncovered patterns')
  .option('--script <path>', 'Path to a script/transcript to check coverage against')
  .option('--target-lufs <dB>', 'Loudness target in LUFS (default -14; use -12 for louder)', '-14')
  .option('-c, --config <path>', 'Pipeline config path (default: config.json or broll-config.json in cwd)')
  .action(async (sessionNumber, opts) => {
    try {
      let outDir = path.resolve(opts.output);
      let targetLUFSFromConfig: number | undefined = undefined;
      const configPath = opts.config ? path.resolve(opts.config) : getDefaultConfigPath();
      if (configPath && fs.existsSync(configPath)) {
        const raw = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
        const cfg = resolveConfig(raw, path.dirname(configPath));
        if (cfg.sfx?.keyboardTyping?.targetLUFS != null) {
          targetLUFSFromConfig = cfg.sfx.keyboardTyping.targetLUFS;
        }
        if (cfg.sfx?.libraryPath && cfg.sfx?.keyboardTyping?.samplesDir) {
          outDir = path.resolve(path.dirname(configPath), cfg.sfx.libraryPath, cfg.sfx.keyboardTyping.samplesDir);
        }
      }
      const sessionsDir = path.join(outDir, 'sessions');

      if (!fs.existsSync(sessionsDir)) {
        console.log('No sessions directory found. Record with record-typing first.');
        return;
      }

      let sessionNum: number;
      if (sessionNumber !== undefined && sessionNumber !== null) {
        sessionNum = parseInt(String(sessionNumber), 10);
        if (!Number.isFinite(sessionNum) || sessionNum < 1) {
          console.log('Session number must be a positive integer (e.g. 1 for session_001).');
          return;
        }
      } else {
        const names = fs.readdirSync(sessionsDir).filter((f) => f.match(/^session_(\d+)\.json$/));
        if (names.length === 0) {
          console.log('No session JSON files in sessions/. Record with record-typing first.');
          return;
        }
        const nums = names.map((f) => parseInt(f.replace(/^session_(\d+)\.json$/, '$1'), 10));
        sessionNum = Math.max(...nums);
        console.log(`Using latest session: ${sessionNum}`);
      }

      const sessionJson = path.join(sessionsDir, `session_${String(sessionNum).padStart(3, '0')}.json`);
      if (!fs.existsSync(sessionJson)) {
        console.log('Session not found: %s', sessionJson);
        return;
      }

      const scriptText = opts.script
        ? fs.readFileSync(path.resolve(opts.script), 'utf-8')
        : undefined;
      const targetLUFS = targetLUFSFromConfig ?? parseFloat(opts.targetLufs ?? process.env.TYPING_TARGET_LUFS ?? '-14');
      const { extractClipsFromSession } = await import('./keystroke-recorder/extract-clips');
      const extracted = extractClipsFromSession(
        sessionJson,
        outDir,
        createLogger('Extract'),
        { scriptText, extractAll: opts.all, targetLUFS: Number.isFinite(targetLUFS) ? targetLUFS : -14 }
      );
      console.log(`Extracted ${extracted} clip(s) from session ${sessionNum}.`);
    } catch (err) {
      logger.error(`Extract failed: ${err}`);
      process.exit(1);
    }
  });

program
  .command('coverage')
  .description('Analyze typing SFX library coverage without recording')
  .option('-o, --output <dir>', 'Typing clips library directory', './sfx-library/typing')
  .option('--script <path>', 'Path to a script/transcript to check coverage against')
  .option('--verbose', 'Show all patterns including covered ones')
  .action(async (opts) => {
    try {
      const { CoverageAnalyzer } = await import('./keystroke-recorder/coverage');
      const outDir = path.resolve(opts.output);
      const scriptText = opts.script
        ? fs.readFileSync(path.resolve(opts.script), 'utf-8')
        : undefined;

      const analyzer = new CoverageAnalyzer(outDir, createLogger('Coverage'));
      const report = analyzer.analyze(scriptText);

      console.log(`\n=== Typing SFX Library Coverage ===`);
      console.log(`Total clips:    ${report.totalClips}`);
      console.log(`Total patterns: ${report.totalPatterns}`);
      console.log(`Covered:        ${report.coveredPatterns} (${report.coveragePercent.toFixed(1)}%)`);
      console.log(`Uncovered:      ${report.uncovered.length}`);
      if (scriptText) {
        console.log(`Script gaps:    ${report.scriptGaps.length}`);
      }
      console.log();

      if (report.coveragePercent >= 90) {
        console.log('Target coverage (90%) REACHED.\n');
      } else {
        console.log(`${(90 - report.coveragePercent).toFixed(1)}% more needed to reach 90% target.\n`);
      }

      if (opts.verbose && report.covered.length > 0) {
        console.log('--- Covered Patterns ---');
        for (const { pattern, clipCount } of report.covered) {
          console.log(`  [${clipCount} clip${clipCount > 1 ? 's' : ''}] ${pattern.description}`);
        }
        console.log();
      }

      if (report.uncovered.length > 0) {
        console.log('--- Uncovered Patterns ---');
        const prompts = analyzer.generatePrompts(report.uncovered);
        for (const { pattern, prompt } of prompts) {
          console.log(`  ${pattern.description}`);
          console.log(`    Example: ${prompt}`);
        }
        console.log();
      }

      if (scriptText && report.scriptGaps.length > 0) {
        console.log('--- Script-Specific Gaps ---');
        console.log('These patterns are needed by your script but missing:');
        const prompts = analyzer.generatePrompts(report.scriptGaps);
        for (const { pattern, prompt } of prompts) {
          console.log(`  ${pattern.description}`);
          console.log(`    Example: ${prompt}`);
        }
        console.log();
        console.log(`Run: auto-broll record-typing --fill-gaps --script ${opts.script}`);
      } else if (report.uncovered.length > 0) {
        console.log(`Run: auto-broll record-typing --fill-gaps`);
      }
    } catch (err) {
      logger.error(`Coverage analysis failed: ${err}`);
      process.exit(1);
    }
  });

/** Resolve relative paths and API keys (from .env) relative to the config file's directory. */
function resolveConfig(raw: PipelineConfig, baseDir: string): PipelineConfig {
  const envKey =
    raw.llm.provider === 'deepseek'
      ? process.env.DEEPSEEK_API_KEY
      : process.env.OPENAI_API_KEY;
  const llmApiKey =
    raw.llm.apiKey &&
    !/^YOUR[_ ]?(DEEPSEEK|OPENAI)?[_ ]?API[_ ]?KEY/i.test(raw.llm.apiKey)
      ? raw.llm.apiKey
      : envKey;

  if (!llmApiKey?.trim()) {
    const varName =
      raw.llm.provider === 'deepseek' ? 'DEEPSEEK_API_KEY' : 'OPENAI_API_KEY';
    throw new Error(
      `LLM API key required. Set ${varName} in .env (or llm.apiKey in config).`
    );
  }

  return {
    ...raw,
    transcriptPath: path.resolve(baseDir, raw.transcriptPath),
    audioPath: path.resolve(baseDir, raw.audioPath),
    outputDir: path.resolve(baseDir, raw.outputDir),
    llm: { ...raw.llm, apiKey: llmApiKey },
  };
}

/** Default config path: try config.json then broll-config.json in cwd. */
function getDefaultConfigPath(): string | null {
  const cwd = process.cwd();
  for (const name of ['config.json', 'broll-config.json']) {
    const p = path.join(cwd, name);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

program.parse();
