import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { schemaRegistry } from '../src/registry.js';

const outDir = join(import.meta.dirname, '..', 'json-schema');
mkdirSync(outDir, { recursive: true });
for (const [name, schema] of Object.entries(schemaRegistry)) {
  const json = z.toJSONSchema(schema, { target: 'draft-2020-12' });
  writeFileSync(join(outDir, `${name}.schema.json`), JSON.stringify(json, null, 2) + '\n');
}
console.log(`wrote ${Object.keys(schemaRegistry).length} schemas to ${outDir}`);
