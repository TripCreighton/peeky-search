# example-bundler

A synthetic README, standing in for whatever GitHub serves at
`/{owner}/{repo}/readme`. It exists to exercise markdown parsing — headings,
prose, fenced code, lists, tables and links — not to reproduce any real
project's documentation.

## Why

Two things make a build tool feel slow: cold starts that rebuild the world, and
rebuilds that scale with project size rather than with what changed. This one
serves source over native ES modules in development, so the server starts
immediately and a change costs one module.

## Getting started

```bash
npm create example-bundler@latest
cd my-app
npm install
npm run dev
```

The dev server prints a local URL. Edits to a component update in place without
losing state.

## Configuration

Create `example.config.js` at the project root:

```js
import { defineConfig } from "example-bundler";

export default defineConfig({
  root: "src",
  build: {
    outDir: "dist",
    sourcemap: true,
  },
});
```

### Options

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `root` | `string` | `"."` | Directory to serve as the project root |
| `build.outDir` | `string` | `"dist"` | Output directory for a production build |
| `build.sourcemap` | `boolean` | `false` | Emit source maps alongside the bundle |
| `server.port` | `number` | `5173` | Port for the development server |

## Plugins

Plugins are objects with named hooks:

- `resolveId` — turn an import specifier into a module id
- `load` — return source for a module id
- `transform` — rewrite source before it reaches the bundler

```js
function stripDebug() {
  return {
    name: "strip-debug",
    transform(code) {
      return code.replace(/console\.debug\([^)]*\);?/g, "");
    },
  };
}
```

## Documentation

Full documentation lives at [example.com/docs](https://example.com/docs).
See [CONTRIBUTING](https://example.com/contributing) before opening a pull
request.

## License

MIT
