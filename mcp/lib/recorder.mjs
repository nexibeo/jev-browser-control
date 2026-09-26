// Screen recording for browser mode: Chrome's own screencast of the current tab (it follows tab
// switches), saved as JPEG frames with their times, and turned into an MP4 with ffmpeg on stop.
// Without ffmpeg the frames and frames.json stay in the folder.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

// Width and height from a JPEG's start-of-frame marker.
export function jpegSize(buf) {
  let i = 2;
  while (i < buf.length) {
    if (buf[i] !== 0xff) { i++; continue; }
    const marker = buf[i + 1];
    const len = buf.readUInt16BE(i + 2);
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return { h: buf.readUInt16BE(i + 5), w: buf.readUInt16BE(i + 7) };
    i += 2 + len;
  }
  return null;
}

export class Recorder {
  constructor(browser, dir) {
    this.browser = browser;
    this.baseDir = dir;
    this.active = null;
  }

  async start({ name } = {}) {
    if (this.active) throw new Error(`Already recording into ${this.active.dir}. Stop it first.`);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const slug = String(name || 'recording').replace(/[^a-z0-9_-]+/gi, '-').replace(/^-|-$/g, '').slice(0, 60) || 'recording';
    const dir = join(this.baseDir, `${stamp}-${slug}`);
    mkdirSync(join(dir, 'frames'), { recursive: true });
    this.active = { dir, name: slug, frames: [], started: Date.now(), page: null, cdp: null, n: 0, size: null, timer: null };
    await this.follow();
    this.active.timer = setInterval(() => this.follow().catch(() => {}), 300);
    return { recording: true, dir };
  }

  // Attach the screencast to whichever tab the tools are working in now.
  async follow() {
    const a = this.active;
    const page = this.browser.current;
    if (!a || !page || page.isClosed() || page === a.page) return;
    await this.detach();
    a.page = page;
    const cdp = await page.context().newCDPSession(page);
    a.cdp = cdp;
    cdp.on('Page.screencastFrame', ({ data, sessionId }) => {
      cdp.send('Page.screencastFrameAck', { sessionId }).catch(() => {});
      if (this.active !== a || a.cdp !== cdp) return;
      const buf = Buffer.from(data, 'base64');
      a.size ||= jpegSize(buf);
      const file = join(a.dir, 'frames', `${String(++a.n).padStart(6, '0')}.jpg`);
      writeFileSync(file, buf);
      a.frames.push({ file, t: Date.now() - a.started });
    });
    await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 82, maxWidth: 1920, maxHeight: 1200, everyNthFrame: 1 });
  }

  async detach() {
    const a = this.active;
    if (!a?.cdp) return;
    const cdp = a.cdp;
    a.cdp = null;
    await cdp.send('Page.stopScreencast').catch(() => {});
    await cdp.detach().catch(() => {});
  }

  async stop() {
    const a = this.active;
    if (!a) throw new Error('Not recording. Call browser_record with action "start" first.');
    clearInterval(a.timer);
    const end = Date.now() - a.started;
    await this.detach();
    this.active = null;
    const seconds = Math.round(end / 100) / 10;
    writeFileSync(join(a.dir, 'frames.json'), JSON.stringify({ duration_ms: end, size: a.size, frames: a.frames.map((f) => ({ t: f.t, file: f.file.split('/').pop() })) }, null, 1));
    if (!a.frames.length) return { saved: null, dir: a.dir, frames: 0, seconds, note: 'No frames were captured (nothing was shown while recording).' };

    // Each frame lasts until the next one arrives (Chrome only sends frames when the page changes).
    const list = [];
    a.frames.forEach((f, i) => {
      const next = i + 1 < a.frames.length ? a.frames[i + 1].t : end;
      list.push(`file '${f.file}'`, `duration ${Math.max(0.02, (next - f.t) / 1000).toFixed(3)}`);
    });
    list.push(`file '${a.frames.at(-1).file}'`);
    const listFile = join(a.dir, 'frames.txt');
    writeFileSync(listFile, list.join('\n') + '\n');
    const out = join(a.dir, `${a.name}.mp4`);
    const w = a.size ? a.size.w - (a.size.w % 2) : 1280;
    const h = a.size ? a.size.h - (a.size.h % 2) : 800;
    const ff = spawnSync('ffmpeg', ['-y', '-v', 'error', '-f', 'concat', '-safe', '0', '-i', listFile,
      '-vf', `scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:color=white,fps=30,format=yuv420p`,
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-movflags', '+faststart', out], { encoding: 'utf8' });
    if (ff.error || ff.status !== 0) {
      return { saved: null, dir: a.dir, frames: a.frames.length, seconds, note: `ffmpeg ${ff.error ? 'is not installed' : 'failed: ' + String(ff.stderr).slice(0, 300)}. The frames and frames.json are in the folder.` };
    }
    return { saved: out, dir: a.dir, frames: a.frames.length, seconds };
  }
}
