// Runs after npm install: removes GPU/other-OS binaries from onnxruntime (used for local voice
// transcription) to save ~450 MB of disk on the VPS. Safe to fail.
const fs = require('fs');
const path = require('path');
try {
  const bin = path.join(__dirname, '..', 'node_modules', 'onnxruntime-node', 'bin');
  if (!fs.existsSync(bin)) process.exit(0);
  for (const napi of fs.readdirSync(bin)) {
    for (const plat of fs.readdirSync(path.join(bin, napi))) {
      for (const arch of fs.readdirSync(path.join(bin, napi, plat))) {
        const dir = path.join(bin, napi, plat, arch);
        if (plat !== process.platform || arch !== process.arch) { fs.rmSync(dir, { recursive: true, force: true }); continue; }
        for (const f of fs.readdirSync(dir)) if (/providers_(cuda|tensorrt)/.test(f)) fs.rmSync(path.join(dir, f), { force: true });
      }
    }
  }
  const web = path.join(__dirname, '..', 'node_modules', 'onnxruntime-web');
  if (fs.existsSync(web)) for (const f of fs.readdirSync(path.join(web, 'dist'))) if (/jsep|webgpu|\.wasm$/.test(f)) fs.rmSync(path.join(web, 'dist', f), { force: true });
} catch (e) { console.warn('prune skipped:', e.message); }
