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
1. `ScreenRecorder` captures CDP screencast frames as PNGs
2. Frames assembled into video-only MP4 via FFmpeg
3. `VideoAssembler` processes clips (zoom filter, trim), concatenates, builds SFX track, muxes with voiceover

## Configuration

The `sfx.enabled` flag must be `true` for audio-driven typing. See `config-car-wash.json` for a complete example. Key sections:
- `sfx` — SFX library path, volume, click/typing sample directories
- `typing` — Base delay, inconsistency, mistake probability (fallback when no SFX)
- `camera` — Zoom intensity, transition duration, easing curve

## Testing Notes

- Unit tests for `typing-animator`, `extract-clips`, `transcript-parser`, `zoom-engine`, `coverage-analyzer` run without ffmpeg
- Unit tests for `sfx-manager` require ffmpeg (they generate test tones)
- Integration tests in `tests/integration/` all require ffmpeg
- The SessionStart hook installs ffmpeg automatically in remote environments
