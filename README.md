# auto-broll

Automated B-roll screen recording generator from voiceover transcripts. Analyzes a transcript with an LLM, runs browser actions (web search, news, definitions, image search) per topic, records the screen, and assembles a final video with your voiceover.

## Requirements

- **Node.js** 18+
- **Chrome or Chromium** (for Puppeteer)
- **FFmpeg** (for video assembly and optional typing SFX)
- **API keys**: Deepseek (or OpenAI) for transcript analysis; OpenAI for optional transcription from audio

## Install

```bash
npm install
npm run build
```

## Environment

Create a `.env` file in the project root (do not commit it). API keys are read from here so you can leave them out of config files.

```env
DEEPSEEK_API_KEY=your-deepseek-key
OPENAI_API_KEY=your-openai-key
```

Optional:

- `CHROME_PATH` – Path to Chrome/Chromium if not using the default in config (e.g. Windows: `C:\Program Files\Google\Chrome\Application\chrome.exe`).
- `DEBUG=1` – Enable debug logging for any command.

## Config

Generate a starter config:

```bash
node dist/cli.js init -o broll-config.json
```

Edit the JSON: set `transcriptPath`, `audioPath`, `outputDir`, and optionally `browserExecutablePath`. LLM keys come from `.env`; you can omit `llm.apiKey` in the config.

Main fields:

- **transcriptPath** – SRT, VTT, or timestamped text.
- **audioPath** – Voiceover audio (MP3, etc.) for the final video.
- **outputDir** – Where clips and the final video go.
- **llm.provider** – `deepseek` or `openai` (uses `DEEPSEEK_API_KEY` or `OPENAI_API_KEY`).
- **modules** – Enable/disable `web-search`, `news-search`, `definition-search`, `image-search`.

Paths in config are relative to the config file’s directory.

---

## Commands

### Transcribe audio → SRT

Turn an audio file into a timestamped transcript (OpenAI Whisper). Requires `OPENAI_API_KEY` in `.env`.

```bash
node dist/cli.js transcribe -i "audio.mp3" -o transcript.srt
```

- **Pickup**: If the output SRT already exists and is **newer than the input audio**, transcription is skipped.
- **`--force`**: Always overwrite and re-transcribe.

```bash
node dist/cli.js transcribe -i "audio.mp3" -o transcript.srt --force
```

---

### Full pipeline: run

Parse transcript → extract topics (LLM) → record one clip per topic/action → assemble final video.

```bash
node dist/cli.js run -c config.json
```

Options:

- **`--debug`** – Extra logging (cache, pickup, etc.).
- **`--no-cache-topics`** – Force re-analyze transcript; ignore cached topics.

**Pickup behavior:**

- **Topics**: Cached in `<outputDir>/topics-cache.json`. If the transcript path and mtime match, the cache is used and the LLM is not called.
- **Clips**: Clips are named `TopicSlug_actionType.mp4`. If a clip already exists and has size &gt; 0, that recording is skipped and the existing file is used.

So you can fix something and re-run; only missing steps run again.

---

### Single concept + module: run-one

Run **one** topic and **one** module (e.g. one definition-search clip). No assembly. **Debug is on by default.** Useful for iterating on a single clip.

List topics and their indices:

```bash
node dist/cli.js run-one -c config.json --list-topics
```

Run by topic index:

```bash
node dist/cli.js run-one -c config.json --topic-index 0 --action definition-search
```

Run by topic name (partial match):

```bash
node dist/cli.js run-one -c config.json --topic "AI Chatbot" --action web-search
```

Actions: `web-search`, `news-search`, `definition-search`, `image-search`.

Options:

- **`--no-cache-topics`** – Re-analyze transcript.
- **`--no-debug`** – Turn off debug logging.

If the clip for that topic+action already exists in `<outputDir>/clips/`, it is reused and you see “Skipped (existing)”.

---

### Analyze (topics only, no recording)

Show extracted topics and suggested actions without launching the browser:

```bash
node dist/cli.js analyze -c config.json
```

---

### Typing SFX library (optional)

To use typing sounds in the pipeline, you need a library of typed clips:

- **Record typing + keystrokes**: `record-typing` (interactive).
- **Re-slice sessions into clips**: `extract-typing [sessionNumber]`.
- **Check coverage**: `coverage [--script transcript.txt]`.

See `node dist/cli.js record-typing --help` (and same for `extract-typing`, `coverage`) for options.

---

### Mouse SFX library (optional)

Record click + scroll sounds in one free-form session, then auto-sort clips:

```bash
node dist/cli.js record-mouse -c config.json
```

Output folders are auto-created:

- `.../clicks/left`, `.../clicks/right`, `.../clicks/double`
- `.../scrolls/down-short`, `.../scrolls/down-long`, `.../scrolls/up-short`, `.../scrolls/up-long`

Use `--duration-sec` to auto-stop and `--min-scroll-delta` / `--short-scroll-threshold` to tune scroll bucketing.

Check bucket coverage (and missing categories):

```bash
node dist/cli.js mouse-coverage -c config.json
```

---

## Output layout

For a run with `outputDir: "./output-car-wash"`:

- **`output-car-wash/topics-cache.json`** – Cached topics (transcript path + mtime + topics). Used on next run if transcript unchanged.
- **`output-car-wash/clips/`** – One MP4 per (topic, action), e.g. `AI_Chatbot_Hallucination___Context_Drop_definition-search.mp4`.
- **`output-car-wash/processed/`** – Processed segments used during assembly.
- **`output-car-wash/*.mp4`** – Final assembled video (name may vary by assembler).

---

## Quick start example

1. Add `.env` with `DEEPSEEK_API_KEY` and (for transcribe) `OPENAI_API_KEY`.
2. Transcribe an audio file (or use an existing SRT):

   ```bash
   node dist/cli.js transcribe -i "voiceover.mp3" -o transcript.srt
   ```

3. Create and edit config (e.g. `config.json`) with `transcriptPath`, `audioPath`, `outputDir`, and Chrome path if needed.
4. Run the pipeline:

   ```bash
   node dist/cli.js run -c config.json --debug
   ```

5. To re-run only missing work, run the same command again; cached topics and existing clips are reused.
6. To re-record a single clip:

   ```bash
   node dist/cli.js run-one -c config.json --list-topics
   node dist/cli.js run-one -c config.json --topic-index 0 --action definition-search
   ```

---

## Scripts

| Script              | Purpose                    |
|---------------------|----------------------------|
| `npm run build`     | Compile TypeScript         |
| `npm test`          | Run tests                  |
| `npm run dev`       | Run CLI via ts-node        |
| `npm run debug-audio` | Debug audio devices     |

---

## License

MIT (or your chosen license).
