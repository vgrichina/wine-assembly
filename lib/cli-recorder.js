'use strict';

const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

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
    this.stderr = '';

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

    this.child = spawn(this.ffmpeg, [...common, ...codec, this.path], {
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

  async finish() {
    if (this.finished) return this.summary();
    this.finished = true;
    if (!this.child.stdin.destroyed) this.child.stdin.end();
    const result = await this.exit;
    if (result.code !== 0) {
      const why = result.signal ? `signal ${result.signal}` : `exit code ${result.code}`;
      throw new Error(`ffmpeg failed with ${why}${this.stderr ? `:\n${this.stderr}` : ''}`);
    }
    if (!this.frames) throw new Error('CLI video recorder received no frames');
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
    };
  }
}

module.exports = { CliVideoRecorder };
