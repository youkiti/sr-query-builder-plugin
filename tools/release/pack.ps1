<#
.SYNOPSIS
  Chrome ウェブストア提出用 zip を dist/ から作成する（CLAUDE.md「本番リリース」節の実体）。

.DESCRIPTION
  `npm run build` 済みの dist/ を入力として、以下を一括で行う:
    1. 事前検証（本番ビルドか・version・oauth2 セクション存在・client_id 注入済み）
    2. release/ 内の過去 zip をすべて削除（提出用・過去バージョンとも。手元に残す意味がないため）
    3. dist/ をステージングし、manifest から `key` フィールドが既に無いことを確認する
       （本リポジトリでは webpack.config.js の CopyPlugin transform が production ビルド時に
       自分で `delete manifest.key` する。Store は key を持つ manifest を拒否するため）
    4. release/sr-query-builder-plugin-<version>.zip を作成
    5. 作成した zip を展開し直して検証（NG なら非 0 終了。壊れた提出物を作らせない）

  `src/manifest.json` の `key` は dev（未パック読込）で拡張 ID を固定するために必須なので削除しない。
  production dist からの除去は webpack の責務であり、このスクリプトは「除去されたこと」を確認するだけ
  （DE plugin 版のような key 行の正規表現除去はここでは行わない）。

.PARAMETER IncludeKeyPem
  zip ルートへ key.pem を同梱する。**初回アップロードのときだけ** 指定する。

.PARAMETER KeyPemPath
  IncludeKeyPem 指定時に同梱する秘密鍵のパス。既定はリポジトリルートの key.pem（gitignore 対象）。

.EXAMPLE
  npm run build
  npm run pack:release
#>
[CmdletBinding()]
param(
  [switch]$IncludeKeyPem,
  [string]$KeyPemPath = (Join-Path $PSScriptRoot '..\..\key.pem')
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# 本スクリプトの進捗・検証メッセージは日本語なので、出力を UTF-8 に固定する。
# Windows のコンソール既定は CP932 で、明示しないと npm 経由やパイプ越しの実行で化ける
# （移植時に実際に化けた）。リダイレクト先によっては設定できないので失敗は無視する。
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }

# 検証 NG は「壊れた提出物を作らない」ための停止なので、必ず非 0 で終える
function Stop-WithError([string]$message) {
  Write-Host "NG  $message" -ForegroundColor Red
  exit 1
}
function Write-Ok([string]$message) {
  Write-Host "OK  $message" -ForegroundColor Green
}

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$distDir = Join-Path $repoRoot 'dist'
$releaseDir = Join-Path $repoRoot 'release'
$stageDir = Join-Path $releaseDir 'stage'
$verifyDir = Join-Path $releaseDir '_verify'
$distManifestPath = Join-Path $distDir 'manifest.json'

# zip に必ず入っていること（本リポジトリの構成物一式。PDF.js 等の特殊資産は無い）
$requiredEntries = @(
  'manifest.json',
  'background/service-worker.js',
  'app/app.html',
  'popup/popup.html',
  'options/options.html',
  'icons/icon16.png',
  'icons/icon48.png',
  'icons/icon128.png',
  '_locales/ja/messages.json',
  '_locales/en/messages.json',
  'styles'
)

# ---------------------------------------------------------------------------
# 1. 事前検証（dist/）
# ---------------------------------------------------------------------------
Write-Host '=== 1. dist/ の事前検証 ===' -ForegroundColor Cyan

if (-not (Test-Path $distManifestPath)) {
  Stop-WithError "dist/manifest.json がありません。先に ``npm run build`` を実行してください"
}

$distManifestRaw = Get-Content $distManifestPath -Raw
$distManifest = $distManifestRaw | ConvertFrom-Json

# 本リポジトリの manifest.json の "name" は常に "__MSG_extName__"（_locales 参照のプレースホルダ）
# のままで、webpack はここへ dev/production の別を書き込まない。dev/production の見分けは
# webpack.config.js の _locales transform が付与する「(dev)」サフィックスであり、
# それは _locales/*/messages.json の extName.message 側に入る（DE plugin のように
# manifest.json の name を直接書き換える方式ではないので、name を見るチェックは常に false になり無意味）
$distLocaleJaPath = Join-Path $distDir '_locales\ja\messages.json'
if (-not (Test-Path $distLocaleJaPath)) {
  Stop-WithError 'dist/_locales/ja/messages.json がありません'
}
$distExtName = (Get-Content $distLocaleJaPath -Raw | ConvertFrom-Json).extName.message
if ($distExtName -match '\(dev\)') {
  Stop-WithError "dist が dev ビルドです（拡張名 = '$distExtName'）。``npm run build``（production）で作り直してください"
}
Write-Ok "本番ビルド（拡張名 = '$distExtName'）"

