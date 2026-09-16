import { rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const serverBuildDirectory = fileURLToPath(new URL('../build/server/', import.meta.url));
rmSync(serverBuildDirectory, { recursive: true, force: true });
