'use strict';

const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const AUDIO_RATE = 44100;

function decodePcm(chunk) {
  const bytes = Buffer.isBuffer(chunk.bytes) ? chunk.bytes : Buffer.from(chunk.bytes);
  const channels = Math.max(1, chunk.channels | 0);
  const bits = chunk.bits | 0;
  const bytesPerSample = bits === 8 ? 1 : bits === 16 ? 2 : 0;
  if (!bytesPerSample) return null;
  const frames = Math.floor(bytes.length / (bytesPerSample * channels));
  if (!frames) return null;
  const data = Array.from({ length: channels }, () => new Float32Array(frames));
  for (let frame = 0; frame < frames; frame++) {
    for (let channel = 0; channel < channels; channel++) {
      const at = (frame * channels + channel) * bytesPerSample;
      data[channel][frame] = bits === 8
        ? (bytes[at] - 128) / 128
        : bytes.readInt16LE(at) / 32768;
    }
  }
  return { data, frames, rate: Math.max(1, chunk.sampleRate | 0) };
}

function writeMixedWav(file, chunks, startGuestMs, videoSeconds) {
  const decoded = [];
  let audioSeconds = 0;
  for (const chunk of chunks) {
    const pcm = decodePcm(chunk);
    if (!pcm) continue;
    const startSeconds = Math.max(0, (chunk.guestStartMs - startGuestMs) / 1000);
    audioSeconds = Math.max(audioSeconds, startSeconds + pcm.frames / pcm.rate);
    decoded.push({ chunk, pcm, startSeconds });
  }
  const frames = Math.max(1, Math.ceil(Math.max(videoSeconds, audioSeconds) * AUDIO_RATE));
  const left = new Float32Array(frames);
  const right = new Float32Array(frames);
  for (const { chunk, pcm, startSeconds } of decoded) {
    const ratio = pcm.rate / AUDIO_RATE;
    const outFrames = Math.floor(pcm.frames / ratio);
    const base = Math.round(startSeconds * AUDIO_RATE);
    const srcL = pcm.data[0];
    const srcR = pcm.data.length > 1 ? pcm.data[1] : srcL;
    const gainL = Number.isFinite(chunk.gainL) ? chunk.gainL : 1;
    const gainR = Number.isFinite(chunk.gainR) ? chunk.gainR : 1;
    for (let i = 0; i < outFrames && base + i < frames; i++) {
      const pos = i * ratio;
      const i0 = pos | 0;
      const i1 = Math.min(pcm.frames - 1, i0 + 1);
      const frac = pos - i0;
      left[base + i] += (srcL[i0] + (srcL[i1] - srcL[i0]) * frac) * gainL;
      right[base + i] += (srcR[i0] + (srcR[i1] - srcR[i0]) * frac) * gainR;
    }
  }

  const dataBytes = frames * 4;
  const wav = Buffer.allocUnsafe(44 + dataBytes);
  wav.write('RIFF', 0);
  wav.writeUInt32LE(36 + dataBytes, 4);
  wav.write('WAVE', 8);
  wav.write('fmt ', 12);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(2, 22);
  wav.writeUInt32LE(AUDIO_RATE, 24);
  wav.writeUInt32LE(AUDIO_RATE * 4, 28);
  wav.writeUInt16LE(4, 32);
  wav.writeUInt16LE(16, 34);
  wav.write('data', 36);
  wav.writeUInt32LE(dataBytes, 40);
  let peak = 0;
  for (let i = 0; i < frames; i++) {
    const l = Math.max(-1, Math.min(1, left[i]));
    const r = Math.max(-1, Math.min(1, right[i]));
    peak = Math.max(peak, Math.abs(l), Math.abs(r));
    wav.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(l * 32767))), 44 + i * 4);
    wav.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(r * 32767))), 46 + i * 4);
  }
  fs.writeFileSync(file, wav);
  return { frames, peak };
}

class CliVideoRecorder {
  constructor(canvas, options = {}) {
    if (!canvas || !canvas.getContext) throw new Error('CLI video recording requires a renderer canvas');

    this.path = path.resolve(options.path || 'wine-assembly.webm');
    this.ffmpeg = options.ffmpeg || 'ffmpeg';
    this.fps = Number(options.fps || 30);
    this.width = canvas.width | 0;
    this.height = canvas.height | 0;
    this.frames = 0;
    this.finished = false;
    this.active = true;
    this.stderr = '';
    this.startGuestMs = Number(options.startGuestMs || 0);
    this.audioChunks = [];
    this.audioBytes = 0;

    if (!Number.isFinite(this.fps) || this.fps <= 0 || this.fps > 240) {
      throw new Error(`invalid CLI video frame rate: ${options.fps}`);
    }
    if (this.width <= 0 || this.height <= 0) {
      throw new Error(`invalid CLI video size: ${this.width}x${this.height}`);
    }

    const probe = spawnSync(this.ffmpeg, ['-version'], { stdio: 'ignore' });
    if (probe.error) {
      throw new Error(`cannot start ffmpeg (${this.ffmpeg}): ${probe.error.message}`);
    }
    if (probe.status !== 0) {
      throw new Error(`ffmpeg preflight failed with exit code ${probe.status}`);
    }

    fs.mkdirSync(path.dirname(this.path), { recursive: true });
    const ext = path.extname(this.path).toLowerCase();
    this.ext = ext;
    const nonce = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    this.videoPath = path.join(path.dirname(this.path), `.${path.basename(this.path, ext)}-${nonce}.video${ext}`);
    this.wavPath = path.join(path.dirname(this.path), `.${path.basename(this.path, ext)}-${nonce}.audio.wav`);
    const common = [
      '-y', '-loglevel', 'error',
      '-f', 'rawvideo', '-pixel_format', 'rgba',
      '-video_size', `${this.width}x${this.height}`,
      '-framerate', String(this.fps), '-i', 'pipe:0',
      '-an', '-vf', 'pad=ceil(iw/2)*2:ceil(ih/2)*2',
    ];
    let codec;
    if (ext === '.webm') {
      codec = ['-c:v', 'libvpx-vp9', '-deadline', 'realtime', '-cpu-used', '5',
        '-crf', '30', '-b:v', '0'];
    } else if (ext === '.mp4') {
      codec = ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23',
        '-pix_fmt', 'yuv420p', '-movflags', '+faststart'];
    } else {
      throw new Error(`--video output must end in .webm or .mp4 (got ${this.path})`);
    }

