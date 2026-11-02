import { build } from 'esbuild'

await build({
  entryPoints: ['src/client/index.tsx'], outfile: 'lib/client.js',
  bundle: true, platform: 'browser', format: 'cjs', target: 'es2022',
  external: ['react', 'react/jsx-runtime'], minify: true,
  banner: { js: 'window.__ModuleLoader__.load({ id: "dsh-hoploom", factory: (require) => { var module = { exports: {} }; var exports = module.exports;' },
  footer: { js: 'return module.exports; } });' },
})

// The iframe uses the product's exact React application, styles and API client.
// Bundle its own React version so it does not share state or CSS with dsh.
await build({
  entryPoints: ['../ssh-server-manager/frontend/src/main.tsx'], outfile: 'lib/ui.js',
  bundle: true, platform: 'browser', format: 'esm', target: 'es2022', minify: true,
  define: { 'process.env.NODE_ENV': '"production"' },
})
