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

test("parses local-model knowledge search calls", () => {
  const parsed = parseTextForTools('knowledge_search("Unity Rigidbody AddForce")');
  assert.equal(parsed.toolCalls.length, 1);
  assert.equal(parsed.toolCalls[0].name, "knowledge_search");
  assert.deepEqual(parsed.toolCalls[0].arguments, { query: "Unity Rigidbody AddForce" });
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

test("recovers malformed tool_use with tool name in a parameter", () => {
  const parsed = parseTextForTools([
    "<tool_use>",
    "<parameter name=\"path\">/Users/michael/Desktop/DataFiles/cn_tutorial_orders_by_creator_20260512.csv</parameter>",
    "<parameter name=\"query\">SELECT DISTINCT \"课程名称\" FROM \"cn_tutorial_orders_by_creator_20260512.csv\" LIMIT 20</parameter>",
    "<parameter name=\"tool\">query_tabular_document</parameter>",
    "</tool_use>",
  ].join("\n"));

  assert.equal(parsed.toolCalls.length, 1);
  assert.equal(parsed.toolCalls[0].name, "query_tabular_document");
  assert.deepEqual(parsed.toolCalls[0].arguments, {
    path: "/Users/michael/Desktop/DataFiles/cn_tutorial_orders_by_creator_20260512.csv",
    query: "SELECT DISTINCT \"课程名称\" FROM \"cn_tutorial_orders_by_creator_20260512.csv\" LIMIT 20",
  });
  assert.equal("tool" in parsed.toolCalls[0].arguments, false);
  assert.equal(parsed.cleanText, "");
});

test("strips tool name recovery fields from XML execution arguments", () => {
  const parsed = parseTextForTools([
    "<tool_use>",
    "<tool>query_tabular_document</tool>",
    "<parameter name=\"tool\">query_tabular_document</parameter>",
    "<parameter name=\"name\">query_tabular_document</parameter>",
    "<parameter name=\"function\">query_tabular_document</parameter>",
    "<parameter name=\"path\">orders.csv</parameter>",
    "<parameter name=\"query\">SELECT COUNT(*) FROM orders</parameter>",
    "</tool_use>",
  ].join("\n"));

  assert.equal(parsed.toolCalls.length, 1);
  assert.equal(parsed.toolCalls[0].name, "query_tabular_document");
  assert.deepEqual(parsed.toolCalls[0].arguments, {
    path: "orders.csv",
    query: "SELECT COUNT(*) FROM orders",
  });
});

test("does not recover malformed tool_use with an unknown tool name", () => {
  const parsed = parseTextForTools([
    "<tool_use>",
    "<parameter name=\"path\">orders.csv</parameter>",
    "<parameter name=\"tool\">not_a_real_tool</parameter>",
    "</tool_use>",
  ].join("\n"));

  assert.equal(parsed.toolCalls.length, 0);
  assert.equal(parsed.cleanText, "");
});

test("parses bare tool name followed by path and key-value arguments", () => {
  const parsed = parseTextForTools([
    "read_file",
    "/Users/michael/Documents/GitHub/MAIN/src/lib/orchestrator.ts",
    "max_lines=100",
  ].join("\n"));

  assert.equal(parsed.toolCalls.length, 1);
  assert.equal(parsed.toolCalls[0].name, "read_file");
  assert.deepEqual(parsed.toolCalls[0].arguments, {
    path: "/Users/michael/Documents/GitHub/MAIN/src/lib/orchestrator.ts",
    max_lines: 100,
  });
  assert.equal(parsed.cleanText, "");
});

test("strips malformed parameter fragments from visible text", () => {
  const visibleText = sanitizeAIOutput([
    "准备读取文件。",
    "</parametermax_lines\">100",
    "path=src/lib/orchestrator.ts",
  ].join("\n"));

  assert.equal(visibleText, "准备读取文件。");
});

test("parses bare get_project_skeleton as a tool call", () => {
  const parsed = parseTextForTools("get_project_skeleton");

  assert.equal(parsed.toolCalls.length, 1);
  assert.equal(parsed.toolCalls[0].name, "get_project_skeleton");
  assert.deepEqual(parsed.toolCalls[0].arguments, {});
  assert.equal(parsed.cleanText, "");
});
