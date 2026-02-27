/**
 * Click & Scroll Recorder — Puppeteer-based tool for building click and scroll
 * audio libraries.
 *
 * Architecture mirrors the keystroke recorder:
 *   1. Open a Puppeteer browser window with a purpose-built recording UI.
 *   2. Start ffmpeg audio capture (same approach as KeystrokeRecorder).
 *   3. Expose JS → Node callbacks so click/wheel events are timestamped
 *      precisely in Node-space (Date.now()) the moment they arrive.
 *   4. On session end, save audio + JSON sidecar (ClickClipMeta or
 *      ScrollClipMeta) for each captured event / gesture.
 *
 * Click sessions produce one clip file per individual click so each file
 * in the library is a single sound. Scroll sessions group consecutive wheel
 * events (gap < SCROLL_IDLE_MS) into gesture clips, exactly like how the
 * keystroke recorder segments by idle gap.
 *
 * Usage (via CLI or programmatically):
 *
 *   const rec = new ClickScrollRecorder({ outputDir: 'sfx-library/clicks/left', ... });
 *   await rec.runClickSession('left', 50);   // record 50 left-click clips
 *
 *   const rec2 = new ClickScrollRecorder({ outputDir: 'sfx-library/scrolls', ... });
 *   await rec2.runScrollSession(30);         // record 30 scroll gesture clips
 */

import * as child_process from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import puppeteer from 'puppeteer-core';
import type { Browser, Page } from 'puppeteer-core';
import { ClickButtonType, ClickClipMeta, ScrollClipMeta, ScrollEvent } from '../core/types';
import { Logger } from '../utils/logger';

/** Wheel events closer together than this (ms) belong to the same gesture. */
const SCROLL_IDLE_MS = 600;

/** Ms of audio to capture before the first detected click transient. */
const CLICK_PRE_ROLL_MS = 80;

/** Ms of audio to capture after a click event. */
const CLICK_POST_ROLL_MS = 350;

/** Ms of audio to capture after the last scroll event in a gesture. */
const SCROLL_TAIL_MS = 500;

// ─── helpers ────────────────────────────────────────────────────────────────

function getMaxExistingClipNumber(dir: string): number {
  let max = 0;
  try {
    for (const name of fs.readdirSync(dir)) {
      const m = name.match(/^clip_(\d+)\.(json|wav|flac)$/i);
      if (m) {
        const n = parseInt(m[1], 10);
        if (n > max) max = n;
      }
    }
  } catch { /* dir missing */ }
  return max;
}

function getDshowAudioDevices(): string[] {
  const names: string[] = [];
  try {
    const r = child_process.spawnSync(
      'ffmpeg', ['-list_devices', 'true', '-f', 'dshow', '-i', 'dummy'],
      { encoding: 'utf8', maxBuffer: 100 * 1024, windowsHide: true }
    );
    const re = /"([^"]+)"\s*\(audio\)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec((r.stderr ?? r.stdout ?? '') as string)) !== null) names.push(m[1]);
  } catch { /* ignore */ }
  return names;
}

// ─── ClickScrollRecorder ────────────────────────────────────────────────────

export class ClickScrollRecorder {
  private outputDir: string;
  private sampleRate: number;
  private audioFormat: 'wav' | 'flac';
  private browserExecutablePath: string;
  private logger: Logger;

  constructor(options: {
    outputDir: string;
    browserExecutablePath?: string;
    sampleRate?: number;
    audioFormat?: 'wav' | 'flac';
    logger: Logger;
  }) {
    this.outputDir = options.outputDir;
    this.browserExecutablePath =
      options.browserExecutablePath ??
      process.env.CHROME_PATH ??
      '/usr/bin/google-chrome';
    this.sampleRate = options.sampleRate ?? 44100;
    this.audioFormat = options.audioFormat ?? 'wav';
    this.logger = options.logger;
    fs.mkdirSync(this.outputDir, { recursive: true });
  }

  // ─── Public API ───────────────────────────────────────────────────────────

