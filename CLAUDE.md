# CLAUDE.md

## Project Overview

Automated B-roll screen recording generator. Analyzes a voiceover transcript with an LLM, performs browser actions (web search, news, definitions, image search) per extracted topic, records the screen via CDP, overlays SFX audio (typing sounds, clicks), applies dynamic camera zoom, and assembles a final video with FFmpeg.

## System Dependencies

- **Node.js** >= 18
- **FFmpeg** + **ffprobe** — required for video assembly, SFX track building, and all integration tests. Installed automatically via the SessionStart hook in remote environments.
- **Chrome/Chromium** — required at runtime for Puppeteer-based browser automation (not needed for tests)

## Quick Commands

```bash
npm install          # Install dependencies
npm test             # Run all tests (unit + integration)
npm run test:unit    # Run unit tests only
npm run test:integration  # Run integration tests (requires ffmpeg)
npm run build        # Compile TypeScript
npx tsc --noEmit     # Type-check without emitting
npm run e2e          # Real pipeline vs a local stand-in search engine (see Visual Verification)
```

## Project Structure

```
src/
  core/           # Pipeline orchestrator, types, module registry
  browser/        # BrowserEngine, TypingAnimator, MouseAnimator
  sfx/            # SfxManager — audio clip selection and timeline building
  camera/         # ZoomEngine — dynamic crop/pan filter generation
  modules/        # B-roll modules: web-search, news-search, definition-search, image-search
    screen-recorder/  # CDP-based frame capture + FFmpeg assembly
    video-assembler/  # Final concat, zoom, SFX mix, voiceover mux
  utils/          # Logger, timing, transcript parser, video helpers
scripts/e2e/      # mock-search-server.ts (Google-like stand-in) + run-e2e.ts (end-to-end run + contact sheet)
tests/
  unit/           # Pure logic tests (no ffmpeg needed for most)
  integration/    # FFmpeg output validation tests (require ffmpeg)
  helpers.ts      # Shared test utilities (ffprobe, generateTestTone, etc.)
  fixtures/       # Sample transcript files
sfx-library/      # Pre-recorded audio samples (typing clips with JSON sidecars, click sounds)
config-car-wash.json  # Example pipeline configuration
```

## Key Architecture

### Audio-Driven Typing Cadence
When SFX is enabled, the typing animator selects an audio clip **first**, then uses its real keystroke timestamps to pace the visual typing in the browser. This ensures what you see matches what you hear. Falls back to gaussian-delay timing when no audio clips are available.

### SFX Pipeline Flow
1. `SfxManager` loads typing clips (WAV + JSON sidecar with keystroke timestamps) and click samples
2. During browser actions, `TypingAnimator` calls `SfxManager.getTypingSfxWithKeystrokes()` to get both the audio event and keystroke timing
3. SFX events accumulate on `BrowserEngine._clipSfxEvents` during recording
4. `VideoAssembler` builds a global SFX track via FFmpeg `adelay`+`amix` and muxes it with the voiceover

### Recording Flow
1. `BrowserEngine.prepareForClip()` opens the search home page and parks the cursor (not recorded)
2. `ScreenRecorder` captures CDP screencast frames (JPEG) stamped with the browser's frame-swap time; video time 0 = `startRecording()`, the last frame holds until `stopRecording()`
3. The pipeline shifts module-relative SFX/zoom times by the measured `clipStartTime - recordingStartTime`, bakes SFX into the clip, and writes `<clip>.json` (timings + full zoom keyframes, reloaded when a clip is reused)
4. `VideoAssembler` places clips on the voiceover timeline (`placeSegmentsOnTimeline`), applies zoom, concatenates, builds the SFX track, muxes with the voiceover

### Camera
`ZoomEngine` emits a per-frame `perspective` filter (FFmpeg's `crop` evaluates w/h only once, so it cannot animate a zoom). Each keyframe starts a `transitionMs` move to its region, then the camera holds; crop windows keep the 16:9 aspect.

### Browser window
Headed Chrome loses ~140px to its UI, and the screencast only captures what the window shows, so `launch()` grows the window until the page area equals `viewport` (fullscreen as fallback). Clips are scaled/padded to `video.resolution` in the recorder and assembler so every clip has the same size.

## Configuration

The `sfx.enabled` flag must be `true` for audio-driven typing. See `config-car-wash.json` for a complete example. Key sections:
- `sfx` — SFX library path, volume, click/typing sample directories
- `typing` — Base delay, inconsistency, mistake probability (fallback when no SFX)
- `camera` — Zoom intensity, transition duration, easing curve

## Visual Verification

Unit tests can't tell whether the video looks or sounds right, so check changes by running the real pipeline and looking at the output. In the remote environment (Xvfb and Chromium are installed):

```bash
xvfb-run -a -s "-screen 0 1920x1080x24" npm run e2e -- --seconds 90 --out /tmp/e2e --fresh
```

This records real clips against `scripts/e2e/mock-search-server.ts` and writes `/tmp/e2e/contact-sheet.png` (12 frames) — read it with the Read tool, and pull more frames with `ffmpeg -ss <t> -i /tmp/e2e/output.mp4 -frames:v 1 frame.png`. Live Google/Bing answer cloud IPs with bot checks (the pipeline stops with `BotChallengeError`), which is why the stand-in exists. Result links in the stand-in point at Wikipedia/Merriam-Webster; the e2e script routes Chrome through `$HTTPS_PROXY` to reach them.

## Testing Notes

- Unit tests for `typing-animator`, `extract-clips`, `transcript-parser`, `zoom-engine`, `coverage-analyzer`, `timeline-placement` run without ffmpeg
- Unit tests for `sfx-manager` require ffmpeg (they generate test tones)
- Integration tests in `tests/integration/` all require ffmpeg
- The SessionStart hook installs ffmpeg automatically in remote environments
