const fs = require('node:fs');
const path = require('node:path');

// Turbo restores files over the existing output. Drop retired chunks/modules before restoring.
const dist = path.resolve('dist');
if (fs.existsSync(dist)) {
    if (fs.lstatSync(dist).isSymbolicLink()) throw new Error(`Refusing to clean linked build output: ${dist}`);
    for (const name of fs.readdirSync(dist)) {
        // Standalone executables are produced separately and aren't part of a backend deployment.
        if (name === 'bin' && path.basename(process.cwd()) === 'core') continue;
        fs.rmSync(path.join(dist, name), { recursive: true, force: true });
    }
}
