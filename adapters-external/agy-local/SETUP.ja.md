# agy-local の導入（Mac）

Google AI Pro の枠で Paperclip のエージェントを動かすための手順。全体で約15分。

## 1. agy を使えるようにする（約5分）

1. agy が入っているか確かめる: `agy --version`。無ければ `curl -fsSL https://antigravity.google/cli/install.sh | bash`（`~/.local/bin/agy` に入る）
2. ターミナルで `agy` を1回起動し、Google AI Pro のアカウントでブラウザからサインインする（認証情報は macOS のキーチェーンに入る）
3. `agy models` でモデルの一覧が出ることを確かめる（何も出なければサインインできていない）

## 2. データの扱いを決める（約3分）

個人の Google アカウントで使う agy は、設定を変えないと入力やコードが Google の製品改善に使われうる。お客さんのコードを扱う前に必ず行う。

1. `~/.gemini/antigravity-cli/settings.json` に `"enableTelemetry": false` を入れる
2. Antigravity アプリの設定でも、データ収集をオフにする
3. `"useG1Credits"` は `false` のままにする（`true` にすると、枠を使い切ったあと有料のクレジットを使う）

## 3. Paperclip に入れる（約5分）

1. Paperclip のチェックアウトを、このブランチ（マージ後は master）に合わせる
2. `cd adapters-external/agy-local && npm ci && npm run build`
3. Paperclip の画面で Settings → Adapters → Install adapter を開き、local path に `<チェックアウト>/adapters-external/agy-local` を入れる
4. エージェントの設定で、アダプタを「Antigravity CLI (agy)」にして「Test Connection」を押す

## 知っておくこと

- agy は、作業フォルダを `--add-dir` で渡さないと別の場所（`~/.gemini/antigravity-cli/scratch/`）に書く。このアダプタは毎回渡す
- Paperclip の `timeoutSec` の少し手前で agy が自分で止まるよう、`--print-timeout` を合わせている（agy の既定は5分）
- 権限の確認には答えられないので、`--dangerously-skip-permissions` で動かす。エージェントにさせてよいことは AGENTS.md の決まりで縛る
- 費用は Google のサブスクとして記録される（API の料金は出ない）
- Node.js は 24.11 以上が推奨（作者の確認環境）。Node 22 でもビルドとテストは通った
