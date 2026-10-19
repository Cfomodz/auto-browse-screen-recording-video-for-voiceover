import { Page, CDPSession } from 'puppeteer-core';
import * as child_process from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { PipelineConfig } from '../../core/types';
import { Logger } from '../../utils/logger';

/**
 * Screencast frames are JPEG: visually indistinguishable from PNG once
 * encoded to H.264, but ~10x smaller (a 30s clip is ~60 MB of frames instead
 * of ~600 MB) and delivered sooner, since the browser encodes them faster.
 */
const FRAME_FORMAT = 'jpeg';
const FRAME_QUALITY = 90;
const FRAME_EXT = 'jpg';

/**
 * Screen Recorder module.
 *
 * Uses Chrome DevTools Protocol (CDP) Page.screencastFrame to capture
 * the browser viewport as a sequence of frames, then assembles them
 * via FFmpeg into a video clip. This avoids external screen capture
 * tools and works in headless or headed mode.
 */
export class ScreenRecorder {
  private config: PipelineConfig;
  private logger: Logger;
  private cdpSession: CDPSession | null = null;
  private recording = false;
  private frameDir: string = '';
  private frameCount = 0;
  /** When each captured frame appeared on screen (ms since recording start). */
  private frameTimestamps: number[] = [];
  /** In-flight frame writes, awaited before assembly. */
  private pendingWrites: Promise<void>[] = [];
  private _recordingStartTime: number = 0;

  /** Absolute Date.now() when the current recording started. */
  get recordingStartTime(): number {
    return this._recordingStartTime;
  }

  constructor(config: PipelineConfig, logger: Logger) {
    this.config = config;
    this.logger = logger;
  }

  /** Start recording the browser page. Video time 0 is the moment this is called. */
  async startRecording(page: Page, clipName: string): Promise<void> {
    this.frameDir = path.join(this.config.outputDir, 'frames', clipName);
    fs.rmSync(this.frameDir, { recursive: true, force: true });
    fs.mkdirSync(this.frameDir, { recursive: true });

    this.frameCount = 0;
    this.frameTimestamps = [];
    this.pendingWrites = [];
    this.recording = true;
    this._recordingStartTime = Date.now();

    // Create a CDP session for screencast
    this.cdpSession = await page.createCDPSession();
    const session = this.cdpSession;

    session.on('Page.screencastFrame', (event) => {
      if (!this.recording) return;

      // Acknowledge right away so the browser can produce the next frame
      session.send('Page.screencastFrameAck', { sessionId: event.sessionId }).catch(() => {
        // Frame capture can fail during navigation; non-fatal
      });

      // Use the browser's frame swap time rather than arrival time: encoding
      // and delivery lag would otherwise shift visuals late relative to SFX.
      const arrivedMs = Date.now();
      const swapMs = event.metadata?.timestamp ? event.metadata.timestamp * 1000 : arrivedMs;
      const shownAtMs = Math.abs(arrivedMs - swapMs) < 2000 ? swapMs : arrivedMs;

      // Claim the index synchronously so filenames and timestamps stay paired
      const index = this.frameCount++;
      this.frameTimestamps[index] = Math.max(0, shownAtMs - this._recordingStartTime);
      const framePath = path.join(this.frameDir, `frame_${String(index).padStart(6, '0')}.${FRAME_EXT}`);
      this.pendingWrites.push(
        fs.promises.writeFile(framePath, Buffer.from(event.data, 'base64')).catch(() => {
          // A missing frame is handled at assembly time
        })
      );
    });

    await session.send('Page.startScreencast', {
      format: FRAME_FORMAT,
      quality: FRAME_QUALITY,
      maxWidth: this.config.video.resolution.width,
      maxHeight: this.config.video.resolution.height,
      everyNthFrame: 1,
    });

    this.logger.info(`Recording started: ${clipName}`);
  }

