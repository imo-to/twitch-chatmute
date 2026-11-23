# Twitch Chat mute +

Twitchのチャットで、ユーザーをワンクリックでミュートできるツールです。ミュートした人のコメントは一緒に消えます。
おまけ機能：NGワード / 繰り返しコメントの非表示 / ニコニコ風弾幕 / チャンネルポイントのボーナス自動回収 など

**公式のブロックとの違い**
公式ブロックは「ユーザー名をクリック → 三点リーダー → ブロック」の3クリックが必要で、ブロックしてもその人のコメントはチャットに残ります。このツールはワンクリックでミュートできてコメントも一緒に消え、ミュートしたユーザーをあとからまとめてブロックに追加することもできます。

## ダウンロード（クリックですぐ落ちます）

- [ユーザースクリプト版（Tampermonkey用）](https://github.com/imo-to/twitch-chatmute/releases/download/v1.1/twitch_chatmute.user.js)
- [拡張機能版（Chrome / Edge用zip）](https://github.com/imo-to/twitch-chatmute/releases/download/v1.1/twitch-chatmute-extension-v1.1.zip)
- [共有ミュートリスト（2,251人分・ユーザー名のみ）](https://github.com/imo-to/twitch-chatmute/releases/download/v1.1/mute-list_share_2026-11-24.json)

## 入れ方

ユーザースクリプト版：
1. Tampermonkeyをブラウザに入れる
2. 上のリンクをクリック（Tampermonkeyの画面が開きます）
3. 「インストール」を押して終わり

拡張機能版：
1. zipをダウンロードして解凍する
2. Chromeで chrome://extensions を開き、右上の「デベロッパーモード」をONにする
3. 「パッケージ化されていない拡張機能を読み込む」で、解凍したフォルダを選ぶ

## 共有ミュートリストの使い方

荒らし行為や連投を行ったユーザーをまとめたリストです。
パネルの「復元」から、ダウンロードしたJSONファイルを選ぶと取り込めます。
