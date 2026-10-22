import React,{useEffect,useState} from 'react';
import {Alert,Button,Space,Spin} from 'antd';
import {api} from './lib.js';

export function usePlanningCapabilities(projectId){
 const [status,setStatus]=useState(null),[loading,setLoading]=useState(true),[error,setError]=useState(null),[epoch,setEpoch]=useState(0);
 useEffect(()=>{
  let active=true;const controller=new AbortController();setLoading(true);setError(null);setStatus(null);
  api(`/api/ai/capabilities?projectId=${encodeURIComponent(projectId)}`,undefined,{signal:controller.signal}).then(value=>{
   if(typeof value.configured!=='boolean'||typeof value.samplePlanning!=='boolean'||typeof value.canGenerate!=='boolean')throw new Error('模型能力信息不完整，请重试。');
   if(active)setStatus(value);
  }).catch(err=>{if(active&&err.name!=='AbortError')setError(err);}).finally(()=>{if(active)setLoading(false);});
  return()=>{active=false;controller.abort();};
 },[projectId,epoch]);
 return {status,loading,error,enabled:!loading&&!error&&status?.canGenerate===true&&(status.configured||status.samplePlanning),refresh:()=>setEpoch(value=>value+1)};
}

export function PlanningCapabilityNotice({capabilities,onImport,disabled=false}){
 const {status,loading,error,refresh}=capabilities;
 if(loading)return <div style={{marginBottom:16}}><Spin size="small"/><span style={{marginLeft:10,color:'#718171',fontSize:13}}>正在检查此项目的规划能力…</span></div>;
 if(error)return <Alert type="warning" showIcon title="暂时无法确认模型能力" description={<><p>{error.message}。输入内容会保留，暂不发送生成请求。</p><Space wrap><Button size="small" disabled={disabled} onClick={refresh}>重新检查</Button><Button size="small" disabled={disabled} onClick={onImport}>导入外部规划</Button></Space></>}/>;
 if(status?.samplePlanning)return <Alert type="info" showIcon title="内置示例 · 非 AI 生成" description="仅载入本地固定草案，供编辑、核对和确认；不调用模型，也不向外发送项目数据。"/>;
 if(!status?.configured)return <Alert type="warning" showIcon title="尚未配置模型服务" description={<><p>当前仍可手动建立任务与里程碑，或在项目副驾复制上下文给外部 AI，再导入规划。模型配置由工作区部署者维护。</p><Space wrap><Button size="small" disabled={disabled} onClick={onImport}>改用外部规划导入</Button><Button size="small" disabled={disabled} onClick={refresh}>重新检查</Button></Space></>}/>;
 if(!status.canGenerate)return <Alert type="info" showIcon title="当前账号不能生成项目规划" description="规划生成与应用由项目管理员处理；你可以查看已有阶段、分工与交付要求。"/>;
 return null;
}
