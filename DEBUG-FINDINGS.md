# Debug Findings & Fix Plan

Result of running the full pipeline end-to-end (`run` command, web-search module,
SFX + camera + cursor enabled) and inspecting every intermediate artifact
(recorded clip, clip-timing JSON, SFX track, final mux, extracted frames).

**TL;DR:** recording, typing SFX, zoom, and cursor injection all basically work.
The product breaks in the **assembly stage**: the final video is truncated to the
sum of the topic windows and never aligned to the voiceover timeline, so a 6:41
voiceover produced a **7.9-second output video**. Several smaller bugs make the
clips themselves look/sound wrong (missing space in the typed query, cursor stuck
in the top-left corner after search submit, voiceover attenuated to ~1/3 volume).

---

## Repro setup

- Ran with a pre-seeded `topics-cache.json` (1 topic, window 0–8 s,
  `web-search`) to bypass the LLM, against a local mock search page
  (external browsing is blocked in this sandbox; three env-gated debug
  switches were added to make this possible — see "Debug affordances" below).
- Voiceover: `drive or walk to car wash.mp3` (401.2 s).
- Recorded clip: 25.6 s of video (module real time 26.7 s), typing SFX baked, zoom applied.
- **Final output: 7.96 s.**

---

## Findings (ranked by severity)

### 1. Assembly timeline model is broken — output truncated & never aligned (critical)

`VideoAssembler.assemble()`:

- Each clip is trimmed/padded to `endTime - startTime` of its topic
  (`processClips`, src/modules/video-assembler/index.ts:211), then all clips are
  **concatenated back-to-back**. A clip's `startTime` is never used to *place* it
  on the timeline — only to sort.
- The final mux uses `amix=inputs=N:duration=shortest` **and** `-shortest`
  (index.ts:436-443, 456-464). The concatenated video is only as long as the summed
  topic windows, so the whole output — including the voiceover — is cut to that.

Consequences with real LLM output (topics are "main topics", not a tiling of the
transcript; a topic can also have *multiple* suggested actions, each recorded and
each occupying its window again):

- Output video length = Σ(topic windows × actions) ≠ voiceover length.
  Almost always much shorter → voiceover hard-cut mid-sentence (observed: 401 s → 8 s).
- Even when lengths accidentally match, clip N does not appear at its transcript
  time — B-roll never lines up with what the narration is saying.

**Fix plan (recommended: place-on-timeline model):**

