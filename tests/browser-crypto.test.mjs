import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash as nativeHash} from 'node:crypto';
import {createHash,randomUUID} from '../src/browser-crypto.js';

test('browser SHA-256 matches Node fingerprints including Unicode, multiblock and incremental updates',()=>{
  for (const value of ['', 'abc', '验收内容：成员姓名与 CB-102', 'large input'.repeat(10000)]) {
    assert.equal(createHash('sha256').update(value).digest('hex'),nativeHash('sha256').update(value).digest('hex'));
  }
  const bytes = new TextEncoder().encode('说明');
  assert.equal(createHash('sha256').update('one').update(bytes).update('two').digest('hex'),nativeHash('sha256').update('one').update(bytes).update('two').digest('hex'));
});

test('browser crypto only exposes needed algorithms and ends hash state after digest',()=>{
  assert.throws(()=>createHash('md5'),/只支持 SHA-256/);
  assert.throws(()=>createHash('sha256').update('abc','hex'),/UTF-8/);
  const hash = createHash('sha256').update('abc');
  assert.equal(hash.digest().length,32);
  assert.throws(()=>hash.update('x'),/已结束/);
  assert.throws(()=>hash.digest('hex'),/已结束/);
});

test('browser UUIDs have v4 shape and are independent',()=>{
  const first = randomUUID(), second = randomUUID();
  assert.match(first,/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
  assert.notEqual(first,second);
});