  /**
   * Open a browser recording page and capture `targetCount` individual
   * click clips of the specified button type.
   *
   * Each detected click is saved as its own clip_XXXX.(wav|flac) + .json
   * pair. The clickSignalMs field records where the transient lands inside
   * the audio file (always CLICK_PRE_ROLL_MS from the start).
   *
   * @param clickType    Which mouse button to capture
   * @param targetCount  How many clips to collect before auto-closing
   */
  async runClickSession(
    clickType: ClickButtonType,
    targetCount: number
  ): Promise<ClickClipMeta[]> {
    this.logger.info(`=== Click recorder: ${clickType} clicks — target ${targetCount} clips ===`);
    this.logger.info(`Output directory: ${this.outputDir}`);

    const { browser, page } = await this.openRecordingPage('click', clickType, targetCount);
    const clips: ClickClipMeta[] = [];
    let clipCounter = getMaxExistingClipNumber(this.outputDir);

    // Full-session audio capture for later slicing
    const sessionBase = `session_${Date.now()}`;
    const sessionWav = path.join(this.outputDir, `${sessionBase}.${this.audioFormat}`);
    const sessionStartMs = Date.now();

    const audioProc = this.startAudio(sessionWav);
    // Give ffmpeg time to start before we expose the event callback
    await new Promise((r) => setTimeout(r, 300));

    const rawEvents: Array<{ timestampMs: number }> = [];

    await page.exposeFunction('__onClickRecorded', () => {
      rawEvents.push({ timestampMs: Date.now() - sessionStartMs });
      this.logger.info(`  click ${rawEvents.length}/${targetCount} @ ${rawEvents[rawEvents.length - 1].timestampMs}ms`);
      if (rawEvents.length >= targetCount) {
        // Notify page so it can update the UI
        page.evaluate(() => {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (globalThis as any).__sessionDone?.();
        }).catch(() => {});
      }
    });

    await this.injectClickListener(page, clickType);

    // Wait until target count or user closes the page
    await this.waitForSessionEnd(page, () => rawEvents.length >= targetCount);

    // Stop audio
    await this.stopAudio(audioProc);

    // Give the OS a moment to flush the audio file
    await new Promise((r) => setTimeout(r, 500));

    await browser.close();

    if (!fs.existsSync(sessionWav)) {
      this.logger.warn('Session audio file missing — no clips extracted.');
      return clips;
    }

    // Extract one clip per click event
    for (const ev of rawEvents) {
      const startSec = Math.max(0, (ev.timestampMs - CLICK_PRE_ROLL_MS) / 1000);
      const durationSec = (CLICK_PRE_ROLL_MS + CLICK_POST_ROLL_MS) / 1000;

      clipCounter++;
      const name = `clip_${String(clipCounter).padStart(4, '0')}`;
      const destAudio = path.join(this.outputDir, `${name}.${this.audioFormat}`);

      if (!this.sliceAudio(sessionWav, destAudio, startSec, durationSec)) continue;

      const meta: ClickClipMeta = {
        audioFile: `${name}.${this.audioFormat}`,
        durationMs: (CLICK_PRE_ROLL_MS + CLICK_POST_ROLL_MS),
        clickType,
        clickSignalMs: CLICK_PRE_ROLL_MS,
      };
      fs.writeFileSync(path.join(this.outputDir, `${name}.json`), JSON.stringify(meta, null, 2));
      clips.push(meta);
      this.logger.info(`Saved ${name} (${clickType} click)`);
    }

    // Clean up session audio
    try { fs.unlinkSync(sessionWav); } catch { /* ignore */ }

    this.logger.info(`Click session complete: ${clips.length} clips saved.`);
    return clips;
  }

