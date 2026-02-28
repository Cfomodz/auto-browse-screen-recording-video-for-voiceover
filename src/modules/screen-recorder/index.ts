import { Page, CDPSession } from 'puppeteer-core';
import * as child_process from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { PipelineConfig } from '../../core/types';
import { Logger } from '../../utils/logger';

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
  private frames: Buffer[] = [];
  private recording = false;
  private frameDir: string = '';
  private frameCount = 0;
  /** Wall-clock timestamp (ms since recording start) for each captured frame. */
  private frameTimestamps: number[] = [];
  private _recordingStartTime: number = 0;

  /** Absolute Date.now() when the current recording started. */
  get recordingStartTime(): number {
    return this._recordingStartTime;
  }

  constructor(config: PipelineConfig, logger: Logger) {
    this.config = config;
    this.logger = logger;
  }

  /** Start recording the browser page. */
  async startRecording(page: Page, clipName: string): Promise<void> {
    this.frameDir = path.join(this.config.outputDir, 'frames', clipName);
    fs.mkdirSync(this.frameDir, { recursive: true });

    this.frames = [];
    this.frameCount = 0;
    this.frameTimestamps = [];
    this.recording = true;
    this._recordingStartTime = Date.now();

    // Create a CDP session for screencast
    this.cdpSession = await page.createCDPSession();

    this.cdpSession.on('Page.screencastFrame', async (event) => {
      if (!this.recording) return;

      try {
        // Acknowledge the frame
        await this.cdpSession!.send('Page.screencastFrameAck', {
          sessionId: event.sessionId,
        });

        // Save frame as PNG with wall-clock timestamp
        const frameBuffer = Buffer.from(event.data, 'base64');
        const framePath = path.join(
          this.frameDir,
          `frame_${String(this.frameCount).padStart(6, '0')}.png`
        );
        fs.writeFileSync(framePath, frameBuffer);
        this.frameTimestamps.push(Date.now() - this._recordingStartTime);
        this.frameCount++;
      } catch (err) {
        // Frame capture can fail during navigation; non-fatal
      }
    });

    await this.cdpSession.send('Page.startScreencast', {
      format: 'png',
      quality: 80,
      maxWidth: this.config.video.resolution.width,
      maxHeight: this.config.video.resolution.height,
      everyNthFrame: 1,
    });

    this.logger.info(`Recording started: ${clipName}`);
  }

  /**
   * Stop recording and assemble frames into a video file. Returns the output path.
   * @param realDurationSeconds - Elapsed real time for the recording (module duration).
   * Used as fallback for fixed-rate assembly when per-frame timestamps are unavailable.
   * The primary assembly path uses the concat demuxer with per-frame wall-clock durations,
   * preserving real-time spacing regardless of CDP's variable frame delivery rate.
   */
  async stopRecording(clipName: string, realDurationSeconds?: number): Promise<string> {
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

    this.logger.info(`Recording stopped: ${clipName} (${this.frameCount} frames captured)`);

    // Wait for in-flight screencastFrame handlers to finish writing; verify frames on disk
    await new Promise((r) => setTimeout(r, 300));
    const maxWait = 5000;
    const start = Date.now();
    while (Date.now() - start < maxWait) {
      try {
        const files = fs.readdirSync(this.frameDir).filter((f) => f.endsWith('.png'));
        if (files.length >= this.frameCount) break;
      } catch {
        // frameDir may not exist if no frames; fall through
      }
      await new Promise((r) => setTimeout(r, 100));
    }

    const outputPath = path.resolve(this.config.outputDir, 'clips', `${clipName}.mp4`);
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });

    if (this.frameCount === 0) {
      this.logger.warn('No frames captured — creating empty clip marker.');
      fs.writeFileSync(outputPath, '');
      return outputPath;
    }

    // Assemble frames into video using FFmpeg
    await this.assembleFrames(outputPath, realDurationSeconds);
    return outputPath;
  }

  /**
   * Assemble captured frames into a video.
   *
   * Primary path: uses the concat demuxer with per-frame durations derived
   * from wall-clock timestamps. CDP screencast delivers frames at variable
   * rates (many during animations, few during idle waits), so a fixed input
   * framerate would compress active periods and stretch idle ones — causing
   * SFX audio to drift seconds from the visual events that triggered them.
   *
   * Fallback: fixed-framerate image2 input when fewer than 2 timestamps exist.
   */
  private assembleFrames(outputPath: string, realDurationSeconds?: number): Promise<void> {
    const targetFps = this.config.video.fps;

    if (this.frameTimestamps.length >= 2) {
      return this.assembleFramesConcat(outputPath, targetFps);
    }

    return this.assembleFramesFixedRate(outputPath, realDurationSeconds, targetFps);
  }

  /** Concat-demuxer assembly: each frame gets its real wall-clock duration. */
  private assembleFramesConcat(outputPath: string, targetFps: number): Promise<void> {
    const concatListPath = path.join(this.frameDir, 'concat_frames.txt');
    const lines: string[] = ['ffconcat version 1.0'];

    for (let i = 0; i < this.frameTimestamps.length; i++) {
      lines.push(`file frame_${String(i).padStart(6, '0')}.png`);

      let durationMs: number;
      if (i < this.frameTimestamps.length - 1) {
        durationMs = this.frameTimestamps[i + 1] - this.frameTimestamps[i];
      } else {
        durationMs = i > 0
          ? this.frameTimestamps[i] - this.frameTimestamps[i - 1]
          : 1000 / targetFps;
      }
      lines.push(`duration ${Math.max(0.001, durationMs / 1000).toFixed(6)}`);
    }

    fs.writeFileSync(concatListPath, lines.join('\n'), 'utf-8');

    const lastTs = this.frameTimestamps[this.frameTimestamps.length - 1];
    this.logger.debug(
      `Concat assembly: ${this.frameTimestamps.length} frames over ~${(lastTs / 1000).toFixed(1)}s`
    );

    const result = child_process.spawnSync(
      'ffmpeg',
      [
        '-f', 'concat',
        '-safe', '0',
        '-i', concatListPath.replace(/\\/g, '/'),
        '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2',
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
    const framePattern = path.resolve(this.frameDir, 'frame_%06d.png').replace(/\\/g, '/');
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
        '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2',
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
