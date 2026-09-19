import { spawn } from 'node:child_process';
import ffmpeg from '@ffmpeg-installer/ffmpeg';

const FFMPEG_PATH = ffmpeg?.path;
const PROCESS_TIMEOUT_MS = 20_000;

/**
 * Convert browser/Telegram audio to mono 16 kHz WAV and reduce steady background noise.
 * Returns the original buffer on any preprocessing failure so transcription remains available.
 */
export async function preprocessAudioBuffer(input, { mimeType = 'audio/webm' } = {}) {
  const source = Buffer.isBuffer(input) ? input : Buffer.from(input || '');
  if (!source.length || !FFMPEG_PATH) return { buffer: source, denoised: false };

  const args = [
    '-hide_banner', '-loglevel', 'error',
    '-i', 'pipe:0',
    '-af', 'highpass=f=80,afftdn=nf=-25,loudnorm=I=-16:TP=-1.5:LRA=11',
    '-ar', '16000', '-ac', '1', '-f', 'wav', 'pipe:1',
  ];

  return await new Promise((resolve) => {
    const child = spawn(FFMPEG_PATH, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    const chunks = [];
    let stderr = '';
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish({ buffer: source, denoised: false, error: 'ffmpeg timeout' });
    }, PROCESS_TIMEOUT_MS);

    child.stdout.on('data', (chunk) => chunks.push(chunk));
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', (error) => finish({ buffer: source, denoised: false, error: error.message }));
    child.on('close', (code) => {
      const output = Buffer.concat(chunks);
      if (code === 0 && output.length > 44) {
        finish({ buffer: output, denoised: true });
      } else {
        finish({ buffer: source, denoised: false, error: stderr.trim() || `ffmpeg exited ${code}` });
      }
    });
    child.stdin.on('error', () => {});
    child.stdin.end(source);
  });
}

export function audioExtension(mimeType = '') {
  const mime = String(mimeType).toLowerCase();
  if (mime.includes('ogg')) return 'ogg';
  if (mime.includes('mp4') || mime.includes('m4a')) return 'm4a';
  if (mime.includes('wav')) return 'wav';
  return 'webm';
}