  /**
   * Open a browser recording page and capture scroll gesture clips.
   *
   * Consecutive wheel events closer than SCROLL_IDLE_MS are grouped into
   * a single gesture. Each gesture becomes one clip file.
   *
   * @param targetCount  How many gesture clips to collect before auto-closing
   */
  async runScrollSession(targetCount: number): Promise<ScrollClipMeta[]> {
    this.logger.info(`=== Scroll recorder — target ${targetCount} clips ===`);
    this.logger.info(`Output directory: ${this.outputDir}`);

    const { browser, page } = await this.openRecordingPage('scroll', undefined, targetCount);
    const clips: ScrollClipMeta[] = [];
    let clipCounter = getMaxExistingClipNumber(this.outputDir);

    const sessionBase = `session_${Date.now()}`;
    const sessionWav = path.join(this.outputDir, `${sessionBase}.${this.audioFormat}`);
    const sessionStartMs = Date.now();

    const audioProc = this.startAudio(sessionWav);
    await new Promise((r) => setTimeout(r, 300));

    const rawScrollEvents: ScrollEvent[] = [];
    let gestureCount = 0;

    await page.exposeFunction('__onWheelRecorded', (deltaY: number) => {
      const timestampMs = Date.now() - sessionStartMs;
      rawScrollEvents.push({ deltaY, timestampMs });

      // Count gestures by idle gaps
      const events = rawScrollEvents;
      if (events.length > 1) {
        const prev = events[events.length - 2].timestampMs;
        const curr = events[events.length - 1].timestampMs;
        if (curr - prev >= SCROLL_IDLE_MS) gestureCount++;
      } else {
        gestureCount = 1; // first event starts gesture 1
      }
    });

    await this.injectScrollListener(page);

    await this.waitForSessionEnd(page, () => {
      // Count completed gestures (those followed by an idle gap)
      const events = rawScrollEvents;
      if (events.length < 2) return false;
      const lastGap = (Date.now() - sessionStartMs) - events[events.length - 1].timestampMs;
      const completedGestures = lastGap > SCROLL_IDLE_MS ? gestureCount : gestureCount - 1;
      return completedGestures >= targetCount;
    });

    await this.stopAudio(audioProc);
    await new Promise((r) => setTimeout(r, 500));
    await browser.close();

    if (!fs.existsSync(sessionWav)) {
      this.logger.warn('Session audio file missing — no clips extracted.');
      return clips;
    }

    // Segment by idle gap
    const gestures = this.segmentScrollGestures(rawScrollEvents);

    for (const gesture of gestures) {
      if (gesture.length === 0) continue;

      const startMs = gesture[0].timestampMs;
      const endMs = gesture[gesture.length - 1].timestampMs;
      const durationMs = endMs - startMs + SCROLL_TAIL_MS;
      const startSec = Math.max(0, startMs / 1000);
      const durationSec = durationMs / 1000;

      const totalDeltaY = gesture.reduce((s, e) => s + Math.abs(e.deltaY), 0);
      const sumDelta = gesture.reduce((s, e) => s + e.deltaY, 0);
      const direction: 'down' | 'up' = sumDelta >= 0 ? 'down' : 'up';

      clipCounter++;
      const name = `clip_${String(clipCounter).padStart(4, '0')}`;
      const destAudio = path.join(this.outputDir, `${name}.${this.audioFormat}`);

      if (!this.sliceAudio(sessionWav, destAudio, startSec, durationSec)) continue;

      // Re-zero event timestamps to clip start
      const events: ScrollEvent[] = gesture.map((e) => ({
        deltaY: e.deltaY,
        timestampMs: e.timestampMs - startMs,
      }));

      const meta: ScrollClipMeta = {
        audioFile: `${name}.${this.audioFormat}`,
        durationMs,
        totalDeltaY,
        direction,
        events,
      };
      fs.writeFileSync(path.join(this.outputDir, `${name}.json`), JSON.stringify(meta, null, 2));
      clips.push(meta);
      this.logger.info(
        `Saved ${name} (${direction}, ${totalDeltaY.toFixed(0)}px, ${events.length} events)`
      );

      if (clips.length >= targetCount) break;
    }

    try { fs.unlinkSync(sessionWav); } catch { /* ignore */ }
    this.logger.info(`Scroll session complete: ${clips.length} clips saved.`);
    return clips;
  }

  // ─── Internal helpers ─────────────────────────────────────────────────────

