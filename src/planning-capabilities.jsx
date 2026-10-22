import React,{useEffect,useState} from 'react';
import {Alert,Button,Space,Spin} from 'antd';
import {api} from './lib.js';
import {navigate} from './router.js';

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
 if(!status?.configured)return <Alert type="warning" showIcon title="当前没有可用的模型服务" description={<><p>可到个人设置配置自己的 DeepSeek 服务，或联系工作区管理员开通平台服务。当前仍可手动建立任务与里程碑，或导入外部规划。</p><Space wrap><Button size="small" disabled={disabled} onClick={()=>navigate('/account')}>个人模型设置</Button><Button size="small" disabled={disabled} onClick={onImport}>导入外部规划</Button><Button size="small" disabled={disabled} onClick={refresh}>重新检查</Button></Space></>}/>;
 if(!status.canGenerate)return <Alert type="info" showIcon title="当前账号暂不能生成项目规划" description={<><p>请在个人设置检查模型来源或联系管理员开通；规划生成与应用还需要本项目的管理权限。</p><Button size="small" disabled={disabled} onClick={()=>navigate('/account')}>打开个人设置</Button></>}/>;
 return null;
}
