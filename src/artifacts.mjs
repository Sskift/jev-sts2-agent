import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function createSession(artifactRoot = path.join(ROOT, 'run-artifacts')) {
  const directory = path.join(path.resolve(artifactRoot), `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`);
  fs.mkdirSync(directory, { recursive: true });
  return directory;
}