  private async openRecordingPage(
    mode: 'click' | 'scroll',
    clickType?: ClickButtonType,
    targetCount?: number
  ): Promise<{ browser: Browser; page: Page }> {
    const browser = await puppeteer.launch({
      executablePath: this.browserExecutablePath,
      headless: false,
      defaultViewport: null,
      args: ['--window-size=900,600', '--no-first-run', '--no-default-browser-check'],
    });

    const pages = await browser.pages();
    const page = pages[0] || await browser.newPage();
    await page.setViewport({ width: 900, height: 600 });

    const title = mode === 'click'
      ? `Click Recorder — ${clickType} clicks`
      : 'Scroll Recorder';
    const instructions = mode === 'click'
      ? `Click anywhere on this page with your <strong>${clickType} mouse button</strong>.<br>
         Each click is recorded. Target: <span id="target">${targetCount}</span> clips.<br>
         Close the window when done (or it will close automatically).`
      : `Scroll (swipe) naturally on this page.<br>
         Each swipe gesture is recorded. Target: <span id="target">${targetCount}</span> clips.<br>
         Close the window when done.`;

    const bgColor = mode === 'click' ? '#1a1a2e' : '#0f3460';
    const accentColor = mode === 'click' ? '#e94560' : '#16213e';

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>${title}</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      background: ${bgColor};
      color: #eee;
      height: 100vh;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      user-select: none;
      cursor: ${mode === 'click' ? 'crosshair' : 'ns-resize'};
    }
    h1 { font-size: 1.6rem; margin-bottom: 1rem; }
    p { font-size: 1rem; line-height: 1.6; text-align: center; max-width: 520px; opacity: 0.9; }
    #counter {
      margin-top: 2rem;
      font-size: 3rem;
      font-weight: bold;
      color: ${mode === 'click' ? '#e94560' : '#53d8fb'};
      transition: transform 0.1s;
    }
    #status { margin-top: 1rem; font-size: 0.9rem; opacity: 0.6; }
    .flash {
      position: fixed; inset: 0;
      background: rgba(255,255,255,0.15);
      pointer-events: none;
      animation: fadeOut 0.2s forwards;
    }
    @keyframes fadeOut { to { opacity: 0; } }
    /* Tall scrollable content for scroll mode */
    #scroll-content {
      display: ${mode === 'scroll' ? 'block' : 'none'};
      position: fixed;
      top: 0; left: 0; right: 0;
      height: 300vh;
      background: linear-gradient(180deg, ${bgColor} 0%, ${accentColor} 100%);
      z-index: -1;
    }
  </style>
</head>
<body>
  <div id="scroll-content"></div>
  <h1>${title}</h1>
  <p>${instructions}</p>
  <div id="counter">0</div>
  <div id="status">Listening…</div>
  <script>
    let count = 0;
    const counterEl = document.getElementById('counter');
    const statusEl = document.getElementById('status');
    const target = ${targetCount ?? 0};

    function flash() {
      const el = document.createElement('div');
      el.className = 'flash';
      document.body.appendChild(el);
      el.addEventListener('animationend', () => el.remove());
    }

    function bump() {
      count++;
      counterEl.textContent = count;
      counterEl.style.transform = 'scale(1.3)';
      setTimeout(() => { counterEl.style.transform = ''; }, 120);
      flash();
      if (target > 0 && count >= target) {
        statusEl.textContent = 'Target reached! You can close this window.';
      }
    }

    window.__sessionDone = () => {
      statusEl.textContent = 'Target reached! You can close this window.';
    };

    ${mode === 'click' ? `
    document.addEventListener('mousedown', (e) => {
      // Only capture the intended button
      const clickType = '${clickType}';
      if (clickType === 'left' && e.button !== 0) return;
      if (clickType === 'right' && e.button !== 2) return;
      if (clickType === 'double') return; // handled by dblclick
      window.__onClickRecorded();
      bump();
      e.preventDefault();
    });
    document.addEventListener('dblclick', (e) => {
      if ('${clickType}' !== 'double') return;
      window.__onClickRecorded();
      bump();
      e.preventDefault();
    });
    document.addEventListener('contextmenu', (e) => e.preventDefault());
    ` : `
    document.addEventListener('wheel', (e) => {
      window.__onWheelRecorded(e.deltaY);
      bump();
      e.preventDefault();
    }, { passive: false });
    `}
  </script>
