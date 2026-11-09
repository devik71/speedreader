import test from 'node:test';
import assert from 'node:assert/strict';
import { makeDocument, parseBlocks, activeWord, advanceOne, previousOne, jumpBlock, elapsedWordMs, setWpm, progress } from '../src/reader-core.ts';

test('Parses Markdown headings, paragraphs, lists, code blocks', () => {
  const blocks = parseBlocks('# Привіт\n\nЦе **довга** відповідь.\nЗ двох рядків.\n\n- Перший пункт\n- Другий пункт\n\n```ts\nconsole.log("hi")\n```');
  assert.deepEqual(blocks.map(b => b.kind), ['heading', 'paragraph', 'list', 'list', 'code']);
  assert.equal(blocks[1].text, 'Це довга відповідь. З двох рядків.');
  assert.match(blocks[4].text, /console\.log/);
});

test('Handles Unicode text with punctuation', () => {
  const doc = makeDocument('Привіт, світе! こんにちは、世界。');
  assert.equal(doc.totalWords, 3);
  assert.equal(activeWord(doc), 'Привіт,');
  assert.ok(elapsedWordMs('світе!', 350) > elapsedWordMs('світе', 350));
  assert.ok(elapsedWordMs('світе,', 350) > elapsedWordMs('світе', 350));
});

test('Moves through blocks and never autoplays over a code block', () => {
  const doc = makeDocument('A B\n\n```js\nconst a = 1\n```\n\nC D');
  assert.equal(activeWord(doc), 'A');
  advanceOne(doc);
  assert.equal(activeWord(doc), 'B');
  advanceOne(doc);
  assert.equal(doc.blocks[doc.blockIndex].kind, 'code');
  assert.equal(advanceOne(doc), false);
  jumpBlock(doc, 1);
  assert.equal(activeWord(doc), 'C');
  previousOne(doc);
  assert.equal(doc.blockIndex, 1);
});

test('WPM, bounds, and progress', () => {
  assert.equal(setWpm(99999), 900);
  assert.equal(setWpm(-3), 100);
  assert.equal(setWpm('nope'), 350);
  const doc = makeDocument('one two three');
  assert.equal(progress(doc), 1/3);
  advanceOne(doc);
  assert.equal(progress(doc), 2/3);
});

import { orpIndex, orpParts, seek, isFinished } from '../src/reader-core.ts';

test('Tables drop divider rows; quotes and code languages are kept', () => {
  const blocks = parseBlocks('| a | b |\n|---|:--:|\n| 1 | 2 |\n\n> цитата\n\n```python extra\nx = 1\n```');
  assert.deepEqual(blocks.map(b => b.kind), ['table', 'table', 'quote', 'code']);
  assert.equal(blocks[0].text, 'a · b');
  assert.equal(blocks[2].text, 'цитата');
  assert.equal(blocks[3].lang, 'python');
});

test('A fence with an info string does not close a code block', () => {
  const blocks = parseBlocks('```md\n```js\ninner\n```\n\nafter');
  assert.deepEqual(blocks.map(b => b.kind), ['code', 'paragraph']);
});

test('ORP pivot sits at a fixed column, ignoring leading punctuation', () => {
  assert.equal(orpIndex('a'), 0);
  assert.equal(orpIndex('word'), 1);
  assert.equal(orpIndex('«Привіт»'), 3); // « + 2 letters before the pivot
  for (const w of ['a', 'word', 'швидкочитання', 'こんにちは']) {
    const p = orpParts(w, 8);
    assert.equal([...(p.pad + p.before)].length, 8, w);
    assert.equal(p.before + p.pivot + p.after, w);
  }
});

test('Timing: long words and block ends get extra time; CJK punctuation counts', () => {
  assert.ok(elapsedWordMs('internationalization', 350) > elapsedWordMs('short', 350));
  assert.ok(elapsedWordMs('end', 350, { blockEnd: true }) > elapsedWordMs('end', 350));
  assert.ok(elapsedWordMs('世界。', 350) > elapsedWordMs('世界', 350));
});

test('seek clamps and isFinished detects the last word', () => {
  const doc = makeDocument('a b\n\nc');
  seek(doc, { blockIndex: 99, wordIndex: 99 });
  assert.deepEqual([doc.blockIndex, doc.wordIndex], [1, 0]);
  assert.ok(isFinished(doc));
});
