import test from 'node:test';
import assert from 'node:assert/strict';
import {createDraftStore,draftKey,DRAFT_PREFIX,DRAFT_TTL_MS,sanitizeDraftData} from '../src/draft-store.js';
function memory(){const values=new Map();return {fail:false,get length(){return values.size;},key:index=>[...values.keys()][index]??null,getItem:key=>values.get(key)??null,setItem(key,value){if(this.fail)throw new Error('quota');values.set(key,String(value));},removeItem:key=>values.delete(key)};}
const scope=(extra={})=>({namespace:'formal',accountId:'account-A',projectId:'project-A',taskId:'task-A',form:'discussion',...extra});
test('drafts isolate actual account, project, task, form and demo namespaces while retaining source version',()=>{
 const storage=memory(),store=createDraftStore({storage,now:()=>1000}),session=store.session('account-A');
 store.write(scope(),{body:'需要接收人确认的内容',mentionIds:['m2'],replyTo:'d1'},'old-version',session);
 assert.equal(store.read(scope()).baseVersion,'old-version');
 for(const other of [{accountId:'account-B'},{projectId:'project-B'},{taskId:'task-B'},{form:'progress'},{namespace:'demo'}])assert.equal(store.read(scope(other)),null);
 assert.equal(store.write(scope({accountId:'account-B'}),{body:'wrong account'},2,session),false);
 assert.notEqual(draftKey(scope()),draftKey(scope({namespace:'demo'})));
});
test('draft expires after seven days and malformed local records are discarded',()=>{
 const storage=memory();let time=100;const store=createDraftStore({storage,now:()=>time}),session=store.session('account-A');
 store.write(scope(),{body:'临时输入'},5,session);time+=DRAFT_TTL_MS;assert.equal(store.read(scope()),null);assert.equal(storage.length,0);
 storage.setItem(draftKey(scope()),'{invalid');assert.equal(store.read(scope()),null);assert.equal(storage.length,0);
});
test('logout invalidates already scheduled writes and clears only that account, while project revocation blocks only stale project writers',()=>{
 const storage=memory(),store=createDraftStore({storage}),session=store.session('account-A'),other=store.session('account-B');
 store.write(scope(),{body:'A'},1,session);store.write(scope({accountId:'account-B'}),{body:'B'},1,other);
 store.clearAccount('account-A');assert.equal(store.write(scope(),{body:'late'},1,session),false);assert.equal(store.read(scope()),null);assert.equal(store.read(scope({accountId:'account-B'})).data.body,'B');
 const next=store.session('account-A'),oldScope={...scope(),projectEpoch:store.projectEpoch(scope())};store.write(oldScope,{body:'private'},1,next);store.clearProject(scope());assert.equal(store.write(oldScope,{body:'late after 403'},1,next),false);assert.equal(store.read(scope()),null);
 assert.ok(store.write({...scope(),projectEpoch:store.projectEpoch(scope())},{body:'after a fresh permission check'},2,next));
});
test('only supported text and selections persist; credentials, binary files and previously confirmed comparisons never persist',()=>{
 assert.throws(()=>sanitizeDraftData('login',{password:'no'}));
 const artifact=sanitizeDraftData('artifact',{name:'成果',url:'https://example.test/result',note:'说明',fileNames:['prototype.pdf'],files:[{base64:'binary'}],token:'secret'});
 assert.deepEqual(artifact,{name:'成果',url:'https://example.test/result',note:'说明',fileNames:['prototype.pdf']});
 const ai=sanitizeDraftData('assistance',{request:'整理事实',result:{baseRevision:17,token:'secret',nested:{apiKey:'private',password:'private'},changes:{confirmed:true}},baseRevision:17,brief:'人工编辑周报',edited:true,selected:['a1']});
 assert.equal(ai.result.baseRevision,17);assert.deepEqual(ai.result.nested,{});assert.equal(ai.result.changes,undefined);assert.equal(ai.brief,'人工编辑周报');assert.deepEqual(ai.selected,['a1']);
});
test('storage failure never replaces the previously recoverable draft',()=>{
 const storage=memory(),store=createDraftStore({storage}),session=store.session('account-A');store.write(scope(),{body:'already saved'},1,session);storage.fail=true;
 assert.throws(()=>store.write(scope(),{body:'new unsaved'},2,session),/quota/);assert.equal(store.read(scope()).data.body,'already saved');assert.equal(store.read(scope()).baseVersion,1);
});

