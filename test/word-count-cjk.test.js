"use strict";
// issue-spor-prompt-context-word-count-undercounts-cjk
require("./helpers/tmp-cleanup");
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const eng = path.join(__dirname, "..", "scripts", "engines");
const u = require(path.join(eng, "util.js"));
const { isContinuationPrompt } = require(path.join(eng, "prompt-context.js"));

test("wordCount segments unspaced scripts and leaves spaced text alone", () => {
  assert.equal(u.wordCount("hello there world"), 3);
  assert.equal(u.wordCount("  "), 0);
  assert.ok(u.wordCount("请帮我修改这个登录页面的样式问题") >= 6);
  assert.ok(u.wordCount("東京で会議の準備をしてください") >= 6);
  assert.equal(u.wordCount("！！！"), 1);
});

test("isContinuationPrompt never treats unspaced-script text as a bare ASCII continuation", () => {
  assert.equal(isContinuationPrompt("continue"), true);
  assert.equal(isContinuationPrompt("continue 请继续"), false);
});