  /**
   * Stop recording and assemble frames into a video file. Returns the output path.
   *
   * The video spans exactly from startRecording() to this call: each frame is
   * shown from the moment it appeared until the next one did, and the last
   * frame holds until now. Video time therefore equals wall-clock time since
   * recording started, which SFX and zoom placement rely on.
   */
  async stopRecording(clipName: string): Promise<string> {
    const stopMs = Date.now() - this._recordingStartTime;
    this.recording = false;

    if (this.cdpSession) {
      try {
        await this.cdpSession.send('Page.stopScreencast');
        await this.cdpSession.detach();
      } catch {
        // CDP session may already be detached
      }
      this.cdpSession = null;
    }

    await Promise.all(this.pendingWrites);
    this.logger.info(
      `Recording stopped: ${clipName} (${this.frameCount} frames over ${(stopMs / 1000).toFixed(1)}s, ` +
        `${(this.frameCount / Math.max(stopMs / 1000, 0.001)).toFixed(1)} fps captured)`
    );

    const outputPath = path.resolve(this.config.outputDir, 'clips', `${clipName}.mp4`);
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });

    if (this.frameCount === 0) {
      this.logger.warn('No frames captured — creating empty clip marker.');
      fs.writeFileSync(outputPath, '');
      return outputPath;
    }

    // Assemble frames into video using FFmpeg
    await this.assembleFrames(outputPath, stopMs);
    return outputPath;
  }

  /** Stop recording without producing a clip (the module failed mid-recording). */
  async abortRecording(): Promise<void> {
    this.recording = false;
    if (this.cdpSession) {
      try {
        await this.cdpSession.send('Page.stopScreencast');
        await this.cdpSession.detach();
      } catch {
        // CDP session may already be detached
      }
      this.cdpSession = null;
    }
    await Promise.all(this.pendingWrites);
    this.cleanupFrames();
  }

  /**
   * Assemble captured frames into a video.
   *
   * Primary path: uses the concat demuxer with per-frame durations derived
   * from frame timestamps. CDP screencast delivers frames at variable
   * rates (many during animations, few during idle waits), so a fixed input
   * framerate would compress active periods and stretch idle ones — causing
   * SFX audio to drift seconds from the visual events that triggered them.
   *
   * Fallback: fixed-framerate image2 input when fewer than 2 timestamps exist.
   */
  private assembleFrames(outputPath: string, stopMs: number): Promise<void> {
    const targetFps = this.config.video.fps;

    if (this.frameTimestamps.length >= 2) {
      return this.assembleFramesConcat(outputPath, targetFps, stopMs);
    }

    return this.assembleFramesFixedRate(outputPath, stopMs / 1000, targetFps);
  }

  /** Concat-demuxer assembly: each frame is shown from its timestamp until the next. */
  private assembleFramesConcat(
    outputPath: string,
    targetFps: number,
    stopMs: number
  ): Promise<void> {
    const concatListPath = path.join(this.frameDir, 'concat_frames.txt');
    const lines: string[] = ['ffconcat version 1.0'];
    const minFrameMs = 1000 / targetFps;

    // Frames whose write failed are skipped (the previous frame covers their
    // time); timestamps are forced monotonic so durations sum to the span.
    const frames: Array<{ file: string; atMs: number }> = [];
    for (let i = 0; i < this.frameTimestamps.length; i++) {
      const file = `frame_${String(i).padStart(6, '0')}.${FRAME_EXT}`;
      if (!fs.existsSync(path.join(this.frameDir, file))) continue;
      const prevMs = frames.length > 0 ? frames[frames.length - 1].atMs : 0;
      frames.push({ file, atMs: Math.max(this.frameTimestamps[i], prevMs) });
    }
    if (frames.length === 0) {
      return this.assembleFramesFixedRate(outputPath, stopMs / 1000, targetFps);
    }

    const last = frames.length - 1;
    for (let i = 0; i <= last; i++) {
      lines.push(`file ${frames[i].file}`);

      // The first frame covers from recording start (it is what was on screen
      // when recording began); the last holds until recording stopped.
      const shownFrom = i === 0 ? 0 : frames[i].atMs;
      const shownUntil = i < last ? frames[i + 1].atMs : Math.max(stopMs, shownFrom + minFrameMs);
      const durationMs = Math.max(1, shownUntil - shownFrom);
      lines.push(`duration ${(durationMs / 1000).toFixed(6)}`);
    }

    // The concat demuxer ignores the final entry's duration unless the file
    // is listed once more — without this the video ends at the last frame's
    // timestamp instead of the moment recording stopped.
    lines.push(`file ${frames[last].file}`);

    fs.writeFileSync(concatListPath, lines.join('\n'), 'utf-8');

    this.logger.debug(
      `Concat assembly: ${this.frameTimestamps.length} frames over ${(stopMs / 1000).toFixed(1)}s`
    );

    const result = child_process.spawnSync(
      'ffmpeg',
      [
        '-f', 'concat',
        '-safe', '0',
        '-i', concatListPath.replace(/\\/g, '/'),
        '-vf', this.outputScaleFilter(),
        '-c:v', 'libx264',
        '-pix_fmt', 'yuv420p',
        '-r', String(targetFps),
        '-preset', 'fast',
        '-crf', '23',
        '-y',
        outputPath,
      ],
      { encoding: 'utf-8', timeout: 120000, windowsHide: true }
    );

    if (result.status !== 0) {
      const msg = result.stderr?.slice(-800) || result.error?.message || 'Unknown error';
      this.logger.error(`FFmpeg concat error: ${msg}`);
      throw new Error(`ffmpeg exited with code ${result.status}: ${msg}`);
    }

    this.logger.info(`Clip assembled (concat): ${outputPath}`);
    this.cleanupFrames();
    return Promise.resolve();
  }

  /** Fallback: fixed-framerate assembly when per-frame timestamps are unavailable. */
  private assembleFramesFixedRate(
    outputPath: string,
    realDurationSeconds: number | undefined,
    targetFps: number
  ): Promise<void> {
    const framePattern = path.resolve(this.frameDir, `frame_%06d.${FRAME_EXT}`).replace(/\\/g, '/');
    const inputFramerate =
      realDurationSeconds != null && realDurationSeconds > 0.1
        ? this.frameCount / realDurationSeconds
        : targetFps;

    if (realDurationSeconds != null && realDurationSeconds > 0.1) {
      this.logger.debug(
        `Fixed-rate assembly (fallback): ${this.frameCount} frames over ${realDurationSeconds.toFixed(1)}s ` +
          `→ input ${inputFramerate.toFixed(1)}fps, output ${targetFps}fps`
      );
    }

    const result = child_process.spawnSync(
      'ffmpeg',
      [
        '-framerate', String(inputFramerate),
        '-f', 'image2',
        '-start_number', '0',
        '-i', framePattern,
        '-vf', this.outputScaleFilter(),
        '-c:v', 'libx264',
        '-pix_fmt', 'yuv420p',
        '-r', String(targetFps),
        '-preset', 'fast',
        '-crf', '23',
        '-y',
        outputPath,
      ],
      { encoding: 'utf-8', timeout: 120000, windowsHide: true }
    );

    if (result.status !== 0) {
      const msg = result.stderr?.slice(-800) || result.error?.message || 'Unknown error';
      this.logger.error(`FFmpeg error: ${msg}`);
      throw new Error(`ffmpeg exited with code ${result.status}: ${msg}`);
    }

    this.logger.info(`Clip assembled: ${outputPath}`);
    this.cleanupFrames();
    return Promise.resolve();
  }

  /**
   * Scale frames to the configured output resolution, letterboxing if the
   * captured aspect ratio differs, so every clip has the same size (the
   * final concat and the zoom math both depend on it).
   */
  private outputScaleFilter(): string {
    const { width, height } = this.config.video.resolution;
    return (
      `scale=${width}:${height}:force_original_aspect_ratio=decrease,` +
      `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=white,setsar=1`
    );
  }

  private cleanupFrames(): void {
    try {
      const files = fs.readdirSync(this.frameDir);
      for (const file of files) {
        fs.unlinkSync(path.join(this.frameDir, file));
      }
      fs.rmdirSync(this.frameDir);
    } catch {
      // Non-critical cleanup
    }
  }
}
