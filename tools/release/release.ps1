<#
.SYNOPSIS
  version バンプから提出用 zip までを一発で通す（CLAUDE.md「本番リリース」節の実体）。

.DESCRIPTION
  master が green な状態から Chrome ウェブストア提出物を作るまでを 1 コマンドにまとめる:
    1. 前提チェック（ブランチ / 作業ツリー / origin 同期 / master の CI / .env）
    2. version バンプ（src/manifest.json + package.json + package-lock.json の 3 箇所）
    3. バンプ commit（ローカル）
    4. npm run build（production）
    5. tools/release/pack.ps1（key 不在の確認・zip 化・検証）
    6. origin/master へ push

  version バンプは差分が version 文字列だけで、直前の master は CI green
  （手順 1 で機械チェックする。ただし本リポジトリの workflow は公開ページのデプロイ
  （deploy-pages.yml）だけで、テストの CI は未配置。green でもテスト通過は意味しない）。
  そのため PR / CI 待ちを挟まず master へ直接コミットする
  ＝ CLAUDE.md 作業原則 1（master で直接作業しない）の明示的な例外。
  機能変更をこのスクリプトで master へ持ち込んではいけない（作業ツリーが汚れていれば止まる）。

  build / pack が失敗した場合、push はまだ実行されていないので origin は無傷。
  ローカルのバンプ commit だけが残るので `git reset --hard HEAD~1` で戻せる（差分は version のみ）。

.PARAMETER Bump
  major / minor / patch のいずれか、または明示の version（例 0.7.3）。
    major: 0.6.0 -> 1.0.0 ／ minor: 0.6.0 -> 0.7.0 ／ patch: 0.6.0 -> 0.6.1

.PARAMETER NoPush
  push を行わない（ローカル commit までで止める）。zip は作る。

.PARAMETER SkipCiCheck
  master の CI 状態チェック（gh run list）を省略する。gh が無い環境や、CI 結果を待たずに作る場合。
  `hosted/**` を変えた直後は公開ページのデプロイ（deploy-pages.yml）が実行中で停止することがあるので、
  デプロイ完了を待てないときの逃げ道にもなる。

.PARAMETER Force
  前提チェックの警告（master 以外のブランチ / origin と不一致 / CI が green でない）を
  停止ではなく警告に落とす。作業ツリーが汚れている場合の停止だけは解除しない。

.PARAMETER IncludeKeyPem
  zip へ key.pem を同梱する（初回アップロード専用）。

.EXAMPLE
  npm run release -- minor      # 機能追加を含むリリース
  npm run release -- patch      # 修正のみのリリース
  npm run release -- 1.0.0      # version を明示
#>
[CmdletBinding()]
param(
  [Parameter(Position = 0, Mandatory = $true)]
  [string]$Bump,
  [switch]$NoPush,
  [switch]$SkipCiCheck,
  [switch]$Force,
  [switch]$IncludeKeyPem
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# 本スクリプトの進捗・検証メッセージは日本語なので、出力を UTF-8 に固定する。
# Windows のコンソール既定は CP932 で、明示しないと npm 経由やパイプ越しの実行で化ける
# （移植時に実際に化けた）。リダイレクト先によっては設定できないので失敗は無視する。
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }

# 外部コマンドの成否は $LASTEXITCODE の明示チェックだけで判定する
# （PowerShell 7.4+ の既定では非 0 終了が例外化し、try/catch の無い箇所で唐突に落ちるため）
$PSNativeCommandUseErrorActionPreference = $false

function Stop-WithError([string]$message) {
  Write-Host "NG  $message" -ForegroundColor Red
  exit 1
}
function Write-Ok([string]$message) {
  Write-Host "OK  $message" -ForegroundColor Green
}
function Write-Warn([string]$message) {
  Write-Host "WARN  $message" -ForegroundColor Yellow
}
# -Force で警告に落とす種類の停止
function Stop-Unless-Force([string]$message) {
  if ($Force) { Write-Warn "$message（-Force のため続行）" } else { Stop-WithError "$message（承知の上なら -Force）" }
}

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$manifestPath = Join-Path $repoRoot 'src\manifest.json'
$targetBranch = 'master'
Set-Location $repoRoot