$version = $distManifest.version
if ([string]::IsNullOrWhiteSpace($version)) {
  Stop-WithError 'manifest に version がありません'
}

# version は manifest / package.json / package-lock.json の 3 箇所を揃える運用。
# manifest だけバンプして他を忘れる事故があったため機械チェックする
foreach ($file in @('package.json', 'package-lock.json')) {
  # package-lock.json は packages に "" キーを持つので -AsHashtable でないと解釈できない
  $otherVersion = (Get-Content (Join-Path $repoRoot $file) -Raw | ConvertFrom-Json -AsHashtable).version
  if ($otherVersion -ne $version) {
    Stop-WithError "$file の version ($otherVersion) が manifest ($version) と一致しません。3 箇所を揃えてください（package-lock は ``npm install --package-lock-only``）"
  }
}
Write-Ok "version = $version（manifest / package.json / package-lock.json が一致）"

# 本リポジトリは manifest ベースの oauth2 + chrome.identity を使う構成（launchWebAuthFlow は不採用）。
# セクションが無いのは異常系なので止める
if ($distManifest.PSObject.Properties.Name -notcontains 'oauth2') {
  Stop-WithError 'manifest に oauth2 セクションがありません（webpack.config.js の manifest transform を確認してください）'
}
Write-Ok 'oauth2 セクションあり'

# client_id は webpack.config.js の CopyPlugin transform が manifest.oauth2.client_id へ直接注入する
# （DE plugin のような DefinePlugin 経由の JS 注入ではない）。dist/manifest.json を直接見れば足りる
$clientId = $distManifest.oauth2.client_id
if ([string]::IsNullOrWhiteSpace($clientId) -or $clientId -eq '__OAUTH_CLIENT_ID__') {
  Stop-WithError 'manifest の oauth2.client_id が未設定です（.env の OAUTH_CLIENT_ID を確認してください）'
}
Write-Ok 'client_id 注入済み（プレースホルダ残存なし）'

# ---------------------------------------------------------------------------
# 2. 過去ビルドの削除
# ---------------------------------------------------------------------------
Write-Host '=== 2. release/ の過去 zip を削除 ===' -ForegroundColor Cyan

New-Item -ItemType Directory -Force $releaseDir | Out-Null
foreach ($stale in @($stageDir, $verifyDir)) {
  if (Test-Path $stale) { Remove-Item $stale -Recurse -Force }
}
$oldZips = @(Get-ChildItem $releaseDir -Filter *.zip -File)
if ($oldZips.Count -gt 0) {
  foreach ($old in $oldZips) {
    Remove-Item $old.FullName -Force
    Write-Host "    削除: $($old.Name)"
  }
  Write-Ok "過去 zip $($oldZips.Count) 件を削除"
} else {
  Write-Ok '削除対象の過去 zip なし'
}

# ---------------------------------------------------------------------------
# 3. ステージング + key 不在の確認
# ---------------------------------------------------------------------------
Write-Host '=== 3. ステージングと key 確認 ===' -ForegroundColor Cyan

Copy-Item $distDir $stageDir -Recurse

# DE plugin 版は key 行を正規表現で除去する責務を pack.ps1 側に持たせていたが、
# 本リポジトリでは webpack.config.js の CopyPlugin transform が production ビルド時に
# 自分で `delete manifest.key` する（dist/manifest.json は最初から key を持たないのが正常形）。
# よってここでの役割は「除去されたこと」のアサーションのみ。key が残っていたら
# webpack 側の回帰なので、黙って削るのではなく止めて調査を促す
if ($distManifest.PSObject.Properties.Name -contains 'key') {
  Stop-WithError 'dist/manifest.json に key フィールドが残っています（webpack.config.js の production 分岐に回帰がないか確認してください。本スクリプトは key の除去は行いません）'
}
Write-Ok 'key フィールドは元から不在（webpack が production ビルド時に除去済み）'

