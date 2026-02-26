import { EventEmitter } from 'events';
import * as child_process from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { KeystrokeEvent, TypingClipMeta } from '../core/types';
import { Logger } from '../utils/logger';
import type { TypingPattern } from './coverage';

/** On Windows, list all DirectShow audio capture device names (exact strings ffmpeg expects). */
function getDshowAudioDevices(): string[] {
  const names: string[] = [];
  try {
    const result = child_process.spawnSync('ffmpeg', [
      '-list_devices', 'true', '-f', 'dshow', '-i', 'dummy',
    ], { encoding: 'utf8', maxBuffer: 100 * 1024, windowsHide: true });
    const stderr = (result.stderr ?? result.stdout ?? '') as string;
    const regex = /"([^"]+)"\s*\(audio\)/g;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(stderr)) !== null) names.push(match[1]);
  } catch {
    /* ignore */
  }
  return names;
}

/** On Windows, get first DirectShow audio device, or null if none. */
function getFirstDshowAudioDevice(): string | null {
  const list = getDshowAudioDevices();
  return list.length > 0 ? list[0] : null;
}

/** Return the highest existing clip number in dir (e.g. 24 for clip_0024.*), or 0 if none. */
function getMaxExistingClipNumber(dir: string): number {
  let max = 0;
  try {
    const names = fs.readdirSync(dir);
    const re = /^clip_(\d+)\.(json|wav|flac)$/i;
    for (const name of names) {
      const m = name.match(re);
      if (m) {
        const n = parseInt(m[1], 10);
        if (n > max) max = n;
      }
    }
  } catch {
    /* dir missing or unreadable */
  }
  return max;
}

