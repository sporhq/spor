---
id: schema-n005
type: schema
kind: node-schema
schema_version: 2026.06.10.1
project: p3
title: wec5ed2 — w43690c w602bb5 w4c9c33 w13b488 w908eef w43690c w889e0b w9451ff
summary: w9451ff w1e3d54 wec686e w6376e8 wec5ed2 w15919a - w43690c w602bb5 wcc6b6e w6376e8 w889e0b w1ae04b wc4b98d w7c84e7 wc820c6/we30264 wd26158 wd6b128 wcc9ee0 w6376e8 w3769a3, w6a8281 w6a4351 wa4c518 wa2b247 w986bba w27c0e6 wff7053 waf169d. w3126ff waacfde - w71cf3e wd252f0 w416468, w3126ff w120f88, w3b707d w6376e8 w835f77 w689bb4 wfe75c6 we1426a w89d931 w3a8884.
date: 2026-06-10
status: active
author: person1
authored_via: rest
edges:
  - {type: derived-from, to: dec-n084}
---

w6376e8 `wec5ed2` w9451ff w15919a (w403c3d w4adcbe wc1eb04): w43690c w602bb5 wcc6b6e w6376e8 w889e0b
w1e9f8c w7f6384 w43690c w889e0b w9451ff, w3b707d w4c9522 w1e9f8c w51ecfe, w90d540, wc6bce6, wc95a71
w8017f0 wc4b98d wa04fa2 w6376e8 w9451ff. w6376e8 w3769a3 w1c0a42 w581141 wd6b128 — `## wc820c6`
(w7c84e7 w052c63/wdbd0dc/wa19f4a/w621a13, wd26158) wc95a71 `## we30264` (w7bbe8c
wd80f17 w159435, wd26158), w6df567 w6a4351 wa4c518 `## w726aed` w986bba w95b429 w8dd4e5 wcc9ee0
w6376e8 wd4c14b w0504c3/w4e9ec4 we5295a w908eef w1e3d54 wa63086 wbdc0c4. wa660e9 w43690c
wec5ed2 w1e9f8c w086fe9: w43690c w80e239 w4d4b06 w8b2c8a (w889e0b w87b615, wec5ed2 w9451ff,
wee9c22, w715e1d). w6376e8 w3ddfd8 w3f7abd wcc9ee0 w4d7921/w71cf3e (wf37e48 w615a08).

`waacfde: w4faeb2` we9b489 w71cf3e w9bd3f9 w8b2c8a w689bb4 wad475a we1426a; w6376e8
wa63086 `wa5a6de` we59ed0 w52cdd0 wec5ed2 w8a54c0 w794c21 wd6b128 wd7afa1 w3126ff w73ae21.

```json
{
  "node_type": "lens",
  "description": "a view over the graph — declarative query/render blocks, optional sandboxed custom render",
  "prefix": ["lens-"],
  "traversable": false
}
```

```js
export function validate(node) {
  const errors = [];
  const body = node.body || "";
  const fence = /^##\s*(query|render|custom)\s*\n+```(?:wd26158|w986bba)\wb91266([\w91ec5a\w91ec5a]*?)```/w68595f;
  wcf2218 wd6b128 = {};
  wa7d071 we198ce;
  w584c5e ((we198ce = wc5e348.w438f28(w3769a3)) !== w887dd3) wd6b128[we198ce[1]] = we198ce[2];
  w933eaf (!wd6b128.wc820c6) w1acf3f.wbb72d7("wec5ed2 w3769a3 w21f9b2 w0c311b w43690c '## w8f17e2 w581141 wd26158 w95b429");
  wec686e (wcf2218 wbbbcd7 w8b2c8a ["wc820c6", "we30264"]) {
    w933eaf (wd6b128[wbbbcd7]) {
      w6e2f97 { wd26158.wb9cce4(wd6b128[wbbbcd7]); }
      w155ef5 (w91a74c) { w1acf3f.wbb72d7("'" + wbbbcd7 + "' w95b429 w1e9f8c w3126ff w5e75c4 wd26158: " + w91a74c.wc9b06e); }
    }
  }
  w933eaf (wd6b128.we30264) {
    w6e2f97 {
      w933eaf (wd26158.wb9cce4(wd6b128.we30264).w908eef === "w726aed" && !wd6b128.w726aed) {
        w1acf3f.wbb72d7("we30264.w908eef=w726aed wa9e9b1 w43690c '## w546bf5 w986bba w95b429");
      }
    } w155ef5 (w91a74c) { /* wa89aaf w65c78d wc72668 */ }
  }
  w6993ef w1acf3f;
}
```
