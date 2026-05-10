import test from "node:test";
import assert from "node:assert/strict";

import { parseTextForTools } from "../../src/lib/textToolParser.ts";
import { sanitizeAIOutput } from "../../src/lib/sanitize.ts";

test("parses legacy execute_command wrapper into a real read-only tool call", () => {
  const parsed = parseTextForTools([
    "我需要先查看 gdjrpg-prepare 目录。",
    "",
    "<execute_command>list_directory path=\"gdjrpg-prepare\"</execute_command>",
  ].join("\n"));

  assert.equal(parsed.toolCalls.length, 1);
  assert.equal(parsed.toolCalls[0].name, "list_directory");
  assert.deepEqual(parsed.toolCalls[0].arguments, { path: "gdjrpg-prepare" });
  assert.match(parsed.cleanText, /我需要先查看/);
  assert.doesNotMatch(parsed.cleanText, /execute_command|list_directory path=/);
});

test("parses direct legacy tool tags with inline attributes", () => {
  const parsed = parseTextForTools("<list_directory path=\"gdjrpg-prepare\"></list_directory>");

  assert.equal(parsed.toolCalls.length, 1);
  assert.equal(parsed.toolCalls[0].name, "list_directory");
  assert.deepEqual(parsed.toolCalls[0].arguments, { path: "gdjrpg-prepare" });
  assert.equal(parsed.cleanText, "");
});

test("legacy tool tags are removed from visible text after parsing and sanitizing", () => {
  const parsed = parseTextForTools([
    "我先查看一下目录内容，然后再继续整理录制大纲。",
    "",
    "<execute_command>list_directory path=\"gdjrpg-prepare\"</execute_command>",
  ].join("\n"));

  const visibleText = sanitizeAIOutput(parsed.cleanText);

  assert.equal(parsed.toolCalls.length, 1);
  assert.equal(parsed.toolCalls[0].name, "list_directory");
  assert.deepEqual(parsed.toolCalls[0].arguments, { path: "gdjrpg-prepare" });
  assert.match(visibleText, /我先查看一下目录内容/);
  assert.doesNotMatch(visibleText, /execute_command|list_directory path=/);
});

test("parses local-model function-style tool calls", () => {
  const skeleton = parseTextForTools("get_project_skeleton()");
  assert.equal(skeleton.toolCalls.length, 1);
  assert.equal(skeleton.toolCalls[0].name, "get_project_skeleton");
  assert.deepEqual(skeleton.toolCalls[0].arguments, {});
  assert.equal(skeleton.cleanText, "");

  const readFile = parseTextForTools('read_file(path="Assets/Scripts/BattleManager.cs", maxBytes=4096)');
  assert.equal(readFile.toolCalls.length, 1);
  assert.equal(readFile.toolCalls[0].name, "read_file");
  assert.deepEqual(readFile.toolCalls[0].arguments, {
    path: "Assets/Scripts/BattleManager.cs",
    maxBytes: 4096,
  });
  assert.equal(readFile.cleanText, "");
});

test("parses local-model single positional argument safely for whitelisted tools", () => {
  const parsed = parseTextForTools('list_directory("src")');
  assert.equal(parsed.toolCalls.length, 1);
  assert.equal(parsed.toolCalls[0].name, "list_directory");
  assert.deepEqual(parsed.toolCalls[0].arguments, { path: "src" });
  assert.equal(parsed.cleanText, "");
});

test("parses <tool_code> wrapper into a real tool call and strips wrapper text", () => {
  const parsed = parseTextForTools([
    "先看项目目录。",
    "<tool_code>",
    "list_directory(\"src\")",
    "</tool_code>",
  ].join("\n"));

  assert.equal(parsed.toolCalls.length, 1);
  assert.equal(parsed.toolCalls[0].name, "list_directory");
  assert.deepEqual(parsed.toolCalls[0].arguments, { path: "src" });
  assert.match(parsed.cleanText, /先看项目目录/);
  assert.doesNotMatch(parsed.cleanText, /tool_code|list_directory\(\"src\"\)/i);
});
