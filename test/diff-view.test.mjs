import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDiff, setupDiffView } from '../public/diff-view.js';
import { runDownload } from '../public/run-view.js';

const patch='diff --git a/a.js b/a.js\nindex 1..2 100644\n--- a/a.js\n+++ b/a.js\n@@ -8,2 +8,3 @@\n-old\n+<script>\n+++literal\n context\ndiff --git a/old.bin b/new.bin\nsimilarity index 90%\nrename from old.bin\nrename to new.bin\nBinary files a/old.bin and b/new.bin differ\n';
test('diff files retain metadata, count actual hunk lines and display correct old/new line numbers', () => {
  const files=parseDiff(patch);assert.equal(files.length,2);assert.equal(files[0].path,'a.js');assert.equal(files[0].added,2);assert.equal(files[0].removed,1);
  assert.deepEqual(files[0].rows.filter(row=>row.kind==='add').map(row=>row.newLine),[8,9]);
  const context=files[0].rows.at(-1);assert.equal(context.oldLine,9);assert.equal(context.newLine,10);
  assert.equal(files[1].path,'new.bin');assert.equal(files[1].kind,'重命名 · 二进制');assert.match(files[1].text,/Binary files/);
  assert.equal(files.map(file=>file.text).join(''),patch);
});
test('quoted UTF-8, whitespace paths and deletion patches remain identifiable', () => {
  const files=parseDiff('diff --git "a/\\344\\270\\255\\346\\226\\207.txt" "b/\\344\\270\\255\\346\\226\\207.txt"\ndeleted file mode 100644\n--- "a/\\344\\270\\255\\346\\226\\207.txt"\n+++ /dev/null\n@@ -1 +0,0 @@\n-old\n');
  assert.equal(files[0].path,'中文.txt');assert.equal(files[0].kind,'删除');assert.equal(files[0].removed,1);
  assert.equal(parseDiff('diff --git a/file name.txt b/file name.txt\n--- a/file name.txt\n+++ b/file name.txt\n')[0].path,'file name.txt');
  assert.equal(parseDiff('--- a/unified.txt\n+++ b/unified.txt\n@@ -1 +1 @@\n-a\n+b\n')[0].path,'unified.txt');
});
test('file search and pagination preserve full exports and avoid rebuilding unchanged patches', () => {
  class Element {
    value='';textContent='';dataset={};listeners=new Map();scrollTop=0;scrollLeft=0;writes=0;checked=false;
    classList={toggle(name,value){this[name]=value;}};
    set innerHTML(value){this.html=value;this.writes++;}get innerHTML(){return this.html;}
    addEventListener(type,fn){this.listeners.set(type,fn);}event(type,event={}){this.listeners.get(type)?.(event);}querySelectorAll(){return [];}
  }
  const nodes=new Map(),get=name=>{if(!nodes.has(name))nodes.set(name,new Element());return nodes.get(name);};
  const root={querySelector:selector=>get(selector.slice(11,-1))};
  const view=setupDiffView(root), run={id:'one',diff:patch};view.update(run);
  assert.match(get('lines').innerHTML,/&lt;script&gt;/);assert.doesNotMatch(get('lines').innerHTML,/<script>/);
  const writes=get('lines').writes;get('lines').scrollTop=72;view.update({...run,logs:['new']});assert.equal(get('lines').writes,writes);assert.equal(get('lines').scrollTop,72);
  get('search').value='new.bin';get('search').event('input');assert.equal(get('title').textContent,'new.bin');assert.match(get('lines').innerHTML,/Binary files/);
  assert.equal(runDownload(run,'diff').text,patch);
  get('search').value='missing';get('search').event('input');assert.match(get('lines').innerHTML,/没有匹配/);assert.equal(get('more').hidden,true);
  const large='diff --git a/big b/big\n--- a/big\n+++ b/big\n@@ -0,0 +1,700 @@\n'+Array.from({length:700},(_,i)=>`+line ${i}`).join('\n');
  view.update({id:'two',diff:large});assert.equal(get('search').value,'');assert.equal(get('more').hidden,false);assert.doesNotMatch(get('lines').innerHTML,/line 699/);
  get('more').event('click');assert.match(get('lines').innerHTML,/line 699/);assert.equal(get('more').hidden,true);
  get('wrap').checked=true;get('wrap').event('change');assert.equal(get('lines').classList['is-wrapped'],true);
});
