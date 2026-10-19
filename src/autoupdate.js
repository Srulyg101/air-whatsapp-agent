// Auto-update: every few minutes, check GitHub for new commits on the deployed branch.
// When there is a newer commit, shut down cleanly. Docker (restart: unless-stopped)
// starts the container again, and its start command pulls the new code and runs npm install.
// No API keys or GitHub secrets needed.
//   AUTO_UPDATE_MIN  minutes between checks (default 3, 0 = off)
//   AUTO_UPDATE_BRANCH  branch to follow (default main)
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

const repo = path.resolve(__dirname, '..');
const minutes = Number(process.env.AUTO_UPDATE_MIN ?? 3);
const branch = process.env.AUTO_UPDATE_BRANCH || 'main';

function git(args) {
  return new Promise((resolve, reject) => {
    execFile('git', ['-C', repo, ...args], { timeout: 60_000 }, (err, stdout, stderr) => {
      if (err) return reject(new Error((stderr || err.message).trim()));
      resolve(stdout.trim());
    });
  });
}

async function check(onUpdate) {
  try {
    await git(['fetch', '--quiet', 'origin', branch]);
    const head = await git(['rev-parse', 'HEAD']);
    const remote = await git(['rev-parse', `origin/${branch}`]);
    if (head === remote) return;
    // Only restart for a normal fast-forward; a rewritten history would make the
    // start command's `git pull --ff-only` fail and we'd restart forever.
    try { await git(['merge-base', '--is-ancestor', head, remote]); }
    catch (_) { console.warn(`[autoupdate] origin/${branch} is not a fast-forward of ${head.slice(0, 7)}; skipping`); return; }
    console.log(`[autoupdate] new version ${remote.slice(0, 7)} (running ${head.slice(0, 7)}), restarting to update`);
    onUpdate();
  } catch (e) {
    console.warn('[autoupdate] update check failed');
  }
}

function start(onUpdate) {
  if (!minutes || minutes <= 0) return;
  if (!fs.existsSync(path.join(repo, '.git'))) return;
  const ms = Math.max(1, minutes) * 60_000;
  setTimeout(function loop() {
    check(onUpdate).finally(() => setTimeout(loop, ms).unref());
  }, ms).unref();
  console.log(`[autoupdate] following origin/${branch}, checking every ${minutes} min`);
}

module.exports = { start, check };