# ---------------------------------------------------------------------------
# 1. 前提チェック
# ---------------------------------------------------------------------------
Write-Host '=== 1. 前提チェック ===' -ForegroundColor Cyan

$branch = (git rev-parse --abbrev-ref HEAD).Trim()
if ($branch -ne $targetBranch) {
  Stop-Unless-Force "現在のブランチが $targetBranch ではありません（$branch）"
} else {
  Write-Ok "ブランチ = $targetBranch"
}

# サブモジュールの作業ツリーの汚れ（ビルド生成物等）は提出物に影響しないので無視する
$dirty = @(git status --porcelain --ignore-submodules=dirty | Where-Object { $_ -ne '' })
if ($dirty.Count -gt 0) {
  Write-Host ($dirty -join "`n") -ForegroundColor DarkGray
  # ここは -Force でも解除しない: 未コミットの変更が混ざった zip を提出させないため
  Stop-WithError '作業ツリーが汚れています。commit / stash してから再実行してください（前回の失敗で version 編集が残っている場合は `git checkout -- src/manifest.json package.json package-lock.json`）'
}
Write-Ok '作業ツリーはクリーン'

git fetch origin $targetBranch --quiet
$headSha = (git rev-parse HEAD).Trim()
$remoteSha = (git rev-parse "origin/$targetBranch").Trim()
if ($headSha -ne $remoteSha) {
  Stop-Unless-Force "ローカル $targetBranch が origin/$targetBranch と一致しません（未 push / 要 pull）"
} else {
  Write-Ok "origin/$targetBranch と同期済み（$($headSha.Substring(0, 7))）"
}

if ($SkipCiCheck) {
  Write-Warn 'CI 状態チェックを省略（-SkipCiCheck）'
} else {
  # ワークフローが無ければ gh を呼んでも判定材料が無いので、呼ばずに素通りさせる。
  # 現状の workflow は公開ページのデプロイ（deploy-pages.yml）のみで、hosted/** を変えたときだけ発火する。
  # version バンプ commit では発火しないため、多くの場合は「run が見つかりません」の警告で通る
  $workflowsDir = Join-Path $repoRoot '.github\workflows'
  $hasWorkflows = (Test-Path $workflowsDir) -and (@(Get-ChildItem $workflowsDir -File -ErrorAction SilentlyContinue).Count -gt 0)
  if (-not $hasWorkflows) {
    Write-Warn 'CI 未配置のためスキップ（.github/workflows が無い）'
  } else {
    # gh が無い / 未認証でもリリース自体は止めない（警告に留める）
    $runsJson = $null
    try {
      # --json のフィールド列挙は 1 引数のまま渡す（`headSha, status` のようにスペースを挟むと
      # PowerShell が配列 → 別引数に展開し、gh が `unknown command "status,"` で常に失敗 =
      # CI チェックが WARN スキップに退化する）
      $runsJson = gh run list --branch $targetBranch --limit 30 --json 'headSha,status,conclusion,workflowName' 2>$null
      if ($LASTEXITCODE -ne 0) { $runsJson = $null }
    } catch {
      $runsJson = $null
    }
    if (-not $runsJson) {
      Write-Warn 'CI 状態を取得できませんでした（gh 未導入 / 未認証）。手動で確認してください'
    } else {
      $runs = @($runsJson | ConvertFrom-Json | Where-Object { $_.headSha -eq $remoteSha })
      if ($runs.Count -eq 0) {
        Write-Warn "origin/$targetBranch の HEAD に対する CI run が見つかりません（未起動 / 保持期間切れ）"
      } else {
        $running = @($runs | Where-Object { $_.status -ne 'completed' })
        $failed = @($runs | Where-Object { $_.status -eq 'completed' -and $_.conclusion -notin @('success', 'skipped') })
        if ($failed.Count -gt 0) {
          Stop-Unless-Force "master の CI が失敗しています: $(($failed | ForEach-Object { "$($_.workflowName)=$($_.conclusion)" }) -join ', ')"
        } elseif ($running.Count -gt 0) {
          Stop-Unless-Force "master の CI がまだ実行中です: $(($running | ForEach-Object { "$($_.workflowName)=$($_.status)" }) -join ', ')"
        } else {
          Write-Ok "master の CI green（$(($runs | ForEach-Object { $_.workflowName }) -join ' / ')）"
        }
      }
    }
  }
}

