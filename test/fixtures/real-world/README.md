# Real-world fixture

A small app used to exercise the built `pyloros` CLI against a normal project layout.

Dependencies are pinned exactly and all declare an `engines.node` range that includes the Node version used for the test, so this fixture is the happy path for the Runtime Contract.

## Run the built CLI

From the repository root:

```sh
npm run build
cd test/fixtures/real-world
node ../../../dist/cli.js install
```

Then run the app:

```sh
node src/index.js 1.2.3
```

## What this fixture exercises

- exact dependency pins in `package.json`
- the `pyloros` policy section
- flat `node_modules` materialization
- a plain ESM app entrypoint

## Testing rejection paths

`debug@4.4.3` declares `engines.node` but depends on `ms`, which declares no `engines.node`. Adding `debug` to `dependencies` makes the resolver reject the tree with the Runtime Contract exit code. Remove it again to return to the happy path.
