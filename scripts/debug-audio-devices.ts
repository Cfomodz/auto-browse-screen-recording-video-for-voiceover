/**
 * Debug script: list audio capture devices and test each with a short recording.
 * Reports success/failure, file size, duration, and any ffmpeg errors.
 *
 * Run: npm run debug-audio   or   npx ts-node scripts/debug-audio-devices.ts
 *
 * Options:
 *   --duration N   Record N seconds per device (default 2)
 *   --out DIR     Write test WAVs to DIR (default ./debug-audio-out)
 *
 * Status: OK = recorded with detectable level; SILENT = file present but peak < -50 dB;
 *   EMPTY = no file; ERROR = ffmpeg non-zero exit; NO_DURATION = unreadable/short.
 */

import * as child_process from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

const RECORD_SEC = parseInt(process.env.DEBUG_AUDIO_SEC ?? '2', 10) || 2;
const OUT_DIR = process.env.DEBUG_AUDIO_OUT ?? path.join(process.cwd(), 'debug-audio-out');

function getDshowAudioDevices(): string[] {
  const result = child_process.spawnSync('ffmpeg', [
    '-list_devices', 'true', '-f', 'dshow', '-i', 'dummy',
  ], { encoding: 'utf8', maxBuffer: 200 * 1024, windowsHide: true });
  const stderr = (result.stderr ?? result.stdout ?? '') as string;
  const names: string[] = [];
  const regex = /"([^"]+)"\s*\(audio\)/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(stderr)) !== null) {
    names.push(match[1]);
  }
  return names;
}

function recordDevice(deviceName: string, outPath: string, durationSec: number): { code: number; stderr: string } {
  const result = child_process.spawnSync('ffmpeg', [
    '-f', 'dshow',
    '-i', `audio=${deviceName}`,
    '-ar', '44100',
    '-ac', '1',
    '-t', String(durationSec),
    '-y',
    outPath,
  ], { encoding: 'utf8', maxBuffer: 500 * 1024, windowsHide: true, timeout: (durationSec + 10) * 1000 });
  const stderr = (result.stderr ?? '') as string;
  return { code: result.status ?? -1, stderr };
}

function probeWav(wavPath: string): { durationSec: number | null; error?: string } {
  const result = child_process.spawnSync('ffprobe', [
    '-v', 'error',
    '-show_entries', 'format=duration',
    '-of', 'default=noprint_wrappers=1:nokey=1',
    wavPath,
  ], { encoding: 'utf8', maxBuffer: 10000, windowsHide: true });
  if (result.status !== 0) {
    return { durationSec: null, error: (result.stderr ?? result.stdout ?? '').trim().split('\n')[0] };
  }
  const out = (result.stdout ?? '').trim();
  const d = parseFloat(out);
  return { durationSec: Number.isFinite(d) ? d : null };
}

function getPeakLevel(wavPath: string): number | null {
  // ffmpeg -i file.wav -af "volumedetect" -f null -
  const result = child_process.spawnSync('ffmpeg', [
    '-i', wavPath,
    '-af', 'volumedetect',
    '-f', 'null', '-',
  ], { encoding: 'utf8', maxBuffer: 100 * 1024, windowsHide: true });
  const stderr = (result.stderr ?? '') as string;
  const m = stderr.match(/max_volume:\s*([-\d.]+)\s*dB/);
  return m ? parseFloat(m[1]) : null;
}

