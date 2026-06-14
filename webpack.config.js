const path = require('path');
const webpack = require('webpack');
const CopyPlugin = require('copy-webpack-plugin');
const dotenv = require('dotenv');

dotenv.config();

module.exports = (env, argv) => {
  const isProduction = argv.mode === 'production';
  // 開発モード: LOCAL_OAUTH_CLIENT_ID → OAUTH_CLIENT_ID の順にフォールバック
  // 本番モード: OAUTH_CLIENT_ID（ストア用）を使用
  const oauthClientIdFromEnv = isProduction
    ? process.env.OAUTH_CLIENT_ID?.trim()
    : process.env.LOCAL_OAUTH_CLIENT_ID?.trim() || process.env.OAUTH_CLIENT_ID?.trim();

  if (isProduction && !oauthClientIdFromEnv) {
    throw new Error(
      'OAUTH_CLIENT_ID が未設定です。.env に OAUTH_CLIENT_ID を設定してから本番ビルドを実行してください。'
    );
  }

  return {
    entry: {
      'background/service-worker': './src/background/service-worker.ts',
      'popup/popup': './src/popup/popup.ts',
      'app/app': './src/app/app.ts',
      'options/options': './src/options/options.ts',
    },
    output: {
      path: path.resolve(__dirname, 'dist'),
      filename: '[name].js',
      clean: true,
    },
    module: {
      rules: [
        {
          test: /\.ts$/,
          use: {
            loader: 'ts-loader',
            options: {
              configFile: 'tsconfig.build.json',
            },
          },
          exclude: /node_modules/,
        },
      ],
    },
    resolve: {
      extensions: ['.ts', '.js'],
      alias: {
        '@': path.resolve(__dirname, 'src'),
      },
    },
    plugins: [
      new webpack.DefinePlugin({
        __BUILD_DATE__: JSON.stringify(new Date().toISOString().slice(0, 10)),
      }),
      new CopyPlugin({
        patterns: [
          {
            from: 'src/manifest.json',
            to: 'manifest.json',
            transform(content) {
              const manifest = JSON.parse(content.toString('utf8'));

              if (manifest.oauth2 && oauthClientIdFromEnv) {
                manifest.oauth2.client_id = oauthClientIdFromEnv;
              }

              const oauthClientId = manifest.oauth2?.client_id;
              if (!oauthClientId || oauthClientId === '__OAUTH_CLIENT_ID__') {
                console.warn('[webpack] OAUTH_CLIENT_ID が未設定です。Google 認証は動作しません。');
              }

              if (isProduction) {
                delete manifest.key;
              }
              return JSON.stringify(manifest, null, 2);
            },
          },
          { from: 'src/popup/popup.html', to: 'popup/popup.html' },
          { from: 'src/popup/popup.css', to: 'popup/popup.css' },
          { from: 'src/app/app.html', to: 'app/app.html' },
          { from: 'src/app/app.css', to: 'app/app.css' },
          { from: 'src/options/options.html', to: 'options/options.html' },
          { from: 'src/options/options.css', to: 'options/options.css' },
          { from: 'src/styles', to: 'styles' },
          {
            from: 'src/_locales',
            to: '_locales',
            // 開発ビルドでは拡張機能名に "(dev)" を付与し、ストア版と区別できるようにする
            transform(content, absoluteFilename) {
              if (isProduction || !absoluteFilename.endsWith('messages.json')) {
                return content;
              }
              const messages = JSON.parse(content.toString('utf8'));
              if (messages.extName?.message && !messages.extName.message.includes('(dev)')) {
                messages.extName.message = `${messages.extName.message} (dev)`;
              }
              return JSON.stringify(messages, null, 2);
            },
          },
        ],
      }),
    ],
    optimization: {
      splitChunks: false,
    },
    devtool: isProduction ? false : 'source-map',
  };
};
