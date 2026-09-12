import test from 'node:test';
import assert from 'node:assert/strict';
import { renderReport, setupReportView } from '../public/report-view.js';

test('report reading formats headings, lists, tables and code while preserving readable content', () => {
  const html=renderReport('# 审查结果\n\n**先验证** `npm start`\n\n1. 安装工具\n2. 打开页面\n\n| 项目 | 结果 |\n| --- | --- |\n| 启动 | 通过 |\n\n> 保留说明\n\n```js\nconst x = "<section>";\n```');
  assert.match(html,/<h2>审查结果<\/h2>/);assert.match(html,/<strong>先验证<\/strong>/);assert.match(html,/<ol start="1"/);
  assert.match(html,/<td>通过<\/td>/);assert.match(html,/<blockquote>保留说明/);assert.match(html,/&lt;section&gt;/);
  assert.match(renderReport('```text\n未闭合代码块'),/未闭合代码块<\/code><\/pre>/);
});
test('untrusted report content cannot create active HTML, images or non-web links', () => {
  const html=renderReport('<script>alert(1)</script>\n<img src=x onerror=alert(1)>\n\n[x](javascript:alert(1)) ![image](https://example.com/p.png)\n\n[网站](https://example.com/?x="&y=1)\n[凭据](https://user:password@example.com)\n\n```html\n</code><img src=x>\n```');
  assert.doesNotMatch(html,/<script|<img|href="javascript:|href="https:\/\/user:/);
  assert.match(html,/&lt;script&gt;/);assert.match(html,/rel="noopener noreferrer"/);assert.match(html,/referrerpolicy="no-referrer"/);assert.doesNotMatch(html,/href="[^"]*"&/);
});
test('report mode changes preserve exact source and unchanged report DOM across live updates', () => {
  class Element {
    dataset={};attrs={};textContent='';scrollTop=0;writes=0;
    set innerHTML(value){this.html=value;this.writes++;}get innerHTML(){return this.html;}
    setAttribute(name,value){this.attrs[name]=value;}addEventListener(name,fn){this.click=fn;}
  }
  const reading=new Element(),source=new Element(),buttons=['reading','source'].map(mode=>{const node=new Element();node.dataset.reportMode=mode;return node;});
  let saved;
  const root={querySelector:selector=>selector==='[data-report-reading]'?reading:source,querySelectorAll:()=>buttons};
  const controller=setupReportView(root,{saveMode:value=>saved=value});
  const text='# 标题\r\n\n```js\n<raw>\n```';controller.update(text,'a:1');
  assert.equal(source.textContent,text);reading.scrollTop=88;const writes=reading.writes;
  controller.update(text,'a:1');assert.equal(reading.writes,writes);assert.equal(reading.scrollTop,88);
  buttons[1].click();assert.equal(saved,'source');assert.equal(reading.hidden,true);assert.equal(source.hidden,false);
  buttons[0].click();assert.equal(reading.scrollTop,88);assert.equal(reading.writes,writes);
  controller.update('new report','a:2');assert.equal(reading.scrollTop,0);assert.equal(source.textContent,'new report');
  controller.update('','b:1');assert.equal(reading.hidden,true);assert.ok(buttons.every(button=>button.disabled));
});