function main() {
  const args = process.argv.slice(2);
  let durationSec = RECORD_SEC;
  let outDir = OUT_DIR;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--duration' && args[i + 1]) {
      durationSec = parseInt(args[++i], 10) || 2;
    } else if (args[i] === '--out' && args[i + 1]) {
      outDir = args[++i];
    }
  }

  console.log('=== Audio device debug ===');
  console.log('Platform:', process.platform);
  if (process.platform !== 'win32') {
    console.log('This script lists and tests DirectShow (dshow) devices on Windows only.');
    console.log('On other platforms, use your system tools or ffmpeg -sources pulse/alsa.');
    process.exit(0);
  }

  console.log('Listing DirectShow audio devices...\n');
  const devices = getDshowAudioDevices();
  if (devices.length === 0) {
    console.log('No DirectShow audio devices found. Run: ffmpeg -list_devices true -f dshow -i dummy');
    process.exit(1);
  }

  console.log(`Found ${devices.length} device(s). Recording ${durationSec}s from each to: ${outDir}\n`);
  fs.mkdirSync(outDir, { recursive: true });

  const rows: Array<{
    device: string;
    status: string;
    code: number;
    sizeBytes: number;
    durationSec: number | null;
    maxDb: number | null;
    stderrSnippet: string;
  }> = [];

  for (let i = 0; i < devices.length; i++) {
    const name = devices[i];
    const safeName = name.replace(/[<>:"/\\|?*]/g, '_').slice(0, 60);
    const outPath = path.join(outDir, `device_${i + 1}_${safeName}.wav`);
    process.stdout.write(`  [${i + 1}/${devices.length}] ${name.slice(0, 50)}... `);

    const { code, stderr } = recordDevice(name, outPath, durationSec);
    const stderrSnippet = stderr
      .split('\n')
      .filter((l) => l.trim() && !l.includes('frame='))
      .slice(-5)
      .join(' ')
      .slice(0, 120);
    let sizeBytes = 0;
    try {
      sizeBytes = fs.statSync(outPath).size;
    } catch {
      // no file
    }
    const probe = fs.existsSync(outPath) ? probeWav(outPath) : { durationSec: null as number | null };
    const maxDb = fs.existsSync(outPath) ? getPeakLevel(outPath) : null;

    let status: string;
    if (code !== 0) {
      status = 'ERROR';
    } else if (sizeBytes === 0) {
      status = 'EMPTY';
    } else if (probe.durationSec === null || probe.durationSec < 0.5) {
      status = 'NO_DURATION';
    } else if (maxDb !== null && maxDb < -50) {
      status = 'SILENT';
    } else {
      status = 'OK';
    }

    rows.push({
      device: name,
      status,
      code,
      sizeBytes,
      durationSec: probe.durationSec ?? null,
      maxDb,
      stderrSnippet,
    });
    console.log(status);
  }

  console.log('\n--- Summary ---\n');
  const col = (s: string, w: number) => s.padEnd(w).slice(0, w);
  console.log(col('#', 3) + col('Status', 12) + col('Size', 10) + col('Dur(s)', 8) + col('Peak(dB)', 10) + ' Device');
  console.log('-'.repeat(80));
  rows.forEach((r, i) => {
    const sizeStr = r.sizeBytes > 0 ? `${(r.sizeBytes / 1024).toFixed(1)}k` : '-';
    const durStr = r.durationSec != null ? r.durationSec.toFixed(2) : '-';
    const dbStr = r.maxDb != null ? r.maxDb.toFixed(1) : '-';
    console.log(
      col(String(i + 1), 3) + col(r.status, 12) + col(sizeStr, 10) + col(durStr, 8) + col(dbStr, 10) + ' ' + r.device.slice(0, 40)
    );
  });

  console.log('\n--- Errors / notes (if any) ---\n');
  rows.forEach((r, i) => {
    if (r.status !== 'OK' && r.stderrSnippet) {
      console.log(`[${i + 1}] ${r.device}`);
      console.log(`    ${r.stderrSnippet}\n`);
    }
  });

  const ok = rows.filter((r) => r.status === 'OK').length;
  console.log(`\nDone. ${ok}/${devices.length} device(s) recorded successfully. WAVs in: ${outDir}`);
  console.log('\nStatus legend: OK = has audio level; SILENT = recorded but peak < -50 dB;');
  console.log('  EMPTY/ERROR/NO_DURATION = recording failed or empty.');
}

main();
