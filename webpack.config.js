// ts-ignore

const path = require('path');
const CopyWebpackPlugin = require('copy-webpack-plugin');

const config = {
  target: 'node', // vscode extensions run in a Node.js-context 📖 -> https://webpack.js.org/configuration/node/
  context: path.resolve(__dirname, 'src'),
  entry: './extension.ts', // the entry point of this extension, 📖 -> https://webpack.js.org/configuration/entry-context/
  output: {
    // the bundle is stored in the 'dist' folder (check package.json), 📖 -> https://webpack.js.org/configuration/output/
    path: path.resolve(__dirname, 'dist'),
    filename: 'extension.js',
    libraryTarget: 'commonjs2',
    devtoolModuleFilenameTemplate: '../../[resource-path]',
  },
  devtool: 'source-map',
  externals: {
    vscode: 'commonjs vscode', // the vscode-module is created on-the-fly and must be excluded. Add other modules that cannot be webpack'ed, 📖 -> https://webpack.js.org/configuration/externals/
    // luabundle: 'commonjs luabundle',
    'utils/getCoreNodeModule': 'commonjs getCoreNodeModule',
  },
  plugins: [
    new CopyWebpackPlugin({
      patterns: [
        // getCoreNodeModule.js -> dist/node_modules/getCoreNodeModule.js
        { from: 'utils/getCoreNodeModule.js', to: 'node_modules' },
        { from: 'language/syntaxes', to: 'syntaxes' },
        { from: '../node_modules/luabundle/bundle/runtime.lua' },
      ],
    }),
  ],
  resolve: {
    // support reading TypeScript and JavaScript files, 📖 -> https://github.com/TypeStrong/ts-loader
    extensions: ['.ts', '.js'],
    alias: {
      '@': path.resolve(__dirname),
    },
  },
  module: {
    rules: [
      {
        test: /\.ts$/,
        exclude: /node_modules/,
        use: [
          {
            loader: 'ts-loader',
          },
        ],
      },
    ],
  },
};
module.exports = config;
