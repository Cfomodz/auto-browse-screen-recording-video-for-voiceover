import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as path from 'path';
import { KeystrokeEvent, TypingClipMeta } from '../core/types';
import { Logger } from '../utils/logger';
import type { TypingPattern } from './coverage';

/**
 * Keystroke Recorder — standalone tool for building the typing audio library.
 *
 * This tool is used in a terminal session where you:
 * 1. Start a recording session (which begins audio capture via system mic)
 * 2. Type naturally — words, spaces, mistakes, backspaces, pauses
 * 3. The tool logs every keystroke with millisecond timing
 * 4. When you stop, it saves the audio file + a JSON sidecar containing
 *    the keystroke sequence with exact timestamps
 *
 * The resulting audio+metadata pairs are what the SfxManager and TypingAnimator
 * use to synchronize visual keystrokes with real typing sounds.
 *
 * Audio recording is done via an external process (arecord/sox/ffmpeg)
 * since Node.js doesn't have native mic access. The recorder manages
 * the subprocess lifecycle.
 */
export class KeystrokeRecorder extends EventEmitter {
  private logger: Logger;
  private outputDir: string;
  private sampleRate: number;
  private audioFormat: 'wav' | 'flac';
  private audioBackend: 'arecord' | 'sox' | 'ffmpeg';

  private recording = false;
  private startTime = 0;
  private keystrokes: KeystrokeEvent[] = [];
  private typedText = '';
  private clipCounter = 0;
  private audioProcess: ReturnType<typeof import('child_process').spawn> | null = null;

  constructor(options: {
    outputDir: string;
    sampleRate?: number;
    audioFormat?: 'wav' | 'flac';
    audioBackend?: 'arecord' | 'sox' | 'ffmpeg';
    logger: Logger;
  }) {
    super();
    this.outputDir = options.outputDir;
    this.sampleRate = options.sampleRate ?? 44100;
    this.audioFormat = options.audioFormat ?? 'wav';
    this.audioBackend = options.audioBackend ?? 'ffmpeg';
    this.logger = options.logger;

    fs.mkdirSync(this.outputDir, { recursive: true });
  }

  /**
   * Start a recording clip.
   *
   * Begins capturing audio from the system microphone and logging keystrokes.
   * Returns the clip name for reference.
   */
  async startClip(): Promise<string> {
    if (this.recording) {
      throw new Error('Already recording. Stop the current clip first.');
    }

    this.clipCounter++;
    const clipName = `clip_${String(this.clipCounter).padStart(4, '0')}`;
    const audioPath = path.join(this.outputDir, `${clipName}.${this.audioFormat}`);

    // Reset state
    this.keystrokes = [];
    this.typedText = '';
    this.recording = true;

    // Start audio capture
    this.audioProcess = this.startAudioCapture(audioPath);
    this.startTime = Date.now();

    this.logger.info(`Recording started: ${clipName}`);
    this.logger.info('Type naturally. Press Ctrl+D or Ctrl+C to stop this clip.');

    return clipName;
  }

  /**
   * Record a single keystroke event.
   * Called by the terminal input handler for each key press.
   */
  recordKeystroke(key: string): void {
    if (!this.recording) return;

    const timestampMs = Date.now() - this.startTime;

    this.keystrokes.push({ key, timestampMs });

    // Track the typed text (for matching purposes)
    if (key === 'backspace') {
      this.typedText = this.typedText.slice(0, -1);
    } else if (key === 'space') {
      this.typedText += ' ';
    } else if (key === 'enter') {
      this.typedText += '\n';
    } else if (key.length === 1) {
      this.typedText += key;
    }

    this.emit('keystroke', { key, timestampMs });
  }