</body>
</html>`;

    await page.setContent(html, { waitUntil: 'domcontentloaded' });
    return { browser, page };
  }

  private async injectClickListener(_page: Page, _clickType: ClickButtonType): Promise<void> {
    // Listener is already injected via setContent; nothing extra needed.
  }

  private async injectScrollListener(_page: Page): Promise<void> {
    // Listener is already injected via setContent; nothing extra needed.
  }

  /**
   * Wait until the done predicate returns true OR the page/browser closes.
   * Poll every 500ms.
   */
  private async waitForSessionEnd(page: Page, done: () => boolean): Promise<void> {
    return new Promise((resolve) => {
      const interval = setInterval(() => {
        try {
          if (done() || page.isClosed()) {
            clearInterval(interval);
            resolve();
          }
        } catch {
          clearInterval(interval);
          resolve();
        }
      }, 500);

      page.once('close', () => { clearInterval(interval); resolve(); });
    });
  }

  private startAudio(outputPath: string): ReturnType<typeof child_process.spawn> {
    const { spawn } = child_process;
    const absolutePath = path.resolve(outputPath);
    const isWin = process.platform === 'win32';

    let args: string[];
    if (isWin) {
      const devices = getDshowAudioDevices();
      const preferred = process.env.TYPING_AUDIO_DEVICE;
      const device = preferred && devices.includes(preferred) ? preferred : devices[0];
      if (!device) throw new Error('No DirectShow audio device found.');
      args = ['-f', 'dshow', '-i', `audio=${device}`, '-ar', String(this.sampleRate), '-ac', '1', '-y', absolutePath];
    } else {
      args = ['-f', 'pulse', '-i', 'default', '-ar', String(this.sampleRate), '-ac', '1', '-y', absolutePath];
    }

    const proc = spawn('ffmpeg', args, { stdio: 'pipe' });
    proc.on('error', (err: NodeJS.ErrnoException) => {
      if (err?.code === 'ENOENT') {
        this.logger.error('Audio capture failed: ffmpeg not found.');
      } else {
        this.logger.error('Audio process error: %s', err.message);
      }
    });
    return proc;
  }

  private async stopAudio(proc: ReturnType<typeof child_process.spawn>): Promise<void> {
    return new Promise((resolve) => {
      const timeout = setTimeout(() => { proc.kill('SIGKILL'); resolve(); }, 8000);
      proc.once('exit', () => { clearTimeout(timeout); resolve(); });
      if (proc.stdin?.writable) {
        proc.stdin.write('q');
        proc.stdin.end();
      } else {
        proc.kill('SIGINT');
        setTimeout(resolve, 500);
      }
    });
  }

  private sliceAudio(
    src: string,
    dest: string,
    startSec: number,
    durationSec: number
  ): boolean {
    try {
      const r = child_process.spawnSync('ffmpeg', [
        '-i', src,
        '-ss', String(startSec),
        '-t', String(durationSec),
        '-af', 'loudnorm=I=-14:LRA=11:TP=-1.5',
        '-y', dest,
      ], { encoding: 'utf8', windowsHide: true, timeout: 30000 });
      if (r.status !== 0) {
        this.logger.warn('ffmpeg slice failed: %s', (r.stderr ?? '').slice(0, 200));
        return false;
      }
      return true;
    } catch (e) {
      this.logger.warn('ffmpeg slice error: %s', (e as Error).message);
      return false;
    }
  }

  private segmentScrollGestures(events: ScrollEvent[]): ScrollEvent[][] {
    if (events.length === 0) return [];
    const gestures: ScrollEvent[][] = [];
    let current: ScrollEvent[] = [events[0]];

    for (let i = 1; i < events.length; i++) {
      const gap = events[i].timestampMs - events[i - 1].timestampMs;
      if (gap >= SCROLL_IDLE_MS) {
        if (current.length > 0) gestures.push(current);
        current = [events[i]];
      } else {
        current.push(events[i]);
      }
    }
    if (current.length > 0) gestures.push(current);
    return gestures;
  }
}
