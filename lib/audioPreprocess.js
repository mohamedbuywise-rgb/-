// lib/audioPreprocess.js
// معالجة الصوت قبل ما يوصل لـ Whisper — نفس فكرة imagePreprocess.js بالظبط بس للصوت بدل الصورة.
// بيستخدم ffmpeg (عبر باكدج ثابت @ffmpeg-installer/ffmpeg، شغال جوه أي Serverless function من غير
// تثبيت ffmpeg على السيرفر) عشان يعمل 3 حاجات قبل الرفع لـ Groq:
//
// 1) highpass=f=80      -> يشيل الهمهمة الواطية جدًا (مكيف، ريح، دوشة خلفية) تحت 80Hz، مش موجودة في كلام الإنسان أصلاً.
// 2) afftdn=nf=-25      -> FFT denoiser: بيتعلم شكل الضوضاء الثابتة في التسجيل ويقللها، من غير ما يأثر على الكلام.
// 3) loudnorm=I=-16...  -> توحيد مستوى الصوت (لو الشخص بعيد عن الميكروفون أو بيهمس) عشان الصوت الواطي يبقى مسموع للموديل.
// وبعدين بيحوّل لـ mono 16kHz WAV، وهو بالظبط الفورمات اللي Whisper مبني عليه أصلاً — فده كمان
// بيقلل حجم الملف المرفوع (رفع أسرع للمستخدم) من غير أي خسارة في الدقة.
//
// لو المعالجة فشلت لأي سبب (تسجيل تالف، صيغة غريبة، ffmpeg مش متاح مؤقتًا)، بنرجّع null بدل ما نرمي
// استثناء، عشان الاستدعاء في groq.js يرجع تلقائيًا للملف الخام الأصلي ومتقفلش الميزة كلها بسبب فشل التحسين.

import { spawn } from 'child_process';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import ffmpegInstaller from '@ffmpeg-installer/ffmpeg';

const AUDIO_FILTERS = 'highpass=f=80,afftdn=nf=-25,loudnorm=I=-16:TP=-1.5:LRA=11';

export async function denoiseAudioBuffer(inputBuffer, inputExt = 'webm') {
  const tmpDir = os.tmpdir();
  const id = crypto.randomUUID();
  const inputPath = path.join(tmpDir, `dabbar-voice-in-${id}.${inputExt}`);
  const outputPath = path.join(tmpDir, `dabbar-voice-out-${id}.wav`);

  try {
    await fs.writeFile(inputPath, inputBuffer);

    await new Promise((resolve, reject) => {
      const args = [
        '-y',
        '-i', inputPath,
        '-af', AUDIO_FILTERS,
        '-ac', '1',
        '-ar', '16000',
        outputPath,
      ];
      const proc = spawn(ffmpegInstaller.path, args);
      let stderr = '';
      proc.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
      proc.on('error', reject);
      proc.on('close', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`ffmpeg exited with code ${code}: ${stderr.slice(-400)}`));
      });
      // حماية إضافية: لو التسجيل طويل جدًا أو ffmpeg علّق لأي سبب، منستناش أكتر من 20 ثانية.
      setTimeout(() => { try { proc.kill('SIGKILL'); } catch {} reject(new Error('ffmpeg timeout')); }, 20000);
    });

    return await fs.readFile(outputPath);
  } catch (error) {
    console.error('denoiseAudioBuffer failed, falling back to raw audio:', error.message);
    return null;
  } finally {
    fs.unlink(inputPath).catch(() => {});
    fs.unlink(outputPath).catch(() => {});
  }
}