    this.child = spawn(this.ffmpeg, [...common, ...codec, this.videoPath], {
      stdio: ['pipe', 'ignore', 'pipe'],
    });
    this.child.stderr.on('data', chunk => {
      this.stderr = (this.stderr + chunk.toString()).slice(-12000);
    });
    this.child.stdin.on('error', error => {
      this.streamError = error;
    });
    this.exit = new Promise((resolve, reject) => {
      this.child.once('error', reject);
      this.child.once('close', (code, signal) => resolve({ code, signal }));
    });
  }

  async capture(canvas) {
    if (this.finished) throw new Error('cannot capture a frame after CLI video recording finished');
    if ((canvas.width | 0) !== this.width || (canvas.height | 0) !== this.height) {
      throw new Error(`CLI video canvas resized from ${this.width}x${this.height} to ${canvas.width}x${canvas.height}`);
    }
    if (this.streamError) throw this.streamError;
    const pixels = canvas.getContext('2d').getImageData(0, 0, this.width, this.height).data;
    const frame = Buffer.from(pixels.buffer, pixels.byteOffset, pixels.byteLength);
    await new Promise((resolve, reject) => {
      this.child.stdin.write(frame, error => error ? reject(error) : resolve());
    });
    this.frames++;
  }

  pcm(chunk) {
    if (!this.active || this.finished || !chunk || !chunk.bytes || !chunk.bytes.length) return;
    const bytes = Buffer.from(chunk.bytes);
    this.audioChunks.push({
      guestStartMs: Number(chunk.guestStartMs || 0),
      sampleRate: chunk.sampleRate | 0,
      channels: chunk.channels | 0,
      bits: chunk.bits | 0,
      gainL: Number.isFinite(chunk.gainL) ? chunk.gainL : 1,
      gainR: Number.isFinite(chunk.gainR) ? chunk.gainR : 1,
      bytes,
    });
    this.audioBytes += bytes.length;
  }

  async finish() {
    if (this.finished) return this.summary();
    this.finished = true;
    this.active = false;
    if (!this.child.stdin.destroyed) this.child.stdin.end();
    const result = await this.exit;
    if (result.code !== 0) {
      const why = result.signal ? `signal ${result.signal}` : `exit code ${result.code}`;
      throw new Error(`ffmpeg failed with ${why}${this.stderr ? `:\n${this.stderr}` : ''}`);
    }
    if (!this.frames) throw new Error('CLI video recorder received no frames');
    const audio = writeMixedWav(this.wavPath, this.audioChunks, this.startGuestMs, this.frames / this.fps);
    const audioCodec = this.ext === '.webm'
      ? ['-c:a', 'libopus', '-b:a', '128k']
      : ['-c:a', 'aac', '-b:a', '128k'];
    const mux = spawnSync(this.ffmpeg, [
      '-y', '-loglevel', 'error', '-i', this.videoPath, '-i', this.wavPath,
      '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'copy', ...audioCodec,
      '-ar', String(AUDIO_RATE), '-ac', '2', '-shortest',
      ...(this.ext === '.mp4' ? ['-movflags', '+faststart'] : []),
      this.path,
    ], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
    if (mux.error || mux.status !== 0) {
      throw new Error(`ffmpeg audio mux failed${mux.error ? `: ${mux.error.message}` : ` with exit code ${mux.status}:\n${mux.stderr || ''}`}`);
    }
    try { fs.unlinkSync(this.videoPath); } catch (_) {}
    try { fs.unlinkSync(this.wavPath); } catch (_) {}
    this.audioPeak = audio.peak;
    return this.summary();
  }

  summary() {
    return {
      path: this.path,
      width: this.width,
      height: this.height,
      fps: this.fps,
      frames: this.frames,
      duration: this.frames / this.fps,
      audioChunks: this.audioChunks.length,
      audioBytes: this.audioBytes,
      audioPeak: this.audioPeak || 0,
    };
  }
}

module.exports = { CliVideoRecorder };