1. In `assemble()`, probe the voiceover duration and make it the master timeline length.
2. Deduplicate: keep one recorded action per topic window on the timeline (or split
   the window across the topic's actions) so windows are never double-covered.
3. Place each processed clip at its `startTime`. Fill gaps deterministically:
   extend the previous clip's last frame (`tpad=stop_mode=clone`) to the next clip's
   start, or hold the *next* clip's first frame for a leading gap. Trim overlaps
   (earlier `startTime` wins; truncate the loser).
4. Concatenate the gap-filled sequence — it now spans exactly [0, voiceoverDuration].
5. Mux with the full voiceover; remove `-shortest`, use `amix=...:duration=first`
   with the video/concat audio as first input (or explicit `-t <voiceover duration>`).
6. Integration test: fabricate 2 segments with windows [2–5] and [10–12] + a 15 s
   tone as voiceover; assert output duration ≈ 15 s and non-black frames at 3 s and 11 s.

### 2. Voiceover is attenuated ~2–3× by `amix` normalization (high)

`amix` scales every input by `1/n` by default. With video-audio + voiceover + SFX
track (3 inputs) the voiceover plays at ~1/3 volume (measured `max_volume -9.9 dB`
on the final output). This is almost certainly why `sfx.volume` had to be cranked
to `10.0` in `config-car-wash.json` — the whole mix is fighting amix normalization.

**Fix:** add `normalize=0` to every `amix` (bake + final mux, index.ts:98, 394, 436, 456)
and set explicit per-input `volume=` gains instead. Then reset `sfx.volume` in the
example config to a sane 0.5–1.0. Add an assertion to the existing integration test
that voiceover peak level in the output is within ~1 dB of the source.

### 3. Typing drops the space between SFX chunks — wrong query on screen (high)

`SfxManager.buildTypingTimelineWithKeystrokes()` (src/sfx/manager.ts:448) splits
the text into word chunks (`"car wash near"` + `"me"`), and `TypingAnimator.type()`
types the chunks back-to-back — the joining space is never typed.

Observed on screen: the query renders as **"car wash nearme"**. Search engines
receive the mangled query; on-screen text is visibly wrong in the b-roll.

**Fix:** in `TypingAnimator.type()`, press `Space` between consecutive chunks
(most clips already end with a `space` keystroke event — e.g. clip_0014 — so the
cadence data is there; alternatively append `' '` to `chunkText` for every chunk
except the last in `buildTypingTimelineWithKeystrokes`). Unit test: chunked typing
over a multi-clip chain reproduces the exact input text, spaces included.

### 4. Degenerate typing clips get selected for real words (medium)

`clip_0014.wav` is a 66 ms clip of the single keystroke `"k"` (`wordCount: 1`).
Word-count matching happily selected it to "type" the word `"me"`, so the tail of
the query is typed near-instantly with a barely-audible 66 ms sound.

**Fix:** when matching clips in `getTypingSfx`, score by character length as well
as word count, and skip clips with `durationMs` below ~300 ms or fewer than
~3 keystrokes for multi-character chunks. Unit test with a library containing a
degenerate clip.

### 5. Synthetic cursor resets to (0,0) after search submit (medium)

The last commit fixed cursor restoration for `BrowserEngine.navigate()`, but
`performSearch()` navigates via `keyboard.press('Enter')` +
`waitForNavigation` (src/browser/engine.ts:240-241) and never calls
`cursorRenderer.ensureOnPage()`. The `evaluateOnNewDocument` script recreates the
cursor at (0,0), so the dot sits half-offscreen in the top-left corner for the
whole results-browsing portion of every search clip (verified in extracted frames).

**Fix:** call `await this._cursorRenderer?.ensureOnPage(this.page)` after the
`waitForNavigation` in `performSearch()`. More robust: subscribe once to the page's
main-frame `framenavigated` event in `launch()` and re-ensure the cursor there, so
any future navigation path (link clicks, redirects) is covered too.

### 6. Recording can end shorter than the module's real duration → late SFX (medium)

The clip-timing JSON shows `videoDuration 25.63 s < realDurationSeconds 26.70 s`.
CDP screencast only delivers frames on repaint; the last frame's on-disk duration
is estimated from the previous frame gap, so idle time at the end of a module is
lost. All offset logic (`recordingOffset = max(0, video - real)`,
src/core/pipeline.ts:519, video-assembler index.ts:67) assumes video ≥ real and
clamps to 0, so when video is *shorter*, SFX/zoom events land progressively late.

**Fix:** in `ScreenRecorder.assembleFramesConcat()`, extend the final frame's
duration to `realDurationSeconds - lastTimestamp` (pass the real duration through —
it's already a parameter of `stopRecording`). That makes video duration ≙ wall
clock by construction and the existing offset math correct.

### 7. Minor issues (low)

- **Pickup overwrites timing JSON:** in `Pipeline.run()`, re-used clips call
  `writeClipTimingJson(..., [], [])`, clobbering the timing data from the original
  recording. Skip the write when the JSON already exists.
- **Global SFX timeline ignores trimming:** `buildGlobalSfxTimeline()` doesn't drop
  events past the trimmed window of a non-baked segment, so late events bleed into
  the next segment's window. Filter `event.timeOffset <= endTime - startTime`.
- **Hard-throwing audio verifications:** the "clip too quiet" checks in
  `Pipeline.run()`/`runOne()` throw and kill a whole multi-clip run at the last
  step. Consider logging + skipping the clip (or a `strict` config flag).
- **`sfx-library/clicks` doesn't exist** in the repo, so `mouseClick.enabled: true`
  silently produces zero click sounds. Either ship a couple of click samples or log
  a clearer warning at startup.

---

## Debug affordances added (env-gated, no effect unless set)

Needed to reproduce inside a sandboxed/headless environment; harmless in normal use:

| Env var | Effect |
|---|---|
| `BROLL_NO_SANDBOX=1` | adds `--no-sandbox --disable-setuid-sandbox` to Chromium launch (containers running as root) |
| `BROLL_PROXY=<url>` | adds `--proxy-server=<url> --ignore-certificate-errors` (egress-proxied environments) |
| `BROLL_SEARCH_URL_OVERRIDE=<url>` | routes `getSearchUrl()` to a custom/mock search page (`<url>?q=...`) |

## Suggested fix order

1. Assembly timeline + `-shortest`/`duration=shortest` removal (makes output usable at all)
2. `amix normalize=0` + volume model (makes it audible), reset example config volume
3. Chunk-boundary space + degenerate-clip filter (makes typing correct)
4. Cursor `ensureOnPage` after Enter navigation
5. Recorder last-frame extension (SFX sync at clip tails)
6. Minor items

---

# Round 2 — end-to-end in a real browser

The fixes above were verified against a single mock page. Round 2 ran the real
pipeline in headed Chromium (under Xvfb) against a Google-like stand-in with
home, results, news, images and definition pages (`scripts/e2e/`), with the
car-wash config and voiceover, and inspected the output frames and audio.
Several problems only show up that way.

## Findings and fixes

1. **The first clip aborted the run: SFX inaudible (critical).** The bundled
   typing samples peak at -36 to -58 dBFS. `sfx.volume: 10.0` had been
   compensating; round 1 lowered it to 0.8, so every baked clip peaked around
   -48 dB and failed the pipeline's own "audio too quiet" check.
   *Fix:* the assembler peak-normalizes each sample to -12 dBFS before
   applying `sfx.volume` (capped at -1 dBFS), so the setting means what its
   doc says regardless of how a sample was recorded.

2. **Camera zoom never moved (critical).** FFmpeg's `crop` evaluates its
   width/height once at setup, so the animated crop rendered every frame at
   full frame (verified: a 100px bar measured 100px at "1.4x"). The interval
   model also drifted across whole keyframe gaps, ignored `transitionMs`, and
   could squash non-16:9 regions.
   *Fix:* per-frame `perspective` filter (sub-pixel smooth); each keyframe
   starts a `transitionMs` move, then holds; aspect-preserving crop windows;
   the search box is framed from its real bounding box.

3. **Recordings cut off at 940px, mixed resolutions (high).** A 1920x1080
   headed window shows only 1920x940 of page, and the screencast captures only
   what is shown, so the bottom 140px never made it into clips; clips came
   out 1918x940 or 1920x1080 within one run and the final concat glued
   different sizes together.
   *Fix:* grow the window so the page area equals the viewport (fullscreen
   fallback, warning if neither fits); scale/pad every clip to
   `video.resolution`.

4. **Search engines' bot checks were recorded as blank video (high).** From a
   datacenter IP, Google's results page freezes the renderer (every CDP call
   then hangs for the 180s default) and Bing shows "One last step".
   *Fix:* detect frozen/blank/challenge pages after loading and after submitting
   a search and stop with a `BotChallengeError`; protocol timeout 60s.

5. **Clips opened on the previous clip's last page, cursor at (0,0) (medium).**
   *Fix:* `prepareForClip()` loads the search home page and parks the cursor
   before recording starts.

6. **Multiple actions per topic were thrown away (medium).** Round 1 placed
   the first clip of a window and dropped the rest; a proportional split
   instead gave short clips ~5s — not enough to get past typing.
   *Fix:* each topic gets its window plus the gap after it; its clips play in
   sequence, as many as can each get 12s, shared max-min fairly.

7. **SFX/zoom offset was guessed (medium).** `max(0, videoDuration -
   moduleDuration)` lost the real offset once round 1 made the video length
   equal the module length. *Fix:* frames carry the browser's swap time, the
   video spans exactly start→stop of recording, and the module's start offset
   is measured directly.

8. **Typing audio drift and trailing clacks (medium).** Per-key relative
   sleeps accumulated CDP latency; a sample with more keystrokes than the text
   kept clacking after typing stopped; chained chunks started their audio at
   the previous sample's end rather than when the chunk started.
   *Fix:* keys are scheduled on the sample's clock; each sample is cut 150ms
   after the last keystroke used and starts when its chunk starts. Measured
   visual-vs-audio offset over typed characters: median +8ms, within ±62ms.

9. **Smaller items.** `waitForNavigation` registered after the click (fast
   pages make it sit out its timeout); Playwright-only `:has-text()`
   selectors; hover zoom aimed at a link's corner; topic windows taken from
   the LLM's segment order; `buildSfxTrack` input indices misaligned when a
   sample was missing; PNG frames (~1.3MB each) replaced by JPEG q90 (~130KB,
   visually identical after H.264); picked-up clips lost their zoom.

## Not verifiable here

Live Google results pages: this environment's IP gets bot-checked, so the
Google-specific selectors (News/Images tabs, definition card, result titles)
were exercised only against the stand-in, which mirrors their DOM hooks.