  /**
   * Stop the current recording clip and save metadata.
   * Returns the TypingClipMeta for the completed clip.
   */
  async stopClip(): Promise<TypingClipMeta> {
    if (!this.recording) {
      throw new Error('Not currently recording.');
    }

    this.recording = false;
    const durationMs = Date.now() - this.startTime;

    // Stop audio capture
    if (this.audioProcess) {
      this.audioProcess.kill('SIGINT');
      // Give it a moment to finalize the audio file
      await new Promise((resolve) => setTimeout(resolve, 500));
      this.audioProcess = null;
    }

    const clipName = `clip_${String(this.clipCounter).padStart(4, '0')}`;
    const audioFile = `${clipName}.${this.audioFormat}`;

    // Count backspace sequences
    let backspaceSequences = 0;
    let maxConsecutiveBackspaces = 0;
    let currentBackspaceRun = 0;

    for (const ks of this.keystrokes) {
      if (ks.key === 'backspace') {
        currentBackspaceRun++;
        if (currentBackspaceRun === 1) backspaceSequences++;
        maxConsecutiveBackspaces = Math.max(maxConsecutiveBackspaces, currentBackspaceRun);
      } else {
        currentBackspaceRun = 0;
      }
    }

    const meta: TypingClipMeta = {
      audioFile,
      durationMs,
      typedText: this.typedText.trim(),
      wordCount: this.typedText.trim().split(/\s+/).filter(Boolean).length,
      backspaceSequences,
      maxConsecutiveBackspaces,
      keystrokes: this.keystrokes,
    };

    // Save the metadata sidecar
    const metaPath = path.join(this.outputDir, `${clipName}.json`);
    fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));

    this.logger.info(
      `Clip saved: ${clipName} | ${durationMs}ms | ` +
      `${meta.wordCount} words | ${meta.keystrokes.length} keystrokes | ` +
      `${backspaceSequences} backspace sequences`
    );

    return meta;
  }

  /** Start audio capture using the configured backend. */
  private startAudioCapture(outputPath: string): ReturnType<typeof import('child_process').spawn> {
    const { spawn } = require('child_process') as typeof import('child_process');

    let args: string[];

    switch (this.audioBackend) {
      case 'arecord':
        args = [
          '-f', 'cd',
          '-t', this.audioFormat,
          '-r', String(this.sampleRate),
          '-c', '1',
          outputPath,
        ];
        return spawn('arecord', args, { stdio: 'pipe' });

      case 'sox':
        args = [
          '-d',  // Default input device
          '-r', String(this.sampleRate),
          '-c', '1',
          outputPath,
        ];
        return spawn('sox', args, { stdio: 'pipe' });

      case 'ffmpeg':
      default:
        // FFmpeg using ALSA or PulseAudio input
        args = [
          '-f', 'pulse',    // PulseAudio (change to 'alsa' if needed)
          '-i', 'default',
          '-ar', String(this.sampleRate),
          '-ac', '1',
          '-y',
          outputPath,
        ];
        return spawn('ffmpeg', args, { stdio: 'pipe' });
    }
  }

  /**
   * Run an interactive recording session in the terminal.
   *
   * Listens for raw keypresses, logs them with timing, and manages
   * audio recording. Users press Enter twice quickly to finish a clip,
   * or Ctrl+D to end the session.
   */
  async runInteractiveSession(): Promise<TypingClipMeta[]> {
    const clips: TypingClipMeta[] = [];

    // Set terminal to raw mode for per-character input
    if (!process.stdin.isTTY) {
      this.logger.error('Interactive session requires a TTY terminal.');
      return clips;
    }

    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf-8');

    this.logger.info('=== Keystroke Recording Session ===');
    this.logger.info('Commands:');
    this.logger.info('  Ctrl+R  - Start a new clip');
    this.logger.info('  Ctrl+S  - Stop current clip and save');
    this.logger.info('  Ctrl+D  - End session');
    this.logger.info('');
    this.logger.info('Between Ctrl+R and Ctrl+S, type naturally.');
    this.logger.info('Your keystrokes and audio are recorded simultaneously.');
    this.logger.info('');

    return new Promise((resolve) => {
      process.stdin.on('data', async (data: string) => {
        for (const char of data) {
          const code = char.charCodeAt(0);

          // Ctrl+D (EOT) — end session
          if (code === 4) {
            if (this.recording) {
              const meta = await this.stopClip();
              clips.push(meta);
            }
            process.stdin.setRawMode(false);
            process.stdin.pause();
            this.logger.info(`Session complete. ${clips.length} clips recorded.`);
            resolve(clips);
            return;
          }

          // Ctrl+R — start new clip
          if (code === 18) {
            if (this.recording) {
              this.logger.warn('Already recording. Stop first with Ctrl+S.');
            } else {
              await this.startClip();
            }
            continue;
          }

          // Ctrl+S — stop and save clip
          if (code === 19) {
            if (this.recording) {
              const meta = await this.stopClip();
              clips.push(meta);
              this.logger.info('Ready for next clip (Ctrl+R) or end session (Ctrl+D).');
            }
            continue;
          }

          // Regular keystrokes while recording
          if (this.recording) {
            if (code === 127 || code === 8) {
              // Backspace
              this.recordKeystroke('backspace');
              process.stdout.write('\b \b'); // Visual feedback
            } else if (code === 13) {
              // Enter
              this.recordKeystroke('enter');
              process.stdout.write('\n');
            } else if (code === 32) {
              // Space
              this.recordKeystroke('space');
              process.stdout.write(' ');
            } else if (code >= 32 && code < 127) {
              // Printable character
              this.recordKeystroke(char);
              process.stdout.write(char);
            }
          }
        }
      });
    });
  }

  /**
   * Run a guided recording session that walks the user through
   * specific patterns that are missing from the library.
   *
   * For each gap, the system shows what kind of text to type,
   * auto-starts recording, and waits for Ctrl+S to save.
   * The user can skip a pattern with Ctrl+N or end early with Ctrl+D.
   */
  async runGuidedSession(
    prompts: Array<{ pattern: TypingPattern; prompt: string }>
  ): Promise<TypingClipMeta[]> {
    const clips: TypingClipMeta[] = [];

    if (!process.stdin.isTTY) {
      this.logger.error('Guided session requires a TTY terminal.');
      return clips;
    }

    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf-8');

    this.logger.info('=== Guided Keystroke Recording ===');
    this.logger.info('For each prompt, type the described text naturally.');
    this.logger.info('Commands:');
    this.logger.info('  Ctrl+S  - Save current clip and move to next prompt');
    this.logger.info('  Ctrl+N  - Skip this prompt');
    this.logger.info('  Ctrl+D  - End session early');
    this.logger.info('');

    let promptIndex = 0;

    const showNextPrompt = async () => {
      if (promptIndex >= prompts.length) {
        return false;
      }

      const { pattern, prompt } = prompts[promptIndex];
      console.log(`\n--- Pattern ${promptIndex + 1}/${prompts.length}: ${pattern.description} ---`);
      console.log(`Type: ${prompt}`);
      console.log('(Recording starts now — type when ready)\n');

      await this.startClip();
      return true;
    };

    // Show first prompt
    const hasFirst = await showNextPrompt();
    if (!hasFirst) {
      process.stdin.setRawMode(false);
      process.stdin.pause();
      return clips;
    }

    return new Promise((resolve) => {
      process.stdin.on('data', async (data: string) => {
        for (const char of data) {
          const code = char.charCodeAt(0);

          // Ctrl+D — end session early
          if (code === 4) {
            if (this.recording) {
              const meta = await this.stopClip();
              clips.push(meta);
            }
            process.stdin.setRawMode(false);
            process.stdin.pause();
            this.logger.info(`Guided session ended. ${clips.length} clips recorded.`);
            resolve(clips);
            return;
          }

          // Ctrl+S — save clip and advance to next prompt
          if (code === 19) {
            if (this.recording) {
              const meta = await this.stopClip();
              clips.push(meta);
              console.log(`  Saved! (${meta.wordCount} words, ${meta.keystrokes.length} keystrokes)`);
            }
            promptIndex++;
            const hasNext = await showNextPrompt();
            if (!hasNext) {
              process.stdin.setRawMode(false);
              process.stdin.pause();
              this.logger.info(`All prompts complete! ${clips.length} clips recorded.`);
              resolve(clips);
              return;
            }
            continue;
          }

          // Ctrl+N (14) — skip this prompt
          if (code === 14) {
            if (this.recording) {
              // Discard current recording
              this.recording = false;
              if (this.audioProcess) {
                this.audioProcess.kill('SIGINT');
                await new Promise((r) => setTimeout(r, 200));
                this.audioProcess = null;
              }
              // Clean up the partial audio file
              const clipName = `clip_${String(this.clipCounter).padStart(4, '0')}`;
              const partialPath = path.join(this.outputDir, `${clipName}.${this.audioFormat}`);
              if (fs.existsSync(partialPath)) {
                try { fs.unlinkSync(partialPath); } catch {}
              }
              console.log('  (Skipped)');
            }
            promptIndex++;
            const hasNext = await showNextPrompt();
            if (!hasNext) {
              process.stdin.setRawMode(false);
              process.stdin.pause();
              this.logger.info(`All prompts complete! ${clips.length} clips recorded.`);
              resolve(clips);
              return;
            }
            continue;
          }

          // Regular keystrokes while recording
          if (this.recording) {
            if (code === 127 || code === 8) {
              this.recordKeystroke('backspace');
              process.stdout.write('\b \b');
            } else if (code === 13) {
              this.recordKeystroke('enter');
              process.stdout.write('\n');
            } else if (code === 32) {
              this.recordKeystroke('space');
              process.stdout.write(' ');
            } else if (code >= 32 && code < 127) {
              this.recordKeystroke(char);
              process.stdout.write(char);
            }
          }
        }
      });
    });
  }
}