if ($IncludeKeyPem) {
  # 初回アップロード専用。Store に同じ拡張 ID を導出させるため
  if (-not (Test-Path $KeyPemPath)) {
    Stop-WithError "key.pem が見つかりません: $KeyPemPath"
  }
  Copy-Item $KeyPemPath (Join-Path $stageDir 'key.pem')
  Write-Host 'WARN  key.pem を同梱しました（初回アップロード用。更新提出では不要）' -ForegroundColor Yellow
}

# ---------------------------------------------------------------------------
# 4. zip 化
# ---------------------------------------------------------------------------
Write-Host '=== 4. zip 化 ===' -ForegroundColor Cyan

$zipPath = Join-Path $releaseDir "sr-query-builder-plugin-$version.zip"
Compress-Archive -Path (Join-Path $stageDir '*') -DestinationPath $zipPath
Remove-Item $stageDir -Recurse -Force
Write-Ok "作成: $(Split-Path $zipPath -Leaf) ($([math]::Round((Get-Item $zipPath).Length / 1MB, 2)) MB)"

# ---------------------------------------------------------------------------
# 5. zip の検証（展開し直して確認する）
# ---------------------------------------------------------------------------
Write-Host '=== 5. zip の検証 ===' -ForegroundColor Cyan

Expand-Archive $zipPath -DestinationPath $verifyDir
try {
  $zipManifestPath = Join-Path $verifyDir 'manifest.json'
  if (-not (Test-Path $zipManifestPath)) {
    Stop-WithError 'manifest.json が zip のルートにありません（dist/ ごと入れ子になっている可能性）'
  }
  Write-Ok 'manifest.json が zip のルートにある'

  $zipManifest = Get-Content $zipManifestPath -Raw | ConvertFrom-Json
  if ($zipManifest.PSObject.Properties.Name -contains 'key') {
    Stop-WithError 'zip の manifest に key フィールドが残っています（Store が拒否します）'
  }
  Write-Ok 'manifest に key フィールドなし'

  # zip 化の過程で manifest を一切書き換えていないので、dist と完全一致するはず（破損検知）
  $expected = $distManifest | ConvertTo-Json -Depth 20 -Compress
  $actual = $zipManifest | ConvertTo-Json -Depth 20 -Compress
  if ($expected -ne $actual) {
    Stop-WithError 'zip の manifest が dist と一致しません（zip 化の過程で破損した可能性）'
  }
  Write-Ok 'manifest が dist と完全一致（permissions / host_permissions / oauth2 等）'

  # 手順 1 と同じ観点（oauth2 セクション存在・client_id 注入済み）を、展開し直した zip 側でも確認する
  if ($zipManifest.PSObject.Properties.Name -notcontains 'oauth2') {
    Stop-WithError 'zip の manifest に oauth2 セクションがありません'
  }
  $zipClientId = $zipManifest.oauth2.client_id
  if ([string]::IsNullOrWhiteSpace($zipClientId) -or $zipClientId -eq '__OAUTH_CLIENT_ID__') {
    Stop-WithError 'zip の manifest の oauth2.client_id が未設定です'
  }
  Write-Ok 'zip 内も client_id 注入済み（プレースホルダ残存なし）'

  $keyPemInZip = Test-Path (Join-Path $verifyDir 'key.pem')
  if ($IncludeKeyPem -and -not $keyPemInZip) {
    Stop-WithError 'IncludeKeyPem 指定なのに zip へ key.pem が入っていません'
  }
  if (-not $IncludeKeyPem -and $keyPemInZip) {
    Stop-WithError 'key.pem が zip に混入しています（更新提出では同梱しない）'
  }
  Write-Ok ($IncludeKeyPem ? 'key.pem 同梱を確認（初回アップロード用）' : 'key.pem 未同梱（更新提出の正常形）')

  $missing = $requiredEntries | Where-Object { -not (Test-Path (Join-Path $verifyDir $_)) }
  if ($missing) {
    Stop-WithError "zip に同梱漏れがあります: $($missing -join ', ')"
  }
  Write-Ok "同梱物を確認（$($requiredEntries -join ' / ')）"
} finally {
  if (Test-Path $verifyDir) { Remove-Item $verifyDir -Recurse -Force }
}

Write-Host ''
Write-Host "提出用 zip: $zipPath" -ForegroundColor Cyan
Write-Host '次: Chrome ウェブストア デベロッパー ダッシュボードへアップロード（docs/store/README.md 参照）'
