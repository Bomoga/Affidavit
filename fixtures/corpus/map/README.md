# map

Expected answers for the map (L1-05). Nothing here is produced by the code under test.

- `nodegoat-routes.json.fixture`: the route list of OWASP NodeGoat at the pinned commit, written by hand from `server.js` and `app/routes/*.js`: method, path, the middleware chain in front of each handler, the file the handler is defined in, whether an auth guard is on the path, the application-wide middleware, and a few data-access calls the map must find. `packages/discovery/src/map/map.nodegoat.test.ts` compares the map's output with it on a real checkout of the pinned commit. Reachability for the labeled issues is compared with the `reachability` field of the labels in `packages/corpus/data/nodegoat/app.json`, not duplicated here.

The `.fixture` suffix keeps `packages/testing` from treating the file as a contract fixture (the same convention as `tool-smoke` and `normalize`).

NodeGoat is fetched at run time and never vendored (see `packages/corpus`).