# 本番ビルドは .env の OAUTH_CLIENT_ID のみを読む（LOCAL_OAUTH_CLIENT_ID は dev 優先用）。
# webpack も未設定ならエラーで止まるが、バンプ前にここで落としたほうが後始末が要らない
$envPath = Join-Path $repoRoot '.env'
if (-not (Test-Path $envPath) -or -not (Select-String -Path $envPath -Pattern '^OAUTH_CLIENT_ID=.' -Quiet)) {
  Stop-WithError '.env に OAUTH_CLIENT_ID がありません（本番ビルドが停止します）'
}
Write-Ok '.env の OAUTH_CLIENT_ID を確認'

# ---------------------------------------------------------------------------
# 2. version バンプ
# ---------------------------------------------------------------------------
Write-Host '=== 2. version バンプ ===' -ForegroundColor Cyan

$manifestRaw = Get-Content $manifestPath -Raw
# manifest は手書き JSON（トップレベルのインデントは半角 2 個）。
# ConvertTo-Json での再シリアライズはキー順や配列を壊しうるので、version の値だけを差し替える
$versionLinePattern = '(?m)^  "version": "(?<version>[^"]+)"'
$versionMatches = [regex]::Matches($manifestRaw, $versionLinePattern)
if ($versionMatches.Count -ne 1) {
  Stop-WithError "src/manifest.json の version 行を一意に特定できません（該当 $($versionMatches.Count) 件）"
}
$versionGroup = $versionMatches[0].Groups['version']
$current = $versionGroup.Value

if ($Bump -match '^\d+\.\d+\.\d+$') {
  $next = $Bump
} else {
  $parts = $current -split '\.'
  if ($parts.Count -ne 3) {
    Stop-WithError "現在の version がセマンティックバージョンではありません: $current"
  }
  $major = [int]$parts[0]; $minor = [int]$parts[1]; $patch = [int]$parts[2]
  switch ($Bump.ToLowerInvariant()) {
    'major' { $next = "$($major + 1).0.0" }
    'minor' { $next = "$major.$($minor + 1).0" }
    'patch' { $next = "$major.$minor.$($patch + 1)" }
    default { Stop-WithError "Bump には major / minor / patch または x.y.z を指定してください（指定値: $Bump）" }
  }
}

# Store は同じ version の再アップロードを拒否するので、必ず前進させる
$currentVersionObj = [version]$current
$nextVersionObj = [version]$next
if ($nextVersionObj -le $currentVersionObj) {
  Stop-WithError "新しい version ($next) が現在の version ($current) 以下です"
}

# package.json / package-lock.json は npm に更新させる（lock の packages."" まで揃う）
npm version $next --no-git-tag-version --allow-same-version | Out-Null
if ($LASTEXITCODE -ne 0) {
  Stop-WithError 'npm version が失敗しました'
}
# manifest は version の値だけを差し替える（他バイトは元のまま）
$bumpedRaw = $manifestRaw.Remove($versionGroup.Index, $versionGroup.Length).Insert($versionGroup.Index, $next)
Set-Content $manifestPath -Value $bumpedRaw -Encoding utf8NoBOM -NoNewline
Write-Ok "version $current -> $next（manifest / package.json / package-lock.json）"

