/**
 * Debug script: reproduce exactly how the typing recorder starts ffmpeg and stops it,
 * to see why WAV files aren't being written.
 *
 * Run: npm run debug-typing-audio   or   npx ts-node scripts/debug-typing-recorder-audio.ts
 *
 * Tests:
 *   1. Same spawn as recorder (dshow, first device, 44100, mono, absolute path), record 2s, then send 'q' and wait for exit.
 *   2. Same spawn but with -t 2 so ffmpeg exits on its own (no 'q').
 *
 * Reports: file created?, size, duration, and full ffmpeg stderr.
 */

import * as child_process from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

function getDshowAudioDevices(): string[] {
  const names: string[] = [];
  try {
    const result = child_process.spawnSync('ffmpeg', [
      '-list_devices', 'true', '-f', 'dshow', '-i', 'dummy',
    ], { encoding: 'utf8', maxBuffer: 100 * 1024, windowsHide: true });
    const stderr = (result.stderr ?? result.stdout ?? '') as string;
    const regex = /"([^"]+)"\s*\(audio\)/g;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(stderr)) !== null) names.push(match[1]);
  } catch {
    /* ignore */
  }
  return names;
}

function probeWav(wavPath: string): { durationSec: number | null; err?: string } {
  const result = child_process.spawnSync('ffprobe', [
    '-v', 'error',
    '-show_entries', 'format=duration',
    '-of', 'default=noprint_wrappers=1:nokey=1',
    wavPath,
  ], { encoding: 'utf8', maxBuffer: 10000, windowsHide: true });
  if (result.status !== 0) {
    return { durationSec: null, err: (result.stderr ?? '').toString().trim().slice(0, 200) };
  }
  const d = parseFloat((result.stdout ?? '').trim());
  return { durationSec: Number.isFinite(d) ? d : null };
}

async function runTest(
  name: string,
  outPath: string,
  device: string,
  stopWithQ: boolean,
  recordSeconds: number
): Promise<void> {
  console.log(`\n--- ${name} ---`);
  const absolutePath = path.resolve(outPath);
  console.log('Output path:', absolutePath);
  console.log('Device:', device);
  console.log('Stop with "q" to stdin:', stopWithQ);
  if (fs.existsSync(absolutePath)) {
    try { fs.unlinkSync(absolutePath); } catch { /* ignore */ }
  }

  const args = [
    '-f', 'dshow',
    '-i', `audio=${device}`,
    '-ar', '44100',
    '-ac', '1',
    '-y',
    absolutePath,
  ];
  if (!stopWithQ) {
    args.splice(-2, 0, '-t', String(recordSeconds)); // -t N before -y path
  }

  const proc = child_process.spawn('ffmpeg', args, { stdio: 'pipe', windowsHide: true });
  const stderrChunks: Buffer[] = [];
  proc.stderr?.on('data', (ch: Buffer) => stderrChunks.push(ch));

  if (stopWithQ) {
    await new Promise<void>((resolve) => setTimeout(resolve, recordSeconds * 1000));
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        proc.kill('SIGKILL');
        resolve();
      }, 8000);
      proc.once('exit', () => {
        clearTimeout(timeout);
        resolve();
      });
      if (proc.stdin?.writable) {
        proc.stdin.write('q');
        proc.stdin.end();
      } else {
        proc.kill('SIGINT');
        setTimeout(resolve, 500);
      }
    });
  } else {
    await new Promise<void>((resolve) => {
      proc.once('exit', () => resolve());
    });
  }

  const stderr = Buffer.concat(stderrChunks).toString('utf8');
  const exists = fs.existsSync(absolutePath);
  let size = 0;
  if (exists) size = fs.statSync(absolutePath).size;
  const probe = exists ? probeWav(absolutePath) : { durationSec: null as number | null };

  console.log('File exists:', exists);
  console.log('File size:', size, 'bytes');
  console.log('Duration (ffprobe):', probe.durationSec != null ? probe.durationSec.toFixed(2) + 's' : probe.err ?? 'N/A');
  console.log('Exit code:', proc.exitCode ?? proc.signalCode ?? 'unknown');
  console.log('\nFFmpeg stderr (last 80 lines):');
  const lines = stderr.split(/\r?\n/).filter(Boolean);
  lines.slice(-80).forEach((l) => console.log('  ', l));
}

async function main() {
  console.log('=== Typing recorder audio debug ===');
  console.log('Platform:', process.platform);
  if (process.platform !== 'win32') {
    console.log('This script only tests the Windows dshow path.');
    process.exit(0);
  }

  const list = getDshowAudioDevices();
  const preferred = process.env.TYPING_AUDIO_DEVICE;
  const device = preferred && list.includes(preferred) ? preferred : list[0] ?? null;
  if (!device) {
    console.log('No DirectShow audio devices found. Run: ffmpeg -list_devices true -f dshow -i dummy');
    process.exit(1);
  }
  console.log('Available audio devices:', list.length);
  list.forEach((d, i) => console.log(`  ${i + 1}. ${d}`));
  if (preferred && !list.includes(preferred)) {
    console.log('Note: TYPING_AUDIO_DEVICE="' + preferred + '" not in list; using first device.');
  }
  console.log('Using device:', device);

  const outDir = path.join(process.cwd(), 'debug-audio-out');
  fs.mkdirSync(outDir, { recursive: true });

  // Test 1: record 2s then stop with 'q' (exactly like the recorder)
  await runTest(
    "Recorder-style: 2s then 'q' to stdin",
    path.join(outDir, 'typing-recorder-test-q.wav'),
    device,
    true,
    2
  );

  // Test 2: record 2s with -t 2 so ffmpeg exits on its own (no 'q')
  await runTest(
    "Fixed duration: -t 2 (no 'q')",
    path.join(outDir, 'typing-recorder-test-t.wav'),
    device,
    false,
    2
  );

  console.log('\n--- Summary ---');
  console.log('If "Fixed duration" produced a file but "Recorder-style" did not, the issue is stopping via "q".');
  console.log('If neither produced a file, the issue is capture or path.');
  console.log('Output dir:', path.resolve(outDir));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
