import { Page, CDPSession } from 'puppeteer-core';
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

  /** Stop recording and assemble frames into a video file. Returns the output path. */
  async stopRecording(clipName: string): Promise<string> {
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

    const outputPath = path.join(this.config.outputDir, 'clips', `${clipName}.mp4`);
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });

    if (this.frameCount === 0) {
      this.logger.warn('No frames captured — creating empty clip marker.');
      fs.writeFileSync(outputPath, '');
      return outputPath;
    }

    // Assemble frames into video using FFmpeg
    await this.assembleFrames(outputPath);
    return outputPath;
  }

  private assembleFrames(outputPath: string): Promise<void> {
    return new Promise((resolve, reject) => {
      // Dynamic import to avoid hard dependency if ffmpeg not needed yet
      const ffmpeg = require('fluent-ffmpeg') as typeof import('fluent-ffmpeg');

      ffmpeg()
        .input(path.join(this.frameDir, 'frame_%06d.png'))
        .inputFPS(this.config.video.fps)
        .outputOptions([
          '-c:v libx264',
          '-pix_fmt yuv420p',
          `-r ${this.config.video.fps}`,
          '-preset fast',
          '-crf 23',
        ])
        .output(outputPath)
        .on('end', () => {
          this.logger.info(`Clip assembled: ${outputPath}`);
          // Clean up frame images
          this.cleanupFrames();
          resolve();
        })
        .on('error', (err: Error) => {
          this.logger.error(`FFmpeg error: ${err.message}`);
          reject(err);
        })
        .run();
    });
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
