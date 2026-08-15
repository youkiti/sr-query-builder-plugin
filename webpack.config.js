const path = require('path');
const webpack = require('webpack');
const CopyPlugin = require('copy-webpack-plugin');
const dotenv = require('dotenv');

dotenv.config();

module.exports = (env, argv) => {
  const isProduction = argv.mode === 'production';
  // `npm run build:demo`（webpack --mode development --env demo）でのみ true。
  // OAuth・LLM・NCBI・Sheets をすべてモックする動画収録専用ビルド（video/REQUIREMENTS.md §6）。
  const isDemo = Boolean(env && env.demo);
  // 開発モード: LOCAL_OAUTH_CLIENT_ID → OAUTH_CLIENT_ID の順にフォールバック
  // 本番モード: OAUTH_CLIENT_ID（ストア用）を使用
  // デモビルドは chrome.identity 自体をモックするため OAuth client_id を使わない。
  // 未設定でも警告のみでビルドを継続する（isProduction が false のため下の throw に掛からない）。
  const oauthClientIdFromEnv = isProduction
    ? process.env.OAUTH_CLIENT_ID?.trim()
    : process.env.LOCAL_OAUTH_CLIENT_ID?.trim() || process.env.OAUTH_CLIENT_ID?.trim();

  if (isProduction && !oauthClientIdFromEnv) {
    throw new Error(
      'OAUTH_CLIENT_ID が未設定です。.env に OAUTH_CLIENT_ID を設定してから本番ビルドを実行してください。'
    );
  }

  // Google Picker 許可ページ（GitHub Pages 配信）をローカル配信して検証するための上書き口。
  // 本番ビルドでは環境変数を無視して空文字を注入する（src/lib/google/pickerUrl.ts が
  // 本番 URL へフォールバックする）。localhost をストア提出物へ焼き込む事故を構造的に防ぐため、
  // 「本番では読まない」ことを設定側で保証している。
  const pickerPageUrlOverride = isProduction ? '' : (process.env.PICKER_PAGE_URL?.trim() ?? '');

  return {
    entry: {
      // background は demo でも実物をそのまま使う（popup.html を開くだけで、
      // ネットワーク／chrome.identity に触れないため差し替え不要）。
      'background/service-worker': './src/background/service-worker.ts',
      'popup/popup': isDemo ? './src/demo/popup-entry.ts' : './src/popup/popup.ts',
      'app/app': isDemo ? './src/demo/app-entry.ts' : './src/app/app.ts',
      'options/options': isDemo ? './src/demo/options-entry.ts' : './src/options/options.ts',
    },
    // 出力先をモードで分離する: production ビルドは manifest から `key` を削除するため、
    // dev ビルド（key あり = 拡張 ID 固定）と同じ dist/ を共有すると、
    // 「unpacked で本番ビルドを読み込んだら拡張 ID がパス由来に変わり OAuth が通らない」
    // 「dev/本番が互いを上書きし、今 dist/ にあるのがどちらのビルドか分からなくなる」
    // という事故が起きる。production/demo をそれぞれ別出力先にすることで事故を防ぐ。
    output: {
      path: isDemo
        ? path.resolve(__dirname, 'dist-demo')
        : isProduction
          ? path.resolve(__dirname, 'dist-release')
          : path.resolve(__dirname, 'dist'),
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
        __PICKER_PAGE_URL__: JSON.stringify(pickerPageUrlOverride),
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
          // ビュー単位に分割した CSS 群をディレクトリごとコピーする。ファイル単位ではなく
          // ディレクトリ単位にしているのは、今後 CSS ファイルが増減しても webpack.config.js
          // を編集せずに済むようにするため（並列作業でのこのファイルの衝突を避ける狙い）。
          { from: 'src/app/styles', to: 'app/styles' },
          { from: 'src/options/options.html', to: 'options/options.html' },
          { from: 'src/options/options.css', to: 'options/options.css' },
          { from: 'src/styles', to: 'styles' },
          { from: 'src/icons', to: 'icons' },
          {
            from: 'src/_locales',
            to: '_locales',
            // 開発ビルドでは拡張機能名に "(dev)" を、デモビルドには "(demo)" を付与し、
            // ストア版・撮影用ビルドと見分けられるようにする。
            transform(content, absoluteFilename) {
              if (isProduction || !absoluteFilename.endsWith('messages.json')) {
                return content;
              }
              const messages = JSON.parse(content.toString('utf8'));
              const suffix = isDemo ? '(demo)' : '(dev)';
              if (messages.extName?.message && !messages.extName.message.includes(suffix)) {
                messages.extName.message = `${messages.extName.message} ${suffix}`;
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
