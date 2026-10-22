import test from 'node:test';
import assert from 'node:assert/strict';
import {createViewPreferences,normalizePersonalView,sortViewTasks} from '../src/view-preferences.js';
function memory(){const values=new Map();return {getItem:key=>values.get(key)??null,setItem:(key,value)=>values.set(key,String(value)),removeItem:key=>values.delete(key)};}
test('personal defaults persist supported filters and sort, never one-time search, task or notification queries',()=>{
 const views=createViewPreferences(memory()),scope={namespace:'formal',accountId:'A',kind:'dashboard'};
 views.save(scope,{mode:'review',projectId:'p1',timeFilter:'week',view:'table',sort:'priority',q:'private search',task:'t1',discussion:'d1'});
 assert.deepEqual(views.read(scope),{mode:'review',projectId:'p1',timeFilter:'week',view:'table',sort:'priority'});
 assert.equal(views.read({...scope,accountId:'B'}).mode,'owned');assert.equal(views.read({...scope,namespace:'demo'}).mode,'owned');
 assert.equal(views.read(scope,{projectIds:['p2']}).projectId,'');
});
test('departed member filters and canceled task scopes are corrected against live accessible identities',()=>{
 const value=normalizePersonalView('tasks',{ownerId:'left-member',scope:'active',status:'canceled',mode:'board',sort:'updated'},{memberIds:['m1']});
 assert.deepEqual(value,{ownerId:'',scope:'active',status:'all',mode:'board',sort:'updated'});
 assert.equal(normalizePersonalView('tasks',{scope:'canceled',status:'doing'}).status,'all');
 const views=createViewPreferences(memory()),scope={namespace:'formal',accountId:'A',kind:'tasks',projectId:'p1'};views.save(scope,value);
 assert.equal(views.read({...scope,projectId:'p2'}).mode,'table');views.reset(scope);assert.equal(views.read(scope).mode,'table');
});
test('saved ordering is deterministic and leaves fetched task snapshots untouched',()=>{
 const items=[{id:'a',code:'T2',priority:'low',due:'2026-10-22',title:'B'},{id:'b',code:'T1',priority:'high',due:'2026-10-24',title:'A'},{id:'c',code:'T3',priority:'medium',title:'C'}];
 assert.deepEqual(sortViewTasks(items,'priority').map(item=>item.id),['b','c','a']);assert.deepEqual(sortViewTasks(items,'due').map(item=>item.id),['a','b','c']);assert.deepEqual(items.map(item=>item.id),['a','b','c']);
});
