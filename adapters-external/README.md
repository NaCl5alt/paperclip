# adapters-external

Paperclip の「外部アダプタ」（Settings → Adapters → Install adapter）として入れるアダプタを置く。
pnpm のワークスペースには含めない（各アダプタは自分の `package-lock.json` で `npm ci` する）ので、本体の依存関係やビルドに影響しない。

| ディレクトリ | type | 中身 |
|---|---|---|
| `agy-local/` | `agy_local` | Antigravity CLI（`agy`）で動くエージェント。Gemini CLI は 2026-06-18 から個人アカウント（Google AI Pro を含む）で使えなくなったため、その代わり |

## agy-local の出どころ

- 元: [evgemar/agy-paperclip-adapter](https://github.com/evgemar/agy-paperclip-adapter) v0.2.1（コミット d18cae4・MIT ライセンス）。作者が agy 1.1.28 と macOS（arm64）で、作業フォルダへの書き込み・会話の再開・スキルの読み込みまで実機で確認している
- 取り込んだ変更: [To0wnn/agy-paperclip-adapter](https://github.com/To0wnn/agy-paperclip-adapter)（コミット 090ec49）の `src/skills.ts` と、そのテスト1件。Paperclip がスキル名に付けるハッシュ（例 `skill--7b03de82a7`）を外す修正で、外さないと agy がスキルを読まない
- 取り込んでいないもの: To0wnn 版の sandbox（Bubblewrap）。Linux 専用で、Mac では動かない
- 確認したこと（2026-10-01）: `npm ci` → `npm run build` → テスト58件が成功。Paperclip の plugin-loader と同じ手順で読み込み、`createServerAdapter()` が `agy_local` を返すことを確認。コードを読んで、ネットワークへの送信が無いこと、起動する外部コマンドが `agy` だけであること、書き込むのはスキルのシンボリックリンク（`~/.agy-paperclip/agents/<エージェントID>/` の下。`skillsScope: global` のときは `~/.gemini/config/skills`）だけであることを確認

導入の手順は `agy-local/SETUP.ja.md`。