/** Return the highest existing session number in dir (e.g. 3 for session_003.*), or 0 if none. */
function getMaxExistingSessionNumber(dir: string): number {
  let max = 0;
  try {
    const names = fs.readdirSync(dir);
    const re = /^session_(\d+)\.(json|wav|flac)$/i;
    for (const name of names) {
      const m = name.match(re);
      if (m) {
        const n = parseInt(m[1], 10);
        if (n > max) max = n;
      }
    }
  } catch {
    /* dir missing or unreadable */
  }
  return max;
}

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
  /** Override for current clip (used when saving to sessions dir). */
  private currentClipDir: string | null = null;
  private currentClipBaseName: string | null = null;

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
    this.clipCounter = getMaxExistingClipNumber(this.outputDir);
  }

  /**
   * Start a recording clip.
   *
   * Begins capturing audio from the system microphone and logging keystrokes.
   * Returns the clip name for reference.
   * @param options.outputDir - If set, save this clip here instead of this.outputDir (e.g. sessions).
   * @param options.baseName - If set, use this base name instead of clip_NNN (e.g. session_001).
   */
  async startClip(options?: { outputDir?: string; baseName?: string }): Promise<string> {
    if (this.recording) {
      throw new Error('Already recording. Stop the current clip first.');
    }

    const useDir = options?.outputDir ?? this.outputDir;
    const baseName = options?.baseName ?? `clip_${String(++this.clipCounter).padStart(4, '0')}`;
    if (!options?.outputDir) {
      this.clipCounter = parseInt(baseName.replace(/\D/g, ''), 10) || this.clipCounter;
    }
    this.currentClipDir = useDir;
    this.currentClipBaseName = baseName;
    const audioPath = path.join(useDir, `${baseName}.${this.audioFormat}`);

    // Reset state
    this.keystrokes = [];
    this.typedText = '';
    this.recording = true;

    // Start audio capture
    this.audioProcess = this.startAudioCapture(audioPath);
    this.audioProcess.on('error', (err: NodeJS.ErrnoException) => {
      if (err?.code === 'ENOENT') {
        this.logger.error(
          'Audio capture failed: ffmpeg not found. Install FFmpeg and add it to your PATH. ' +
            (process.platform === 'win32'
              ? 'On Windows you can install via: winget install ffmpeg'
              : '')
        );
      } else {
        this.logger.error('Audio capture process error: %s', err?.message ?? err);
      }
      this.audioProcess = null;
    });
    this.startTime = Date.now();

    this.logger.info(`Recording started: ${baseName}`);
    this.logger.info('Type naturally. Press Ctrl+D or Ctrl+C to stop this clip.');

    return baseName;
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

    // Stop audio capture: send 'q' so ffmpeg flushes and closes the WAV (kill on Windows often leaves no file)
    if (this.audioProcess) {
      const proc = this.audioProcess;
      this.audioProcess = null;
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          proc.kill('SIGKILL');
          resolve();
        }, 8000);
        proc.once('exit', () => {
          clearTimeout(timeout);
          resolve();
        });
        if (proc.stdin?.writable) {
          proc.stdin.write('q');
          proc.stdin.end();
        } else {
          proc.kill('SIGINT');
          setTimeout(resolve, 500);
        }
      });
    }

    const clipName = this.currentClipBaseName ?? `clip_${String(this.clipCounter).padStart(4, '0')}`;
    const audioFile = `${clipName}.${this.audioFormat}`;
    const metaDir = this.currentClipDir ?? this.outputDir;
    this.currentClipDir = null;
    this.currentClipBaseName = null;

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
    const metaPath = path.join(metaDir, `${clipName}.json`);
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
    const absolutePath = path.resolve(outputPath);

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
      default: {
        const isWin = process.platform === 'win32';
        if (isWin) {
          // Windows: use only device names that ffmpeg actually lists (exact match required).
          const list = getDshowAudioDevices();
          const preferred = process.env.TYPING_AUDIO_DEVICE;
          const device =
            preferred && list.includes(preferred) ? preferred : list[0];
          if (!device) {
            throw new Error(
              'No DirectShow audio device found. Run: ffmpeg -list_devices true -f dshow -i dummy'
            );
          }
          args = [
            '-f', 'dshow',
            '-i', `audio=${device}`,
            '-ar', String(this.sampleRate),
            '-ac', '1',
            '-y',
            absolutePath,
          ];
        } else {
          // Linux: PulseAudio (or use 'alsa' if needed)
          args = [
            '-f', 'pulse',
            '-i', 'default',
            '-ar', String(this.sampleRate),
            '-ac', '1',
            '-y',
            absolutePath,
          ];
        }
        return spawn('ffmpeg', args, { stdio: 'pipe' });
      }
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
   * Run a single free-form recording: start immediately, type naturally, Escape to stop.
   * Saves to outputDir/sessions/session_NNN.(wav|json). We then extract coverage clips from this.
   * Returns path to the session JSON, or null if not used.
   */
  async runFreeFormSession(): Promise<{ sessionJsonPath: string; sessionWavPath: string } | null> {
    if (!process.stdin.isTTY) {
      this.logger.error('Free-form session requires a TTY terminal.');
      return null;
    }

    const sessionsDir = path.join(this.outputDir, 'sessions');
    fs.mkdirSync(sessionsDir, { recursive: true });
    const n = getMaxExistingSessionNumber(sessionsDir) + 1;
    const baseName = `session_${String(n).padStart(3, '0')}`;

    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf-8');

    this.logger.info('=== Free-form typing — record naturally ===');
    this.logger.info('Type anything (real text, nonsense, whatever feels natural).');
    this.logger.info('Press Escape when done. We will extract coverage clips from this after.');
    this.logger.info('');

    await this.startClip({ outputDir: sessionsDir, baseName });

    return new Promise((resolve) => {
      process.stdin.on('data', async (data: string) => {
        for (const char of data) {
          const code = char.charCodeAt(0);

          if (code === 27) {
            if (this.recording) {
              await this.stopClip();
            }
            process.stdin.setRawMode(false);
            process.stdin.pause();
            resolve({
              sessionJsonPath: path.join(sessionsDir, `${baseName}.json`),
              sessionWavPath: path.join(sessionsDir, `${baseName}.${this.audioFormat}`),
            });
            return;
          }

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

  /**
   * Run a guided recording session that walks the user through
   * specific patterns that are missing from the library.
   *
   * User types the requested text; when it matches exactly, the clip
   * auto-saves after ~500ms and the next prompt appears (no key needed).
   * If they type too much (mistake), the prompt is re-queued for later.
   * Press Escape to end the session early.
   */
  async runGuidedSession(
    prompts: Array<{ pattern: TypingPattern; prompt: string }>
  ): Promise<TypingClipMeta[]> {
    const clips: TypingClipMeta[] = [];
    /** Text to type (prompt with trailing " (type ...)" hint stripped) */
    const expectedFromPrompt = (p: string) =>
      p.replace(/\s*\([^)]*\)\s*$/, '').trim();

    if (!process.stdin.isTTY) {
      this.logger.error('Guided session requires a TTY terminal.');
      return clips;
    }

    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf-8');

    this.logger.info('=== Guided Keystroke Recording ===');
    this.logger.info('Type the requested text. When you finish correctly, the next prompt appears after ~500ms.');
    this.logger.info('Press Escape to end the session.');
    this.logger.info('');

    const totalCount = prompts.length;
    const remaining = prompts.slice();
    const AUTO_ADVANCE_MS = 500;
    let autoAdvanceTimer: ReturnType<typeof setTimeout> | null = null;
    let currentPrompt: { pattern: TypingPattern; prompt: string } | null = null;

    const discardCurrentClip = async () => {
      if (!this.recording) return;
      this.recording = false;
      if (this.audioProcess) {
        this.audioProcess.kill('SIGINT');
        await new Promise((r) => setTimeout(r, 200));
        this.audioProcess = null;
      }
      const clipName = `clip_${String(this.clipCounter).padStart(4, '0')}`;
      const partialPath = path.join(this.outputDir, `${clipName}.${this.audioFormat}`);
      if (fs.existsSync(partialPath)) {
        try { fs.unlinkSync(partialPath); } catch { /* ignore */ }
      }
    };

    /** Mistake-count label for display (fixed width so words start same column). */
    const mistakeLabel = (b: TypingPattern['backspaceBucket']): string => {
      const s = b === '0' ? '0' : b === '1-2' ? '1' : '3+';
      return s.padEnd(2, ' ');
    };

    const showNextPrompt = async (): Promise<boolean> => {
      if (autoAdvanceTimer) {
        clearTimeout(autoAdvanceTimer);
        autoAdvanceTimer = null;
      }
      currentPrompt = remaining.length > 0 ? remaining.shift() ?? null : null;
      if (!currentPrompt) {
        return false;
      }
      const { pattern, prompt } = currentPrompt;
      const expectedText = expectedFromPrompt(prompt);
      const left = totalCount - remaining.length;
      console.log(`\n--- ${left}/${totalCount}: ${pattern.description} ---\n`);
      console.log(`  ${mistakeLabel(pattern.backspaceBucket)}${expectedText}\n`);
      console.log('(Recording — type when ready)\n');
      await this.startClip();
      return true;
    };

    const endSession = (
      resolve: (c: TypingClipMeta[]) => void,
      reason: string
    ) => {
      if (autoAdvanceTimer) clearTimeout(autoAdvanceTimer);
      process.stdin.setRawMode(false);
      process.stdin.pause();
      this.logger.info(`${reason} ${clips.length} clips recorded.`);
      resolve(clips);
    };

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

          // Escape — end session early (only non-typing key we use)
          if (code === 27) {
            if (this.recording) {
              await discardCurrentClip();
            }
            endSession(resolve, 'Session ended.');
            return;
          }

          // Regular keystrokes while recording
          if (this.recording && currentPrompt) {
            const expected = expectedFromPrompt(currentPrompt.prompt);

            if (code === 127 || code === 8) {
              this.recordKeystroke('backspace');
              process.stdout.write('\b \b');
              if (autoAdvanceTimer) {
                clearTimeout(autoAdvanceTimer);
                autoAdvanceTimer = null;
              }
            } else if (code === 13) {
              this.recordKeystroke('enter');
              process.stdout.write('\n');
              if (autoAdvanceTimer) {
                clearTimeout(autoAdvanceTimer);
                autoAdvanceTimer = null;
              }
            } else if (code === 32) {
              this.recordKeystroke('space');
              process.stdout.write(' ');
            } else if (code >= 32 && code < 127) {
              this.recordKeystroke(char);
              process.stdout.write(char);
            } else {
              continue;
            }

            // Completion is by final text only; backspace corrections (e.g. d, o, backspace, o, g) count as correct
            const typed = this.typedText.trim();
            if (typed === expected) {
              if (autoAdvanceTimer) continue;
              autoAdvanceTimer = setTimeout(async () => {
                autoAdvanceTimer = null;
                if (!this.recording || !currentPrompt) return;
                const meta = await this.stopClip();
                clips.push(meta);
                this.logger.info(`Saved. Next in a moment…`);
                const hasNext = await showNextPrompt();
                if (!hasNext) {
                  endSession(resolve, 'All prompts complete!');
                }
              }, AUTO_ADVANCE_MS);
            } else if (typed.length > expected.length) {
              // Typed too much — save this clip anyway (adds to library), re-queue pattern for later
              if (autoAdvanceTimer) {
                clearTimeout(autoAdvanceTimer);
                autoAdvanceTimer = null;
              }
              const meta = await this.stopClip();
              clips.push(meta);
              remaining.push(currentPrompt);
              this.logger.info('Saved clip; pattern re-queued. Next prompt…');
              const hasNext = await showNextPrompt();
              if (!hasNext) {
                endSession(resolve, 'All prompts complete!');
              }
            }
          }
        }
      });
    });
  }
}
