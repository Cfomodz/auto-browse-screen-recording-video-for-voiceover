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
    this.recording = true;

    // Create a CDP session for screencast
    this.cdpSession = await page.createCDPSession();

    this.cdpSession.on('Page.screencastFrame', async (event) => {
      if (!this.recording) return;

      try {
        // Acknowledge the frame
        await this.cdpSession!.send('Page.screencastFrameAck', {
          sessionId: event.sessionId,
        });

        // Save frame as PNG
        const frameBuffer = Buffer.from(event.data, 'base64');
        const framePath = path.join(
          this.frameDir,
          `frame_${String(this.frameCount).padStart(6, '0')}.png`
        );
        fs.writeFileSync(framePath, frameBuffer);
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
   * @param realDurationSeconds - Elapsed real time for the recording. When provided,
   * the video is stretched to match real-time via frame duplication (input framerate
   * = frameCount/realDuration), so SFX and cursor animations stay in sync without scaling.
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

  private assembleFrames(outputPath: string, realDurationSeconds?: number): Promise<void> {
    // Use spawnSync — fluent-ffmpeg can fail on Windows (path/argument handling).
    // Absolute path with forward slashes for image2 compatibility.
    const framePattern = path.resolve(this.frameDir, 'frame_%06d.png').replace(/\\/g, '/');

    // When real duration is provided, use frameCount/realDuration so video length matches
    // real time; FFmpeg duplicates frames to reach output fps. Keeps SFX/cursor in sync.
    const targetFps = this.config.video.fps;
    const inputFramerate =
      realDurationSeconds != null &&
      realDurationSeconds > 0.1
        ? this.frameCount / realDurationSeconds
        : targetFps;

    if (realDurationSeconds != null && realDurationSeconds > 0.1) {
      this.logger.debug(
        `Real-time assembly: ${this.frameCount} frames over ${realDurationSeconds.toFixed(1)}s ` +
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
      if (this.logger.level === 'debug') {
        this.logger.debug(`FFmpeg args: ${JSON.stringify([framePattern, outputPath])}`);
      }
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
