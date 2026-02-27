/**
 * Integration tests that actually call FFmpeg and validate real file output.
 *
 * These tests are the safety net for issues like:
 * - Audio recording producing 0kb or silent files
 * - FFmpeg filter chains being malformed
 * - Video concatenation failing silently
 * - Loudness normalization producing silence
 *
 * Run with: npx vitest run tests/integration
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as child_process from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import {
  ffprobe,
  audioHasContent,
  generateTestTone,
  generateTestVideo,
  makeTempDir,
  assertFileExists,
} from '../helpers';

let tmpDir: string;
let cleanup: () => void;

beforeAll(() => {
  const tmp = makeTempDir('integration-');
  tmpDir = tmp.dir;
  cleanup = tmp.cleanup;
});

afterAll(() => cleanup());

describe('FFmpeg availability', () => {
  it('ffmpeg is installed and executable', () => {
    const result = child_process.spawnSync('ffmpeg', ['-version'], { encoding: 'utf-8' });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('ffmpeg version');
  });

  it('ffprobe is installed and executable', () => {
    const result = child_process.spawnSync('ffprobe', ['-version'], { encoding: 'utf-8' });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('ffprobe version');
  });
});

describe('Test tone generation', () => {
  it('generates a valid WAV file with actual audio', () => {
    const tonePath = path.join(tmpDir, 'test_tone.wav');
    generateTestTone(tonePath, { durationSec: 2, frequency: 440 });

    assertFileExists(tonePath, 100);

    const probe = ffprobe(tonePath);
    expect(probe.streams.length).toBeGreaterThan(0);
    const audioStream = probe.streams.find((s) => s.codec_type === 'audio');
    expect(audioStream).toBeDefined();
    expect(audioStream!.codec_name).toBe('pcm_s16le');

    const content = audioHasContent(tonePath);
    expect(content.isSilent).toBe(false);
    expect(content.peakDb).toBeGreaterThan(-30);
  });

  it('generates tones at different frequencies', () => {
    const tone220 = path.join(tmpDir, 'tone_220.wav');
    const tone880 = path.join(tmpDir, 'tone_880.wav');
    generateTestTone(tone220, { frequency: 220, durationSec: 1 });
    generateTestTone(tone880, { frequency: 880, durationSec: 1 });

    assertFileExists(tone220, 100);
    assertFileExists(tone880, 100);

    // Both should have non-silent audio
    expect(audioHasContent(tone220).isSilent).toBe(false);
    expect(audioHasContent(tone880).isSilent).toBe(false);
  });

  it('produces correct duration', () => {
    const tonePath = path.join(tmpDir, 'tone_3s.wav');
    generateTestTone(tonePath, { durationSec: 3 });

    const probe = ffprobe(tonePath);
    const duration = parseFloat(probe.format.duration);
    expect(duration).toBeCloseTo(3, 0);
  });
});

describe('Test video generation', () => {
  it('generates a valid MP4 file', () => {
    const videoPath = path.join(tmpDir, 'test_video.mp4');
    generateTestVideo(videoPath, { durationSec: 2, width: 640, height: 480, fps: 30 });

    assertFileExists(videoPath, 1000);

    const probe = ffprobe(videoPath);
    const videoStream = probe.streams.find((s) => s.codec_type === 'video');
    expect(videoStream).toBeDefined();
    expect(videoStream!.width).toBe(640);
    expect(videoStream!.height).toBe(480);
    expect(videoStream!.codec_name).toBe('h264');
  });

  it('generates full HD video', () => {
    const videoPath = path.join(tmpDir, 'test_1080p.mp4');
    generateTestVideo(videoPath, { durationSec: 1, width: 1920, height: 1080 });

    assertFileExists(videoPath, 1000);

    const probe = ffprobe(videoPath);
    const videoStream = probe.streams.find((s) => s.codec_type === 'video');
    expect(videoStream!.width).toBe(1920);
    expect(videoStream!.height).toBe(1080);
  });
});

describe('Audio manipulation with FFmpeg', () => {
  it('loudnorm filter produces non-silent output', () => {
    const srcPath = path.join(tmpDir, 'loud_src.wav');
    const normPath = path.join(tmpDir, 'loud_normalized.wav');
    generateTestTone(srcPath, { durationSec: 2, frequency: 440 });

    const result = child_process.spawnSync('ffmpeg', [
      '-i', srcPath,
      '-af', 'loudnorm=I=-14:LRA=11:TP=-1.5',
      '-y', normPath,
    ], { encoding: 'utf-8', timeout: 15000 });

    expect(result.status).toBe(0);
    assertFileExists(normPath, 100);

    const content = audioHasContent(normPath);
    expect(content.isSilent).toBe(false);
    expect(content.peakDb).toBeGreaterThan(-30);
  });

  it('audio slicing produces correct duration', () => {
    const srcPath = path.join(tmpDir, 'slice_src.wav');
    const slicePath = path.join(tmpDir, 'slice_out.wav');
    generateTestTone(srcPath, { durationSec: 5, frequency: 440 });

    // Slice from 1s to 3s (2 second duration)
    const result = child_process.spawnSync('ffmpeg', [
      '-i', srcPath,
      '-ss', '1',
      '-t', '2',
      '-y', slicePath,
    ], { encoding: 'utf-8', timeout: 15000 });

    expect(result.status).toBe(0);
    assertFileExists(slicePath, 100);

    const probe = ffprobe(slicePath);
    const duration = parseFloat(probe.format.duration);
    expect(duration).toBeCloseTo(2, 0);

    const content = audioHasContent(slicePath);
    expect(content.isSilent).toBe(false);
  });

  it('audio mixing (amix) of two tracks produces non-silent output', () => {
    const track1 = path.join(tmpDir, 'mix_track1.wav');
    const track2 = path.join(tmpDir, 'mix_track2.wav');
    const mixedPath = path.join(tmpDir, 'mixed_output.wav');

    generateTestTone(track1, { durationSec: 2, frequency: 440 });
    generateTestTone(track2, { durationSec: 2, frequency: 880 });

    const result = child_process.spawnSync('ffmpeg', [
      '-i', track1,
      '-i', track2,
      '-filter_complex', '[0:a][1:a]amix=inputs=2:duration=shortest[out]',
      '-map', '[out]',
      '-y', mixedPath,
    ], { encoding: 'utf-8', timeout: 15000 });

    expect(result.status).toBe(0);
    assertFileExists(mixedPath, 100);

    const content = audioHasContent(mixedPath);
    expect(content.isSilent).toBe(false);
  });

  it('adelay filter delays audio correctly', () => {
    const srcPath = path.join(tmpDir, 'delay_src.wav');
    const delayedPath = path.join(tmpDir, 'delayed_output.wav');

    generateTestTone(srcPath, { durationSec: 1, frequency: 440 });

    // Delay 2 seconds
    const result = child_process.spawnSync('ffmpeg', [
      '-i', srcPath,
      '-af', 'adelay=2000|2000',
      '-y', delayedPath,
    ], { encoding: 'utf-8', timeout: 15000 });

    expect(result.status).toBe(0);
    assertFileExists(delayedPath, 100);

    // Delayed file should be longer (original 1s + 2s delay = ~3s)
    const probe = ffprobe(delayedPath);
    const duration = parseFloat(probe.format.duration);
    expect(duration).toBeGreaterThan(2.5);
  });
});

describe('Video manipulation with FFmpeg', () => {
  it('crop filter produces valid video', () => {
    const srcPath = path.join(tmpDir, 'crop_src.mp4');
    const croppedPath = path.join(tmpDir, 'crop_out.mp4');

    generateTestVideo(srcPath, { durationSec: 2, width: 1920, height: 1080, fps: 30 });

    // Crop to center 960x540 and scale back to 1920x1080
    const result = child_process.spawnSync('ffmpeg', [
      '-i', srcPath,
      '-vf', 'crop=960:540:480:270,scale=1920:1080:flags=lanczos',
      '-c:v', 'libx264',
      '-preset', 'ultrafast',
      '-pix_fmt', 'yuv420p',
      '-y', croppedPath,
    ], { encoding: 'utf-8', timeout: 30000 });

    expect(result.status).toBe(0);
    assertFileExists(croppedPath, 1000);

    const probe = ffprobe(croppedPath);
    const videoStream = probe.streams.find((s) => s.codec_type === 'video');
    expect(videoStream!.width).toBe(1920);
    expect(videoStream!.height).toBe(1080);
  });

  it('animated crop with expression-based filter works', () => {
    const srcPath = path.join(tmpDir, 'anim_crop_src.mp4');
    const animPath = path.join(tmpDir, 'anim_crop_out.mp4');

    generateTestVideo(srcPath, { durationSec: 3, width: 1920, height: 1080, fps: 30 });

    // Use an expression-based crop (like what ZoomEngine generates)
    // Crop width oscillates between 1920 and 1200 over time
    const cropWExpr = "if(lt(n\\,45)\\,1920+(1200-1920)*(3*pow(min(1\\,max(0\\,(n-0)/45))\\,2)-2*pow(min(1\\,max(0\\,(n-0)/45))\\,3))\\,1200)";
    const cropHExpr = "if(lt(n\\,45)\\,1080+(675-1080)*(3*pow(min(1\\,max(0\\,(n-0)/45))\\,2)-2*pow(min(1\\,max(0\\,(n-0)/45))\\,3))\\,675)";

    const result = child_process.spawnSync('ffmpeg', [
      '-i', srcPath,
      '-vf', `crop='${cropWExpr}:${cropHExpr}:0:0',scale=1920:1080:flags=lanczos`,
      '-c:v', 'libx264',
      '-preset', 'ultrafast',
      '-pix_fmt', 'yuv420p',
      '-y', animPath,
    ], { encoding: 'utf-8', timeout: 30000 });

    expect(result.status).toBe(0);
    assertFileExists(animPath, 1000);

    const probe = ffprobe(animPath);
    const videoStream = probe.streams.find((s) => s.codec_type === 'video');
    expect(videoStream!.width).toBe(1920);
    expect(videoStream!.height).toBe(1080);
  });

  it('video concatenation via concat demuxer works', () => {
    const clip1 = path.join(tmpDir, 'concat1.mp4');
    const clip2 = path.join(tmpDir, 'concat2.mp4');
    const concatOutput = path.join(tmpDir, 'concat_result.mp4');
    const concatList = path.join(tmpDir, 'concat_list.txt');

    generateTestVideo(clip1, { durationSec: 2, width: 640, height: 480 });
    generateTestVideo(clip2, { durationSec: 2, width: 640, height: 480 });

    fs.writeFileSync(concatList, [
      `file '${clip1}'`,
      `file '${clip2}'`,
    ].join('\n'));

    const result = child_process.spawnSync('ffmpeg', [
      '-f', 'concat',
      '-safe', '0',
      '-i', concatList,
      '-c', 'copy',
      '-y', concatOutput,
    ], { encoding: 'utf-8', timeout: 30000 });

    expect(result.status).toBe(0);
    assertFileExists(concatOutput, 1000);

    const probe = ffprobe(concatOutput);
    const duration = parseFloat(probe.format.duration);
    // Should be roughly 4 seconds (2+2)
    expect(duration).toBeGreaterThan(3);
    expect(duration).toBeLessThan(5);
  });

  it('muxing video and audio together works', () => {
    const videoPath = path.join(tmpDir, 'mux_video.mp4');
    const audioPath = path.join(tmpDir, 'mux_audio.wav');
    const muxedPath = path.join(tmpDir, 'mux_output.mp4');

    generateTestVideo(videoPath, { durationSec: 3 });
    generateTestTone(audioPath, { durationSec: 3 });

    const result = child_process.spawnSync('ffmpeg', [
      '-i', videoPath,
      '-i', audioPath,
      '-c:v', 'copy',
      '-c:a', 'aac',
      '-b:a', '192k',
      '-shortest',
      '-map', '0:v:0',
      '-map', '1:a:0',
      '-y', muxedPath,
    ], { encoding: 'utf-8', timeout: 30000 });

    expect(result.status).toBe(0);
    assertFileExists(muxedPath, 1000);

    const probe = ffprobe(muxedPath);
    const videoStream = probe.streams.find((s) => s.codec_type === 'video');
    const audioStream = probe.streams.find((s) => s.codec_type === 'audio');
    expect(videoStream).toBeDefined();
    expect(audioStream).toBeDefined();
    expect(audioStream!.codec_name).toBe('aac');
  });
});

describe('ZoomEngine filter chain with real FFmpeg', () => {
  it('ZoomEngine-generated filter produces valid output video', async () => {
    // Dynamic import for TypeScript modules under Vitest
    const { ZoomEngine, ZoomPresets } = await import('../../src/camera/zoom-engine');
    const { createLogger } = await import('../../src/utils/logger');
    const zoomLogger = createLogger('ZoomTest');
    zoomLogger.silent = true;

    const engine = new ZoomEngine(
      { enabled: true, maxZoom: 1.4, transitionMs: 800, easing: 'ease-in-out' as const },
      zoomLogger
    );

    const keyframes = [
      ZoomPresets.searchBarFocus(0),
      ZoomPresets.fullWindow(1),
      ZoomPresets.searchResultsFocus(2),
      ZoomPresets.fullWindow(3),
    ];

    const filter = engine.buildFilterChain(keyframes, 4, 1920, 1080, 30);
    expect(filter).not.toBeNull();

    // Now apply this filter with real FFmpeg
    const srcPath = path.join(tmpDir, 'zoom_src.mp4');
    const zoomedPath = path.join(tmpDir, 'zoom_out.mp4');

    generateTestVideo(srcPath, { durationSec: 4, width: 1920, height: 1080, fps: 30 });

    const result = child_process.spawnSync('ffmpeg', [
      '-i', srcPath,
      '-vf', filter!,
      '-c:v', 'libx264',
      '-preset', 'ultrafast',
      '-pix_fmt', 'yuv420p',
      '-y', zoomedPath,
    ], { encoding: 'utf-8', timeout: 60000 });

    expect(result.status).toBe(0);
    assertFileExists(zoomedPath, 1000);

    const probe = ffprobe(zoomedPath);
    const videoStream = probe.streams.find((s) => s.codec_type === 'video');
    expect(videoStream!.width).toBe(1920);
    expect(videoStream!.height).toBe(1080);
  });
});

describe('SFX track building with real files', () => {
  it('builds a multi-event SFX track that has audible content', () => {
    // Create two "click" sounds at different offsets
    const click1 = path.join(tmpDir, 'sfx_click1.wav');
    const click2 = path.join(tmpDir, 'sfx_click2.wav');
    const sfxTrack = path.join(tmpDir, 'sfx_track.wav');

    generateTestTone(click1, { durationSec: 0.3, frequency: 1000 });
    generateTestTone(click2, { durationSec: 0.3, frequency: 2000 });

    // Simulate what the video assembler does: adelay + amix
    const result = child_process.spawnSync('ffmpeg', [
      '-i', click1,
      '-i', click2,
      '-filter_complex',
      '[0:a]adelay=0|0,volume=0.4[sfx0];[1:a]adelay=2000|2000,volume=0.4[sfx1];[sfx0][sfx1]amix=inputs=2:duration=longest[out]',
      '-map', '[out]',
      '-c:a', 'pcm_s16le',
      '-y', sfxTrack,
    ], { encoding: 'utf-8', timeout: 15000 });

    expect(result.status).toBe(0);
    assertFileExists(sfxTrack, 100);

    const content = audioHasContent(sfxTrack);
    expect(content.isSilent).toBe(false);

    // Track should be at least 2 seconds (click2 starts at 2s + 0.3s duration)
    const probe = ffprobe(sfxTrack);
    const duration = parseFloat(probe.format.duration);
    expect(duration).toBeGreaterThan(2);
  });
});

describe('End-to-end assembly simulation', () => {
  it('produces a complete video with audio and video streams', () => {
    // Simulate the full video assembler pipeline:
    // 1. Generate source video clips (like screen recordings)
    // 2. Apply zoom crop filter
    // 3. Concatenate
    // 4. Generate voiceover audio
    // 5. Generate SFX track
    // 6. Mux everything together

    const e2eDir = path.join(tmpDir, 'e2e');
    fs.mkdirSync(e2eDir, { recursive: true });

    // Step 1: Generate two "screen recording" clips
    const clip1 = path.join(e2eDir, 'clip1.mp4');
    const clip2 = path.join(e2eDir, 'clip2.mp4');
    generateTestVideo(clip1, { durationSec: 3, width: 1920, height: 1080, fps: 30 });
    generateTestVideo(clip2, { durationSec: 3, width: 1920, height: 1080, fps: 30 });

    // Step 2: Apply a simple zoom crop to clip1
    const processed1 = path.join(e2eDir, 'proc1.mp4');
    let result = child_process.spawnSync('ffmpeg', [
      '-i', clip1,
      '-vf', 'crop=1200:675:360:203,scale=1920:1080:flags=lanczos',
      '-c:v', 'libx264',
      '-preset', 'ultrafast',
      '-pix_fmt', 'yuv420p',
      '-an',
      '-y', processed1,
    ], { encoding: 'utf-8', timeout: 30000 });
    expect(result.status).toBe(0);

    // Clip2 passes through without zoom
    const processed2 = path.join(e2eDir, 'proc2.mp4');
    result = child_process.spawnSync('ffmpeg', [
      '-i', clip2,
      '-c:v', 'libx264',
      '-preset', 'ultrafast',
      '-pix_fmt', 'yuv420p',
      '-an',
      '-y', processed2,
    ], { encoding: 'utf-8', timeout: 30000 });
    expect(result.status).toBe(0);

    // Step 3: Concatenate
    const concatList = path.join(e2eDir, 'concat.txt');
    fs.writeFileSync(concatList, [
      `file '${processed1}'`,
      `file '${processed2}'`,
    ].join('\n'));

    const concatVideo = path.join(e2eDir, 'concat.mp4');
    result = child_process.spawnSync('ffmpeg', [
      '-f', 'concat',
      '-safe', '0',
      '-i', concatList,
      '-c', 'copy',
      '-y', concatVideo,
    ], { encoding: 'utf-8', timeout: 30000 });
    expect(result.status).toBe(0);

    // Step 4: Generate voiceover audio
    const voiceover = path.join(e2eDir, 'voiceover.wav');
    generateTestTone(voiceover, { durationSec: 6, frequency: 300 });

    // Step 5: Generate SFX track (click at 1s, typing sound at 3s)
    const clickSfx = path.join(e2eDir, 'click.wav');
    const typingSfx = path.join(e2eDir, 'typing.wav');
    generateTestTone(clickSfx, { durationSec: 0.2, frequency: 1500 });
    generateTestTone(typingSfx, { durationSec: 1, frequency: 800 });

    const sfxTrack = path.join(e2eDir, 'sfx.wav');
    result = child_process.spawnSync('ffmpeg', [
      '-i', clickSfx,
      '-i', typingSfx,
      '-filter_complex',
      '[0:a]adelay=1000|1000,volume=0.3[sfx0];[1:a]adelay=3000|3000,volume=0.3[sfx1];[sfx0][sfx1]amix=inputs=2:duration=longest[out]',
      '-map', '[out]',
      '-c:a', 'pcm_s16le',
      '-y', sfxTrack,
    ], { encoding: 'utf-8', timeout: 15000 });
    expect(result.status).toBe(0);

    // Step 6: Final mux — video + voiceover + SFX
    const finalOutput = path.join(e2eDir, 'final_output.mp4');
    result = child_process.spawnSync('ffmpeg', [
      '-i', concatVideo,
      '-i', voiceover,
      '-i', sfxTrack,
      '-filter_complex', '[1:a][2:a]amix=inputs=2:duration=shortest:dropout_transition=2[aout]',
      '-map', '0:v:0',
      '-map', '[aout]',
      '-c:v', 'copy',
      '-c:a', 'aac',
      '-b:a', '192k',
      '-shortest',
      '-y', finalOutput,
    ], { encoding: 'utf-8', timeout: 60000 });

    expect(result.status).toBe(0);
    assertFileExists(finalOutput, 5000);

    // Validate the final output
    const probe = ffprobe(finalOutput);

    const videoStream = probe.streams.find((s) => s.codec_type === 'video');
    expect(videoStream).toBeDefined();
    expect(videoStream!.width).toBe(1920);
    expect(videoStream!.height).toBe(1080);
    expect(videoStream!.codec_name).toBe('h264');

    const audioStream = probe.streams.find((s) => s.codec_type === 'audio');
    expect(audioStream).toBeDefined();
    expect(audioStream!.codec_name).toBe('aac');

    // Duration should be roughly 4-6 seconds (may be shorter due to -shortest)
    const duration = parseFloat(probe.format.duration);
    expect(duration).toBeGreaterThanOrEqual(3);
    expect(duration).toBeLessThan(8);

    // Audio should not be silent
    const content = audioHasContent(finalOutput);
    expect(content.isSilent).toBe(false);
  });
});

describe('Clip duration and audio requirements', () => {
  it('assembled clip from screen recording frames is longer than 1 second', () => {
    // Simulate a screen recording that captures 3 seconds of frames at 30fps
    const clipDir = path.join(tmpDir, 'clip_duration_test');
    fs.mkdirSync(clipDir, { recursive: true });

    // Generate enough frames for a 3-second clip (90 frames at 30fps)
    const frameCount = 90;
    for (let i = 0; i < frameCount; i++) {
      // Create minimal valid PNG frames using FFmpeg (1 frame each)
      const framePath = path.join(clipDir, `frame_${String(i).padStart(6, '0')}.png`);
      const result = child_process.spawnSync('ffmpeg', [
        '-f', 'lavfi',
        '-i', `color=c=blue:s=320x240:d=0.033`,
        '-frames:v', '1',
        '-y', framePath,
      ], { encoding: 'utf-8', timeout: 5000 });
      expect(result.status).toBe(0);
    }

    // Assemble frames into video (like ScreenRecorder.assembleFrames does)
    const outputPath = path.join(tmpDir, 'clip_duration_output.mp4');
    const result = child_process.spawnSync('ffmpeg', [
      '-framerate', '30',
      '-i', path.join(clipDir, 'frame_%06d.png'),
      '-c:v', 'libx264',
      '-pix_fmt', 'yuv420p',
      '-r', '30',
      '-preset', 'ultrafast',
      '-y', outputPath,
    ], { encoding: 'utf-8', timeout: 30000 });

    expect(result.status).toBe(0);
    assertFileExists(outputPath, 1000);

    // CRITICAL ASSERTION: clip must be longer than 1 second
    const probe = ffprobe(outputPath);
    const duration = parseFloat(probe.format.duration);
    expect(duration).toBeGreaterThan(1);
  });

  it('clip with SFX audio has an audio stream that is not silent', () => {
    // Generate a video clip (simulating a screen recording)
    const videoPath = path.join(tmpDir, 'audio_check_video.mp4');
    generateTestVideo(videoPath, { durationSec: 4, width: 640, height: 480 });

    // Generate typing SFX audio (simulating what buildSfxTrack produces)
    const typingSfx = path.join(tmpDir, 'audio_check_typing.wav');
    generateTestTone(typingSfx, { durationSec: 2, frequency: 800 });

    // Build an SFX track with the typing audio at 0.5s offset
    const sfxTrack = path.join(tmpDir, 'audio_check_sfx.wav');
    let result = child_process.spawnSync('ffmpeg', [
      '-i', typingSfx,
      '-af', 'adelay=500|500,volume=0.5',
      '-c:a', 'pcm_s16le',
      '-y', sfxTrack,
    ], { encoding: 'utf-8', timeout: 15000 });
    expect(result.status).toBe(0);

    // Mux video + SFX audio together (like VideoAssembler does)
    const muxedPath = path.join(tmpDir, 'audio_check_output.mp4');
    result = child_process.spawnSync('ffmpeg', [
      '-i', videoPath,
      '-i', sfxTrack,
      '-c:v', 'copy',
      '-c:a', 'aac',
      '-b:a', '192k',
      '-shortest',
      '-map', '0:v:0',
      '-map', '1:a:0',
      '-y', muxedPath,
    ], { encoding: 'utf-8', timeout: 30000 });

    expect(result.status).toBe(0);
    assertFileExists(muxedPath, 1000);

    // CRITICAL ASSERTION: the output must have an audio stream
    const probe = ffprobe(muxedPath);
    const audioStream = probe.streams.find((s) => s.codec_type === 'audio');
    expect(audioStream).toBeDefined();

    // CRITICAL ASSERTION: the audio must not be silent
    const content = audioHasContent(muxedPath);
    expect(content.isSilent).toBe(false);
    expect(content.peakDb).toBeGreaterThan(-30);
  });

  it('video-only clip (no SFX) has no audio stream', () => {
    // Generate a video-only clip (like screen recorder produces before assembly)
    const videoPath = path.join(tmpDir, 'no_audio_video.mp4');
    generateTestVideo(videoPath, { durationSec: 2, width: 640, height: 480 });

    const probe = ffprobe(videoPath);
    const audioStream = probe.streams.find((s) => s.codec_type === 'audio');
    // Video-only clips from screen recording should NOT have audio
    expect(audioStream).toBeUndefined();

    // Verify it's a valid video
    const videoStream = probe.streams.find((s) => s.codec_type === 'video');
    expect(videoStream).toBeDefined();
    const duration = parseFloat(probe.format.duration);
    expect(duration).toBeGreaterThan(1);
  });
});

describe('Real SFX library validation', () => {
  const sfxLibraryPath = path.join(
    __dirname, '..', '..', 'sfx-library', 'typing'
  );

  // Only run if sfx-library exists (won't exist in CI)
  const hasSfxLibrary = fs.existsSync(sfxLibraryPath);

  it.skipIf(!hasSfxLibrary)('all WAV clips in sfx-library are non-empty and non-silent', () => {
    const wavFiles = fs.readdirSync(sfxLibraryPath).filter((f) => f.endsWith('.wav'));
    expect(wavFiles.length).toBeGreaterThan(0);

    for (const wav of wavFiles) {
      const fullPath = path.join(sfxLibraryPath, wav);
      assertFileExists(fullPath, 100);

      const probe = ffprobe(fullPath);
      const audioStream = probe.streams.find((s) => s.codec_type === 'audio');
      expect(audioStream).toBeDefined();

      const content = audioHasContent(fullPath);
      expect(content.isSilent).toBe(false);
    }
  });

  it.skipIf(!hasSfxLibrary)('all JSON sidecars reference existing audio files', () => {
    const jsonFiles = fs.readdirSync(sfxLibraryPath).filter((f) => f.endsWith('.json'));
    expect(jsonFiles.length).toBeGreaterThan(0);

    for (const jsonFile of jsonFiles) {
      const meta = JSON.parse(
        fs.readFileSync(path.join(sfxLibraryPath, jsonFile), 'utf-8')
      );
      expect(meta.audioFile).toBeDefined();
      expect(meta.typedText).toBeDefined();
      expect(meta.wordCount).toBeGreaterThanOrEqual(0);
      expect(meta.durationMs).toBeGreaterThan(0);

      // Audio file should exist
      const audioPath = path.resolve(sfxLibraryPath, meta.audioFile);
      expect(fs.existsSync(audioPath)).toBe(true);
    }
  });

  it.skipIf(!hasSfxLibrary)('JSON keystroke data has valid timestamps', () => {
    const jsonFiles = fs.readdirSync(sfxLibraryPath).filter((f) => f.endsWith('.json'));

    for (const jsonFile of jsonFiles) {
      const meta = JSON.parse(
        fs.readFileSync(path.join(sfxLibraryPath, jsonFile), 'utf-8')
      );
      if (meta.keystrokes && meta.keystrokes.length > 0) {
        // Timestamps should be non-negative and monotonically non-decreasing
        let prevTs = -1;
        for (const ks of meta.keystrokes) {
          expect(ks.timestampMs).toBeGreaterThanOrEqual(0);
          expect(ks.timestampMs).toBeGreaterThanOrEqual(prevTs);
          prevTs = ks.timestampMs;
        }
      }
    }
  });
});
