'use strict';
const path = require('node:path');
const { createRequire } = require('node:module');
const upstream = createRequire(path.join(process.cwd(), 'package.json'));
const webpack = upstream('webpack');
const config = upstream('./webpack.config.js');
// The StringReplacePlugin inserts fresh random loader query strings into exactly
// two Webpack module identifiers. Preserve the module numbers of pdfmake 0.3.14.
config.optimization.moduleIds = false;
config.plugins.push(new webpack.ids.DeterministicModuleIdsPlugin({maxLength: 4}));
config.plugins.push({ apply(compiler) {
  compiler.hooks.compilation.tap('PinnedPdfmakeModuleIds', compilation => {
    compilation.hooks.beforeModuleIds.tap('PinnedPdfmakeModuleIds', modules => {
      const assigned = new Set();
      for (const mod of modules) {
        let id;
        if (mod.resource === upstream.resolve('file-saver/dist/FileSaver.min.js')) id = 633;
        if (mod.rootModule?.resource === upstream.resolve('./src/browser-extensions/index.js')) id = 8069;
        if (id !== undefined) {
          if (assigned.has(id)) throw new Error('Ambiguous pdfmake module ' + id);
          assigned.add(id);
          compilation.chunkGraph.setModuleId(mod, id);
        }
      }
      if (assigned.size !== 2) throw new Error('Expected two modules using string-replace-webpack-plugin');
    });
  });
}});
webpack(config, (err, stats) => {
  if (err || stats.hasErrors()) {
    console.error(err || stats.toString({errors: true, all: false}));
    process.exitCode = 1;
  }
});
