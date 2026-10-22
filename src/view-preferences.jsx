import React,{useEffect,useMemo,useState} from 'react';
import {Button,Select,Tooltip} from 'antd';
import {SaveOutlined,UndoOutlined} from '@ant-design/icons';
import {useDraftIdentity} from './draft-store.jsx';
import {createViewPreferences,normalizePersonalView} from './view-preferences.js';
import './draft-store.css';
export function usePersonalView({kind,projectId='',projectIds,memberIds}){
 const identity=useDraftIdentity(),scope=useMemo(()=>identity?{accountId:identity.accountId,namespace:identity.namespace,kind,projectId}:null,[identity,kind,projectId]),context={projectIds,memberIds};
 const [error,setError]=useState(''),[values,setValues]=useState(()=>{try{return scope?createViewPreferences(window.localStorage).read(scope,context):normalizePersonalView(kind);}catch{return normalizePersonalView(kind);}}),[saved,setSaved]=useState(null);
 useEffect(()=>{try{const next=scope?createViewPreferences(window.localStorage).read(scope,context):normalizePersonalView(kind);setValues(next);setSaved(next);setError('');}catch{setError('无法读取本浏览器的默认视图，当前筛选仍可使用。');}},[scope]);
 useEffect(()=>{setValues(current=>{const next=normalizePersonalView(kind,current,context);return JSON.stringify(current)===JSON.stringify(next)?current:next;});},[JSON.stringify(projectIds),JSON.stringify(memberIds)]);
 function setField(key,value){setError('');setValues(current=>normalizePersonalView(kind,{...current,[key]:value??''},context));}
 function save(){if(!scope)return;try{const next=createViewPreferences(window.localStorage).save(scope,values,context);setSaved(next);setError('');}catch{setError('默认视图未保存，浏览器存储可能已满或被禁用。');}}
 function reset(){try{if(scope)createViewPreferences(window.localStorage).reset(scope);const next=normalizePersonalView(kind,{},context);setValues(next);setSaved(next);setError('');}catch{setError('未能清除默认视图，请重试。');}}
 return {values,setField,save,reset,error,available:Boolean(scope),changed:JSON.stringify(values)!==JSON.stringify(saved)};
}
export function PersonalViewControls({preference}){return <div className="personal-view-actions"><Tooltip title="按当前账号保存在此浏览器；不保存搜索词、任务详情或通知跳转。"><span>{preference.changed?'当前筛选未设为默认':'本浏览器默认视图'}</span></Tooltip><Button type="text" icon={<SaveOutlined/>} disabled={!preference.available} onClick={preference.save}>保存默认</Button><Button type="text" icon={<UndoOutlined/>} disabled={!preference.available} onClick={preference.reset}>重置视图</Button>{preference.error&&<span className="personal-view-error" role="alert">{preference.error}</span>}</div>;}
export function ViewSortSelect({value,onChange}){return <Select className="personal-view-sort" aria-label="任务排序方式" value={value} onChange={onChange} options={[{value:'due',label:'按截止日期'},{value:'priority',label:'按优先级'},{value:'title',label:'按任务名称'},{value:'updated',label:'最近更新'}]}/>;}
