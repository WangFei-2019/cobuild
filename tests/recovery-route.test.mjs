import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';

test('recovery tokens leave the address bar, remain in the current page only, and accept a new same-path fragment',async()=>{
 const previous={location:globalThis.location,history:globalThis.history};
 globalThis.location=new URL('https://cobuild.example/verify-email#token=first-mail-token');
 globalThis.history={state:null,replaceState(state,unused,href){this.state=state;globalThis.location=new URL(href,globalThis.location);}};
 try{
  const router=await import('../src/router.js?recovery-route-fixture');
  function read(){let captured;function Probe(){captured=router.useRoute();return null;}renderToStaticMarkup(React.createElement(Probe));return captured;}
  assert.equal(read().token,'first-mail-token');
  assert.equal(globalThis.location.href,'https://cobuild.example/verify-email');
  assert.equal(read().token,'first-mail-token','repeated initialization retains the current in-memory link');
  globalThis.location=new URL('https://cobuild.example/verify-email#token=second-mail-token');
  assert.equal(read().token,'second-mail-token');
  assert.equal(globalThis.location.hash,'');
  globalThis.location=new URL('https://cobuild.example/dashboard');read();
  globalThis.location=new URL('https://cobuild.example/verify-email');
  assert.equal(read().token,null,'leaving the recovery page clears its token');
  globalThis.location=new URL('https://cobuild.example/reset-password?token=query-compatibility&next=%2Fprojects');
  assert.equal(read().token,'query-compatibility');
  assert.equal(globalThis.location.search,'?next=%2Fprojects');
  assert.equal(globalThis.location.href.includes('query-compatibility'),false);
 }finally{
  if(previous.location===undefined)delete globalThis.location;else globalThis.location=previous.location;
  if(previous.history===undefined)delete globalThis.history;else globalThis.history=previous.history;
 }
});
