const path = require('path');
const webpack = require('webpack');
const dotenv = require('dotenv');

dotenv.config();

/**
 * Google Picker 許可ページ（hosted/picker.html）の JS を作る専用設定。
 * 拡張本体のビルド（webpack.config.js）とは出力先も入力も別なので、設定ファイルごと分けている。
 *
 * 出力先は hosted/picker.js（.gitignore 済み。生成物なので commit しない）。
 * .github/workflows/deploy-pages.yml は hosted/ をまるごと _site/ へコピーするため、
 * デプロイ前にこのビルドを走らせるだけで配信物に載る。
 *
 * 注入する 3 値はいずれも公開配信される JS に埋め込まれるため、構造上秘匿できない。
 * API キーは「HTTP リファラー制限 + API 制限（Picker API のみ）」で守る前提で、
 * GitHub 側も secrets ではなく repository variables に置く。
 */
module.exports = (env, argv) => {
  const isProduction = argv.mode === 'production';

  const pickerApiKey = process.env.PICKER_API_KEY?.trim();
  const pickerWebClientId = process.env.PICKER_WEB_CLIENT_ID?.trim();
  const gcpProjectNumber = process.env.GCP_PROJECT_NUMBER?.trim();

  // 本番（＝ GitHub Pages へ配信する成果物）は 3 つとも必須。1 つでも欠けると
  // 「ページは表示されるが Picker が開かない」という分かりにくい壊れ方をするので、
  // ビルド時に止める。開発ビルドは警告のみ（キーが無くてもページの見た目は確認できる）。
  const missing = [
    ['PICKER_API_KEY', pickerApiKey],
    ['PICKER_WEB_CLIENT_ID', pickerWebClientId],
    ['GCP_PROJECT_NUMBER', gcpProjectNumber],
  ]
    .filter(([, value]) => !value)
    .map(([name]) => name);

  if (missing.length > 0) {
    const detail = `${missing.join(' / ')} が未設定です。`;
    if (isProduction) {
      throw new Error(
        `${detail} .env（またはリポジトリ変数）に設定してから本番ビルドを実行してください。`
      );
    }
    console.warn(`[webpack:picker] ${detail} Picker は動作しませんが、ビルドは続行します。`);
  }

  return {
    entry: { picker: './src/picker/picker.ts' },
    output: {
      path: path.resolve(__dirname, 'hosted'),
      filename: '[name].js',
      // hosted/ は配信ファイルの正典（手書きの html / css / screenshots が同居する）。
      // clean: true にすると出力先ごと消すため、絶対に有効化しないこと。
      clean: false,
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
        __PICKER_API_KEY__: JSON.stringify(pickerApiKey ?? ''),
        __PICKER_WEB_CLIENT_ID__: JSON.stringify(pickerWebClientId ?? ''),
        __GCP_PROJECT_NUMBER__: JSON.stringify(gcpProjectNumber ?? ''),
        // src/lib/google/pickerUrl.ts が参照する定数。Picker ページ自身は配信 URL を
        // 使わない（自分がそのページなので）が、同じモジュールを import するため定義する。
        __PICKER_PAGE_URL__: JSON.stringify(''),
      }),
    ],
    optimization: {
      splitChunks: false,
    },
    // 公開配信するので本番はソースマップを出さない（.map を _site へ載せないため）
    devtool: isProduction ? false : 'source-map',
  };
};