test('independent tabs share invalidation generations without invalidating each other just by opening',()=>{
 const storage=memory(),first=createDraftStore({storage}),second=createDraftStore({storage});
 const firstSession=first.session('account-A'),secondSession=second.session('account-A');
 assert.equal(firstSession.epoch,secondSession.epoch);
 const openInSecond={...scope(),accountEpoch:secondSession.epoch,projectEpoch:second.projectEpoch(scope())};
 assert.ok(second.write(openInSecond,{body:'another tab draft'},1,secondSession));
 first.clearAccount('account-A');
 assert.equal(second.isCurrent(openInSecond,secondSession),false);
 assert.equal(second.write(openInSecond,{body:'late timer after logout'},1,secondSession),false);
 assert.equal(second.read(openInSecond),null);
 const loggedInAgain=first.session('account-A');assert.notEqual(loggedInAgain.epoch,secondSession.epoch);
 assert.ok(first.write(scope(),{body:'new verified session'},2,loggedInAgain));
 assert.equal(second.write(openInSecond,{body:'stale cleanup'},1,secondSession),false);
 assert.equal(first.read(scope()).data.body,'new verified session');
});

test('403 project cleanup in one tab blocks another tab while leaving its other project writable',()=>{
 const storage=memory(),first=createDraftStore({storage}),second=createDraftStore({storage}),session=second.session('account-A');
 const oldScope={...scope(),accountEpoch:session.epoch,projectEpoch:second.projectEpoch(scope())};
 second.write(oldScope,{body:'project private'},1,session);first.clearProject(scope());
 assert.equal(second.write(oldScope,{body:'late project cleanup'},1,session),false);
 assert.equal(second.read(oldScope),null);
 assert.ok(second.write(scope({projectId:'project-B'}),{body:'other project'},1,session));
 const reauthorized={...scope(),accountEpoch:session.epoch,projectEpoch:second.projectEpoch(scope())};
 assert.ok(second.write(reauthorized,{body:'fresh permission check'},2,session));
 assert.equal(second.read(reauthorized).data.body,'fresh permission check');
});

test('logout racing between a stale tab check and write cannot restore its draft or overwrite a new login draft',()=>{
 const storage=memory(),first=createDraftStore({storage}),second=createDraftStore({storage}),oldSession=second.session('account-A');
 const setItem=storage.setItem.bind(storage);let raced=false;
 storage.setItem=(key,value)=>{
  if(!raced&&key.startsWith(DRAFT_PREFIX)&&String(value).includes('racing old input')){
   raced=true;first.clearAccount('account-A');
   const newSession=first.session('account-A');first.write(scope(),{body:'new login must survive'},2,newSession);
  }
  setItem(key,value);
 };
 assert.equal(second.write(scope(),{body:'racing old input'},1,oldSession),false);
 assert.equal(first.read(scope()).data.body,'new login must survive');
 assert.equal(Array.from({length:storage.length},(_,index)=>storage.getItem(storage.key(index))).some(raw=>raw.includes('racing old input')),false);
});

test('pre-generation drafts remain recoverable initially but legacy writers cannot resurrect them after invalidation',()=>{
 const storage=memory(),store=createDraftStore({storage,now:()=>1000});
 const legacy={format:1,accountId:'account-A',projectId:'project-A',taskId:'task-A',form:'discussion',baseVersion:4,updatedAt:500,expiresAt:2000,data:{body:'old deployed version'}};
 storage.setItem(draftKey(scope()),JSON.stringify(legacy));assert.equal(store.read(scope()).data.body,'old deployed version');
 store.clearAccount('account-A');storage.setItem(draftKey(scope()),JSON.stringify(legacy));
 assert.equal(store.read(scope()),null);
});
