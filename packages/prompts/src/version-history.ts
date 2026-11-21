import type { VersionHistory } from './versioning.js';

// Append-only. When you change a prompt: bump its `version`, then add the new
// version and the digest printed by the failing `versions.test.ts`. Never edit an old entry.
//
// 1.1.0 (all prompts): removed instructions to write in a "reasoning field" that no
// contracts schema has; agents now end the turn without submitting. Remedy's
// outputSchemaRef moved from PatchExhibit to Exhibit (the schemaRegistry key). Jurors vote
// only within their question; insufficient is valid only for evidence-sufficiency.
// 1.2.0 (prosecution): the agent submits parameter choices drawn from the Defense witness
// family, not code; the system builds the exhibit. Cite exhibit ids; prose is inadmissible.
// 1.3.0 (prosecution): no longer promises claim attacks the agent cannot express (CR-T9).
export const VERSION_HISTORY: VersionHistory = {
  defense: {
    '1.0.0': '667ec1f85cdb32fc740b0ec9e3e6dfb74bd43cde34b5c8f07c8864169dcb7d6e',
    '1.1.0': '70b70d2abff59499fda55863b6d42874be1686f177097af87bbdacd76e0de7e1',
  },
  'defense-second-attempt': {
    '1.0.0': '8ece14a4b32b55efb07da9f3a684d8682ff0029fd2ca8d221926d3556de2cf63',
    '1.1.0': '3a99d50af06b3a74f17c5de63089001305dd3ef5f823db57e2b47803b97a6e6f',
  },
  prosecution: {
    '1.0.0': '13bb961614bf471822fcfe2f48d5cc6bfd0792affd74f1fc81e9cd83f73ea2e4',
    '1.1.0': '89ae2b56ca7b85f2afe7a51a8a7c621a43c6bdb055791daa9812fdfd91f8ab6c',
    '1.2.0': 'f6c344942d9a06b62665c3a68d3467530474b871f2b649845d7856be84656ad9',
    '1.3.0': 'fba511e04822cd234056c4eda1a749584df19b8705f7b1e3648d7e88e1d57db8',
  },
  remedy: {
    '1.0.0': 'd47bdc44f1cf9ea8cad259e5546f334201bbe84b6b346e8715c3c1cef47ada43',
    '1.1.0': '64af317329497f2e14be89a85b69f8966ba2f021aff34c6db66d3dc797cfd687',
  },
  'juror-security': {
    '1.0.0': '1b0e375177aa6e9d960714a1a8c50659dbeae2e8322541fc903f3658af9e2676',
    '1.1.0': '6d099dc9ad4851379804d2560584a1d9b38b43139c2e62d4be6c2bc78d19d7f0',
  },
  'juror-maintainability': {
    '1.0.0': '760f35f8e55146d8dc7070659edef151d204320bf5f65b70969cc0469601f5bc',
    '1.1.0': '7f17339e13bf652c8bcbac6aa41d9dfa5e4b99da617e81b27f0338691aa27b59',
  },
  'juror-blast-radius': {
    '1.0.0': '6c8cd842da68427b262531bae78e4243194e1818135c95c480c8786c7db54bd2',
    '1.1.0': '3ea3bf6f5c8dadec663d9761cd4461b5c8a670ae53148d8e6fd23269804ae5e9',
  },
};
