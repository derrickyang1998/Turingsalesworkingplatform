'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..', '..', '..');
const appPath = path.join(repoRoot, 'platform', 'app.js');
const browserSpecPath = path.join(__dirname, 'browser-baseline.spec.js');
const appSource = fs.readFileSync(appPath, 'utf8');
const browserSpecSource = fs.readFileSync(browserSpecPath, 'utf8');

function extractFunctionBody(source, name) {
  const declaration = new RegExp(`function\\s+${name}\\s*\\([^)]*\\)\\s*\\{`, 'g');
  const match = declaration.exec(source);
  assert.ok(match, `${name} must exist`);

  const openingBrace = source.indexOf('{', match.index);
  let depth = 0;
  let quote = null;
  let lineComment = false;
  let blockComment = false;
  let escaped = false;

  for (let index = openingBrace; index < source.length; index += 1) {
    const char = source[index];
    const next = source[index + 1];

    if (lineComment) {
      if (char === '\n') lineComment = false;
      continue;
    }
    if (blockComment) {
      if (char === '*' && next === '/') {
        blockComment = false;
        index += 1;
      }
      continue;
    }
    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === quote) {
        quote = null;
      }
      continue;
    }
    if (char === '/' && next === '/') {
      lineComment = true;
      index += 1;
      continue;
    }
    if (char === '/' && next === '*') {
      blockComment = true;
      index += 1;
      continue;
    }
    if (char === '\'' || char === '"' || char === '`') {
      quote = char;
      continue;
    }
    if (char === '{') depth += 1;
    if (char === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(openingBrace + 1, index);
    }
  }

  assert.fail(`${name} must have a balanced function body`);
}

function countMatches(source, pattern) {
  return (source.match(pattern) || []).length;
}

test('Task 11 defines one guarded workflow designer binding lifecycle', () => {
  const state = appSource.match(/var wfState = \{[\s\S]*?\n\};/);
  assert.ok(state, 'wfState object must exist');
  assert.match(state[0], /designerBindingsBound:\s*false/);
  assert.match(state[0], /draggingNode:\s*null/);

  const initBody = extractFunctionBody(appSource, 'initWorkflowDesigner');
  const canvasCheck = initBody.indexOf("if (!canvas) return;");
  const guardCheck = initBody.indexOf('if (wfState.designerBindingsBound) return;');
  const guardSet = initBody.indexOf('wfState.designerBindingsBound = true;');
  assert.ok(canvasCheck !== -1 && guardCheck > canvasCheck, 'binding guard must run after the canvas exists');
  assert.ok(guardSet > guardCheck, 'binding guard must be set after the early return');
  assert.match(initBody, /document\.addEventListener\('mousemove',\s*wfHandleWorkflowPointerMove\);/);
  assert.match(initBody, /document\.addEventListener\('mouseup',\s*wfHandleWorkflowPointerUp\);/);

  assert.equal(countMatches(appSource, /document\.addEventListener\('mousemove'/g), 1);
  assert.equal(countMatches(appSource, /document\.addEventListener\('mouseup'/g), 1);
  assert.equal(countMatches(appSource, /document\.addEventListener\('keydown'/g), 1);
});

test('Task 11 keeps node rendering free of document listeners and records current drag state', () => {
  const renderBody = extractFunctionBody(appSource, 'wfRenderNode');
  assert.doesNotMatch(renderBody, /document\.addEventListener\(['"](?:mousemove|mouseup)['"]/);
  assert.match(renderBody, /wfState\.draggingNode\s*=\s*\{/);
  assert.match(renderBody, /nodeId:\s*node\.id/);
  assert.match(renderBody, /startX:\s*e\.clientX/);
  assert.match(renderBody, /nodeStartX:\s*node\.x/);
  assert.match(renderBody, /if \(e\.target\.classList\.contains\('wf-anchor'\)\) return;/);
});

test('Task 11 central pointer handlers preserve node dragging and edge connections', () => {
  const moveBody = extractFunctionBody(appSource, 'wfHandleWorkflowPointerMove');
  assert.match(moveBody, /wfState\.draggingNode/);
  assert.match(moveBody, /wfState\.nodes\[n\]\.id === drag\.nodeId/);
  assert.match(moveBody, /Math\.max\(0, drag\.nodeStartX \+ e\.clientX - drag\.startX\)/);
  assert.match(moveBody, /Math\.max\(0, drag\.nodeStartY \+ e\.clientY - drag\.startY\)/);
  assert.match(moveBody, /wfRenderAll\(\);/);
  assert.match(moveBody, /wfState\.connectingFrom/);
  assert.match(moveBody, /line\.setAttribute\('x2'/);

  const upBody = extractFunctionBody(appSource, 'wfHandleWorkflowPointerUp');
  assert.match(upBody, /wfState\.draggingNode = null;/);
  assert.equal(countMatches(upBody, /wfSaveState\(\);/g), 2, 'one save for node drag and one for a new edge');
  assert.match(upBody, /fromNodeId !== toNodeId/);
  assert.match(upBody, /if \(!exists\)/);
  assert.match(upBody, /wfState\.connectingFrom = null;/);

  const initBody = extractFunctionBody(appSource, 'initWorkflowDesigner');
  assert.match(initBody, /e\.key === 'Delete'/);
  assert.match(initBody, /document\.activeElement\.tagName !== 'INPUT'/);
  assert.match(initBody, /e\.ctrlKey && e\.key === 'z'/);
  assert.match(initBody, /e\.ctrlKey && e\.key === 'y'/);
});

test('Task 11 browser contract is non-vacuous and exercises repeated binding effects', () => {
  for (const marker of [
    'Task 11 workflow event binding',
    'installWorkflowListenerAudit',
    'window.__tmWorkflowListenerAudit',
    "dataTransfer.setData('text/plain', 'task')",
    'window.wfRenderAll();',
    'historyLengthAfterDrag',
    "page.keyboard.press('Control+z')",
    "page.keyboard.press('Control+y')"
  ]) {
    assert.ok(browserSpecSource.includes(marker), `browser contract must include ${marker}`);
  }
});
