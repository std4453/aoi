import fs from 'node:fs';

// Container builds bake this file into the image; local deployments must supply
// an explicit identical build identity on both nodes.
const baked = new URL('./build-revision.txt', import.meta.url);
export const buildRevision = fs.existsSync(baked)
  ? fs.readFileSync(baked, 'utf8').trim()
  : process.env.AOI_BUILD_REVISION || 'development';
export const protocolVersion = 1;
export const dataScope = 'aoi-content-v1';
