# icons/

Chrome 拡張の toolbar アイコン / ストア掲載用アイコンを置くディレクトリ。

| ファイル | サイズ | 用途 |
|---|---|---|
| `icon16.png` | 16x16 | ツールバー favicon |
| `icon48.png` | 48x48 | 拡張機能管理ページ |
| `icon128.png` | 128x128 | Chrome Web Store 掲載 |

## 現状

**プレースホルダ**（単色 `#2a7f87` の塗りつぶし）。Node 一発で生成したダミーで、
ブランド性はない。Chrome Web Store 提出前に本番用アートワークに差し替えること。

再生成が必要なら、以下の Node 片をリポジトリルートで実行する：

```bash
node -e '
const fs = require("fs"), zlib = require("zlib");
function solidPng(size, r, g, b) {
  function crc32(buf){let c,t=[];for(let n=0;n<256;n++){c=n;for(let k=0;k<8;k++)c=c&1?0xedb88320^(c>>>1):c>>>1;t[n]=c;}let crc=0xffffffff;for(let i=0;i<buf.length;i++)crc=t[(crc^buf[i])&0xff]^(crc>>>8);return (crc^0xffffffff)>>>0;}
  function chunk(type,data){const l=Buffer.alloc(4);l.writeUInt32BE(data.length,0);const t=Buffer.from(type,"ascii"),c=Buffer.alloc(4);c.writeUInt32BE(crc32(Buffer.concat([t,data])),0);return Buffer.concat([l,t,data,c]);}
  const sig=Buffer.from([137,80,78,71,13,10,26,10]);
  const ihdr=Buffer.alloc(13);ihdr.writeUInt32BE(size,0);ihdr.writeUInt32BE(size,4);ihdr[8]=8;ihdr[9]=2;
  const row=Buffer.alloc(1+size*3);for(let x=0;x<size;x++){row[1+x*3]=r;row[1+x*3+1]=g;row[1+x*3+2]=b;}
  const raw=Buffer.concat(Array.from({length:size},()=>row));
  return Buffer.concat([sig,chunk("IHDR",ihdr),chunk("IDAT",zlib.deflateSync(raw)),chunk("IEND",Buffer.alloc(0))]);
}
for(const s of [16,48,128]) fs.writeFileSync(`src/icons/icon${s}.png`, solidPng(s,0x2a,0x7f,0x87));
'
```

## ビルドフロー

`webpack.config.js` の `CopyPlugin` でビルド時に `dist/icons/` へ転写される。
`src/manifest.json` の `icons` / `action.default_icon` で参照している。
