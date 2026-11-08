'use strict';

const { createHash, randomUUID } = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');

// Work state is durable independently of the seven-day parsed-response cache.
// Each file contains one source/scope/year, never a whole expanding archive.
function createRisSourceCheckpoint({ directory } = {}) {
  if (typeof directory !== 'string' || !directory) throw new TypeError('Invalid RIS checkpoint directory');
  const root = path.resolve(directory, 'checkpoints');
  function folder(source, scope) {
    if (typeof source !== 'string' || !source || typeof scope !== 'string' || !scope) throw new TypeError('Invalid RIS checkpoint scope');
    return path.join(root, createHash('sha256').update(JSON.stringify([source, scope])).digest('hex'));
  }
  function filename(source, scope, year) {
    if (!Number.isInteger(year) || year < 1900 || year > 9999) throw new TypeError('Invalid RIS checkpoint year');
    return path.join(folder(source, scope), `${year}.json`);
  }
  async function read(source, scope, year, revision) {
    try {
      const file = filename(source, scope, year);
      const stat = await fs.lstat(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 64 * 1024 * 1024) return null;
      const entry = JSON.parse(await fs.readFile(file, 'utf8'));
      return entry.version === 1 && entry.source === source && entry.scope === scope && entry.year === year && entry.revision === revision ? entry.work : null;
    } catch (error) { if (error.code === 'ENOENT' || error instanceof SyntaxError) return null; throw error; }
  }
  async function write(source, scope, year, revision, work) {
    const target = filename(source, scope, year);
    await fs.mkdir(path.dirname(target), { recursive: true });
    const temp = `${target}.${randomUUID()}.tmp`;
    try {
      const encoded = JSON.stringify({ version: 1, source, scope, year, revision, work }).replace(/[\u007f-\uffff]/g,
        character => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`);
      await fs.writeFile(temp, encoded, { flag: 'wx' });
      await fs.rename(temp, target);
    } finally { await fs.rm(temp, { force: true }); }
  }
  async function years(source, scope) {
    try { return (await fs.readdir(folder(source, scope))).filter(name => /^\d{4}\.json$/.test(name)).map(name => Number(name.slice(0, 4))).sort((a, b) => a - b); }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  }
  return { read, write, years };
}

module.exports = { createRisSourceCheckpoint };