# ---------------------------------------------------------------------------
# 3. バンプ commit（ローカル）
# ---------------------------------------------------------------------------
Write-Host '=== 3. バンプ commit ===' -ForegroundColor Cyan

git add src/manifest.json package.json package-lock.json
git commit --quiet -m "chore: リリース v$next へ version をバンプ"
if ($LASTEXITCODE -ne 0) {
  Stop-WithError 'git commit が失敗しました'
}
Write-Ok "commit 作成（未 push。失敗時は ``git reset --hard HEAD~1`` で戻せる）"

# ---------------------------------------------------------------------------
# 4. 本番ビルド
# ---------------------------------------------------------------------------
Write-Host '=== 4. 本番ビルド（npm run build）===' -ForegroundColor Cyan

# 2>&1 で拾う webpack の出力は ErrorRecord 混じりなので、EAP を落として文字列化する
$prevEap = $ErrorActionPreference
$ErrorActionPreference = 'Continue'
$buildLog = @(npm run build 2>&1 | ForEach-Object { $_.ToString() })
$buildExitCode = $LASTEXITCODE
$ErrorActionPreference = $prevEap
$buildFailed = $buildExitCode -ne 0
# webpack は ERROR があっても環境によっては 0 で抜けうるので出力側も見る
$buildErrors = @($buildLog | Where-Object { $_ -match '^ERROR' })
if ($buildFailed -or $buildErrors.Count -gt 0) {
  Write-Host ($buildLog | Select-Object -Last 30 | Out-String) -ForegroundColor DarkGray
  Stop-WithError 'ビルドに失敗しました（バンプ commit は未 push。`git reset --hard HEAD~1` で戻せます）'
}
# webpack のバンドルサイズ performance 警告（サイズ超過）のみは既知として許容し、それ以外は見せる
$unexpectedWarnings = @($buildLog | Where-Object { $_ -match '^WARNING' -and $_ -notmatch 'size limit' })
if ($unexpectedWarnings.Count -gt 0) {
  Write-Warn "想定外の警告があります:`n$($unexpectedWarnings -join "`n")"
}
Write-Ok 'ビルド成功'

# ---------------------------------------------------------------------------
# 5. パッケージング + 検証
# ---------------------------------------------------------------------------
Write-Host '=== 5. パッケージング（pack.ps1）===' -ForegroundColor Cyan

$packArgs = @('-NoProfile', '-File', (Join-Path $PSScriptRoot 'pack.ps1'))
if ($IncludeKeyPem) { $packArgs += '-IncludeKeyPem' }
& pwsh @packArgs
if ($LASTEXITCODE -ne 0) {
  Stop-WithError 'パッケージングの検証に失敗しました（バンプ commit は未 push。`git reset --hard HEAD~1` で戻せます）'
}

# ---------------------------------------------------------------------------
# 6. push
# ---------------------------------------------------------------------------
Write-Host '=== 6. push ===' -ForegroundColor Cyan

if ($NoPush) {
  Write-Warn "-NoPush のため push しません（後で ``git push origin $targetBranch``）"
} else {
  git push origin "HEAD:$targetBranch"
  if ($LASTEXITCODE -ne 0) {
    Stop-WithError "push に失敗しました。zip は出来ています。origin の更新を取り込んでから ``git push origin HEAD:$targetBranch`` を手動で実行してください"
  }
  Write-Ok "origin/$targetBranch へ push"
}

$zipPath = Join-Path $repoRoot "release\sr-query-builder-plugin-$next.zip"
Write-Host ''
Write-Host "提出用 zip: $zipPath" -ForegroundColor Cyan
Write-Host '次: https://chrome.google.com/webstore/devconsole でアップロード → 審査へ提出'
