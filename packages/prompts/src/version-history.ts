import type { VersionHistory } from './versioning.js';

// Append-only. When you change a prompt: bump its `version`, then add the new
// version and the digest printed by the failing `versions.test.ts`. Never edit an old entry.
export const VERSION_HISTORY: VersionHistory = {
  defense: {
    '1.0.0': '667ec1f85cdb32fc740b0ec9e3e6dfb74bd43cde34b5c8f07c8864169dcb7d6e',
  },
  'defense-second-attempt': {
    '1.0.0': '8ece14a4b32b55efb07da9f3a684d8682ff0029fd2ca8d221926d3556de2cf63',
  },
  prosecution: {
    '1.0.0': '13bb961614bf471822fcfe2f48d5cc6bfd0792affd74f1fc81e9cd83f73ea2e4',
  },
  remedy: {
    '1.0.0': 'd47bdc44f1cf9ea8cad259e5546f334201bbe84b6b346e8715c3c1cef47ada43',
  },
  'juror-security': {
    '1.0.0': '1b0e375177aa6e9d960714a1a8c50659dbeae2e8322541fc903f3658af9e2676',
  },
  'juror-maintainability': {
    '1.0.0': '760f35f8e55146d8dc7070659edef151d204320bf5f65b70969cc0469601f5bc',
  },
  'juror-blast-radius': {
    '1.0.0': '6c8cd842da68427b262531bae78e4243194e1818135c95c480c8786c7db54bd2',
  },
};
