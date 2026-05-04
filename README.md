# claudflare-acm-dns-federator

AWS Certificate Manager (ACM) の TLS 証明書 DNS 検証に必要な CNAME レコードを、CloudFlare で管理している DNS ゾーンへ自動で追加・更新するシステム。

証明書の新規発行・自動更新を完全に自動化し、手動での DNS 操作を不要にする。ACM から削除された証明書の検証 CNAME を CloudFlare から自動削除するクリーンアップ機能も持つ。

**対象リージョン:** ap-northeast-1 (東京)

## アーキテクチャ

```
┌───────────────────────────────────────────────────────────────┐
│ AWS                                                           │
│                                                               │
│  [ACM]                                                        │
│   ├─ RequestCertificate API (CloudTrail 経由)                 │
│   └─ Certificate Renewal Action Required (EventBridge)        │
│            ↓                                                  │
│  [EventBridge]                                                │
│   ├─ Rule: CloudTrail RequestCertificate イベント             │
│   ├─ Rule: ACM Certificate Renewal Action Required            │
│   └─ Scheduler: 日次定期実行 (06:00 JST)                      │
│            ↓                                                  │
│  [Lambda: acm-dns-federator]                                  │
│   ├─ ACM: DescribeCertificate (CNAME レコード取得)             │
│   └─ CloudFlare API: DNS レコード作成/更新/削除                 │
│            ↑                                                  │
│  [Secrets Manager]                                            │
│   └─ CloudFlare API Token                                     │
└───────────────────────────────────────────────────────────────┘
                      ↕ HTTPS
┌───────────────────────────────────────────────────────────────┐
│ CloudFlare                                                    │
│  └─ DNS Zone: CNAME レコードの追加/更新/削除                   │
└───────────────────────────────────────────────────────────────┘
```

### トリガー

| トリガー | イベント | 用途 |
|---|---|---|
| EventBridge (CloudTrail) | `RequestCertificate` | 新規証明書リクエスト時の即時対応 |
| EventBridge (ACM) | `Certificate Renewal Action Required` | 自動更新失敗時の CNAME 再追加 |
| EventBridge Scheduler | 毎日 06:00 JST | 取りこぼし防止の全件同期・不要 CNAME 削除 |

## 前提条件

- Node.js 22+
- AWS CLI (認証済み)
- AWS CDK v2
- CloudFlare API Token (`Zone:Read` + `DNS:Edit` 権限)
- CloudTrail が ap-northeast-1 で有効化されていること（トリガー 1 に必要）

## デプロイ

### 1. CDK スタックのデプロイ

```bash
cd cdk
npm install
npx cdk bootstrap   # 初回のみ
npx cdk deploy
```

デプロイ完了後、出力に `CloudFlareApiTokenSecretArn` が表示される。

### 2. CloudFlare API Token の設定

```bash
aws secretsmanager put-secret-value \
  --secret-id acm-dns-federator/cloudflare-api-token \
  --secret-string '{"token":"YOUR_CLOUDFLARE_API_TOKEN"}'
```

以上でセットアップ完了。以降は ACM で証明書をリクエストすると自動的に CloudFlare へ CNAME レコードが追加される。

### スタックの削除

```bash
npx cdk destroy
```

Secrets Manager シークレットも含めてすべてのリソースが削除される。

## 開発

### テストの実行

```bash
cd lambda
npm install
npm test              # 全テスト実行
npm run test:coverage # カバレッジレポート付き
```

### 型チェック

```bash
# Lambda
cd lambda && npm run typecheck

# CDK
cd cdk && npm run typecheck
```

## コスト (ap-northeast-1 / 月)

| サービス | 料金 |
|---|---|
| Lambda | $0.00 (無料枠内) |
| EventBridge | $0.00 (AWS サービスイベントは無料) |
| Secrets Manager | $0.40 (1 シークレット) |
| CloudWatch Logs | $0.00 (無料枠内) |
| **合計** | **~$0.40/月** |

## 詳細仕様

[spec/SPEC.md](spec/SPEC.md) を参照。
